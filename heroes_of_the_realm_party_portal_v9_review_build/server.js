const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const USERS_FILE = path.join(DATA, "users.json");
const CAMPAIGN_FILE = path.join(DATA, "campaign.json");
const SEED_FILE = path.join(ROOT, "initial_campaign.json");
fs.mkdirSync(DATA, {recursive:true});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]\n", "utf8");
if (!fs.existsSync(CAMPAIGN_FILE)) {
  if (fs.existsSync(SEED_FILE)) fs.copyFileSync(SEED_FILE, CAMPAIGN_FILE);
  else fs.writeFileSync(CAMPAIGN_FILE, JSON.stringify({version:9,records:[],sessions:[],notes:[],board:{nodes:[],connections:[],maxZ:3},vault:"",settings:{activeSessionId:""}}, null, 2), "utf8");
}

const PORT = Number(process.env.PORT || 3000);
const SESSION_HOURS = 24 * 7;
const SECURE_COOKIE = !!(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
const COOKIE_SECURE = SECURE_COOKIE ? "; Secure" : "";
const sessions = new Map();
const loginAttempts = new Map();
const eventClients = new Set();

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJSON(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
function send(res, status, body, headers={}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8", ...headers});
  res.end(payload);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  });
  return out;
}
function bodyJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => {
      body += c;
      if (body.length > 20_000_000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}
function hashPassword(password, salt=crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 180000, 32, "sha256").toString("hex");
  return {salt, hash};
}
function checkPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) return false;
  const got = crypto.pbkdf2Sync(password, user.salt, 180000, 32, "sha256");
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
function publicUser(u) {
  return {
    id:u.id, username:u.username, displayName:u.displayName || u.username,
    role:u.role || "player", sections:u.sections || [], createdAt:u.createdAt || 0,
    characterId:u.characterId || "", profile:u.profile || {personalGoal:"",characterNote:""}
  };
}
function currentUser(req) {
  const token = parseCookies(req).hr_session;
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const users = readJSON(USERS_FILE, []);
  return users.find(u => u.id === s.userId) || null;
}
function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { send(res, 401, {error:"Not signed in"}); return null; }
  return u;
}
function requireAdmin(req, res) {
  const u = requireUser(req,res);
  if (!u) return null;
  if (u.role !== "admin") { send(res,403,{error:"Admin access required"}); return null; }
  return u;
}
function requireContributor(req,res) {
  const u = requireUser(req,res);
  if (!u) return null;
  if (!['admin','trusted'].includes(u.role)) { send(res,403,{error:"Trusted Player or Admin access required"}); return null; }
  return u;
}
function accessAllows(access, user) {
  if (user.role === "admin") return true;
  const a = access || {mode:"all",users:[]};
  if (a.mode === "admins") return false;
  if (a.mode === "selected") return (a.users || []).includes(user.id);
  return true;
}
const TYPE_VIEW = {pc:"pcs",npc:"npcs",faction:"factions",location:"locations",lore:"lore",monster:"monsters",item:"items",quest:"quests"};
const TRUSTED_TYPES = new Set(["npc","faction","location","lore","monster","item","quest"]);
function sectionAllows(user, view) {
  if (user.role === "admin") return true;
  if (view === "dashboard") return true;
  if (view === "board") return true;
  return (user.sections || []).includes(view);
}
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function newId(prefix="u") { return prefix+"_"+crypto.randomBytes(12).toString("hex"); }
function now(){ return Date.now(); }

function normalizeCampaign(state) {
  const s = clone(state || {});
  s.version = 9;
  s.records = Array.isArray(s.records) ? s.records : [];
  s.sessions = Array.isArray(s.sessions) ? s.sessions : [];
  s.notes = Array.isArray(s.notes) ? s.notes : [];
  s.settings = s.settings && typeof s.settings === "object" ? s.settings : {};
  s.settings.activeSessionId = s.settings.activeSessionId || "";
  s.board = s.board || {nodes:[],connections:[],maxZ:3};
  s.board.nodes = Array.isArray(s.board.nodes) ? s.board.nodes : [];
  s.board.connections = Array.isArray(s.board.connections) ? s.board.connections : [];
  s.vault = typeof s.vault === "string" ? s.vault : "";
  for (const r of s.records) {
    if (!r.access) r.access = {mode:"all",users:[],hiddenFields:["secret","notes"].filter(k=>r.fields && k in r.fields),hiddenMeta:[]};
    if (!r.createdAt) r.createdAt = now();
    if (!r.updatedAt) r.updatedAt = r.createdAt;
    if (!r.reviewStatus) r.reviewStatus = r.createdByRole === "trusted" ? "pending" : "canon";
  }
  for (const sess of s.sessions) {
    if (!sess.access) sess.access = {mode:"all",users:[],hiddenParts:["dm"]};
  }
  for (const n of s.board.nodes) {
    if (!n.access) n.access = {mode:"all",users:[]};
  }
  for (const n of s.notes) {
    n.targetType = n.targetType || (n.recordId ? "record" : "general");
    n.targetId = n.targetId || n.recordId || "";
    n.recordId = n.recordId || (n.targetType === "record" ? n.targetId : "");
    n.kind = n.kind || "note";
    n.visibility = n.visibility || "party";
    n.tags = Array.isArray(n.tags) ? n.tags : [];
    n.linkedRecordIds = Array.isArray(n.linkedRecordIds) ? n.linkedRecordIds : [];
    n.pinned = !!n.pinned;
    n.status = n.status || (n.kind === "discovery" ? "unknown" : "");
    n.sessionId = n.sessionId || (n.targetType === "session" ? n.targetId : "");
    if (!n.createdAt) n.createdAt = now();
    if (!n.updatedAt) n.updatedAt = n.createdAt;
  }
  return s;
}
function recordVisibleToUser(record,user){
  const view = TYPE_VIEW[record.type] || "lore";
  const ownCharacter = record.type === "pc" && record.id === user.characterId;
  return (ownCharacter || sectionAllows(user, view)) && accessAllows(record.access,user);
}
function recordForUser(record,user){
  const x=clone(record);
  if(user.role !== 'admin'){
    const a=x.access||{};
    for(const k of (a.hiddenFields||['secret','notes'])) if(x.fields) delete x.fields[k];
    for(const k of (a.hiddenMeta||[])) if(x.meta) delete x.meta[k];
    delete x.access;
  }
  return x;
}
function noteVisibleToUser(note,user,visibleRecordIds,visibleSessionIds){
  if(user.role === "admin") return true;
  if(note.visibility === "private" && note.authorId !== user.id) return false;
  if(note.targetType === "record" && note.targetId && !visibleRecordIds.has(note.targetId)) return false;
  if(note.recordId && !visibleRecordIds.has(note.recordId)) return false;
  if(note.targetType === "session" && note.targetId && !visibleSessionIds.has(note.targetId)) return false;
  if(note.sessionId && !visibleSessionIds.has(note.sessionId)) return false;
  if(note.access && !accessAllows(note.access,user)) return false;
  return true;
}
function filterStateForUser(source, user) {
  if (user.role === "admin") return clone(source);
  const out = clone(source);
  out.records = (source.records || []).filter(r => recordVisibleToUser(r,user)).map(r=>recordForUser(r,user));
  const visibleRecordIds=new Set(out.records.map(r=>r.id));
  out.sessions = sectionAllows(user,"sessions") ? (source.sessions || []).filter(s => accessAllows(s.access,user)).map(s => {
    const x = clone(s);
    const a = x.access || {};
    for (const k of (a.hiddenParts || ["dm"])) delete x[k];
    delete x.access;
    return x;
  }) : [];
  const visibleSessionIds=new Set(out.sessions.map(s=>s.id));
  out.notes=(source.notes||[]).filter(n=>noteVisibleToUser(n,user,visibleRecordIds,visibleSessionIds)).map(n=>{
    const x=clone(n);
    x.linkedRecordIds=(x.linkedRecordIds||[]).filter(id=>visibleRecordIds.has(id));
    delete x.access;
    return x;
  });
  if (sectionAllows(user,"board")) {
    const nodes = (source.board?.nodes || []).filter(n => accessAllows(n.access,user)).map(n => {
      const x=clone(n); delete x.access; return x;
    });
    const ids = new Set(nodes.map(n=>n.id));
    out.board = {
      nodes,
      connections:(source.board?.connections || []).filter(c => ids.has(c.a) && ids.has(c.b)),
      maxZ:source.board?.maxZ || 3
    };
  } else out.board = {nodes:[],connections:[],maxZ:3};
  out.vault = "";
  return out;
}

function eventVisibleToUser(event,user,state){
  if(user.role === "admin") return true;
  if(event.targetType === "user") return false;
  // Campaign events contain only a generic action. Clients fetch their own filtered state.
  if(event.targetType === "campaign") return true;
  if(event.targetType === "record"){
    const rec=state.records.find(r=>r.id===event.targetId);
    return !!rec && recordVisibleToUser(rec,user);
  }
  if(event.targetType === "note"){
    const note=state.notes.find(n=>n.id===event.targetId);
    if(!note) return false;
    const filtered=filterStateForUser(state,user);
    return filtered.notes.some(n=>n.id===note.id);
  }
  if(event.targetType === "session"){
    const filtered=filterStateForUser(state,user);
    return filtered.sessions.some(s=>s.id===event.targetId);
  }
  return true;
}
function broadcast(event){
  const users=readJSON(USERS_FILE,[]);
  const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
  for(const client of [...eventClients]){
    try{
      const user=users.find(u=>u.id===client.userId);
      if(!user || !eventVisibleToUser(event,user,state)) continue;
      const safeEvent={...event,ts:now()};
      // Never broadcast hidden record/note titles globally. Clients refresh their own filtered state.
      delete safeEvent.recordTitle; delete safeEvent.targetName; delete safeEvent.noteText;
      client.res.write(`data: ${JSON.stringify(safeEvent)}\n\n`);
    }catch{ eventClients.delete(client); }
  }
}
function audit(action,user,target={}){
  broadcast({type:"campaign-update",action,actorId:user.id,actorName:user.displayName||user.username,actorRole:user.role,...target});
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",
    ".css":"text/css; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",
    ".svg":"image/svg+xml",".json":"application/json; charset=utf-8",".ico":"image/x-icon"
  })[ext] || "application/octet-stream";
}
function serveStatic(req,res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/ ,"");
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT)) || file.startsWith(path.resolve(DATA))) {
    res.writeHead(403); return res.end("Forbidden");
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, {"Content-Type":mime(file), "Cache-Control":"no-store"});
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/api/status" && req.method === "GET") {
      const users = readJSON(USERS_FILE, []);
      return send(res,200,{setup:users.some(u=>u.role==="admin")});
    }
    if (p === "/api/setup" && req.method === "POST") {
      const users = readJSON(USERS_FILE, []);
      if (users.some(u=>u.role==="admin")) return send(res,409,{error:"Admin is already configured"});
      const b = await bodyJSON(req);
      if (!b.username || !b.password || String(b.password).length < 8) return send(res,400,{error:"Use a username and a password of at least 8 characters"});
      const hp = hashPassword(String(b.password));
      const admin = {id:newId(),username:String(b.username).trim(),displayName:String(b.displayName||b.username).trim(),role:"admin",sections:[],salt:hp.salt,passwordHash:hp.hash,createdAt:now()};
      writeJSON(USERS_FILE,[admin]);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token,{userId:admin.id,expires:now()+SESSION_HOURS*3600000});
      return send(res,200,{user:publicUser(admin)},{"Set-Cookie":`hr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS*3600}${COOKIE_SECURE}`});
    }
    if (p === "/api/login" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown";
      const a = loginAttempts.get(ip) || {count:0,until:0};
      if (a.until > now()) return send(res,429,{error:"Too many attempts. Try again shortly."});
      const b = await bodyJSON(req);
      const users = readJSON(USERS_FILE, []);
      const u = users.find(x=>x.username.toLowerCase()===String(b.username||"").trim().toLowerCase());
      if (!u || !checkPassword(String(b.password||""),u)) {
        a.count++;
        if (a.count >= 8) { a.until = now()+60000; a.count=0; }
        loginAttempts.set(ip,a);
        return send(res,401,{error:"Incorrect username or password"});
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token,{userId:u.id,expires:now()+SESSION_HOURS*3600000});
      return send(res,200,{user:publicUser(u)},{"Set-Cookie":`hr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS*3600}${COOKIE_SECURE}`});
    }
    if (p === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req).hr_session;
      if (token) sessions.delete(token);
      return send(res,200,{ok:true},{"Set-Cookie":`hr_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE}`});
    }
    if (p === "/api/me" && req.method === "GET") {
      const u=requireUser(req,res); if(!u)return;
      return send(res,200,{user:publicUser(u)});
    }
    if (p === "/api/events" && req.method === "GET") {
      const u=requireUser(req,res); if(!u)return;
      res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
      res.write(`data: ${JSON.stringify({type:"connected",ts:now()})}\n\n`);
      const client={res,userId:u.id}; eventClients.add(client);
      const timer=setInterval(()=>{try{res.write(`: ping ${now()}\n\n`)}catch{}},25000);
      req.on("close",()=>{clearInterval(timer);eventClients.delete(client)});
      return;
    }
    if (p === "/api/state" && req.method === "GET") {
      const u=requireUser(req,res); if(!u)return;
      const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const asUser=url.searchParams.get("asUser");
      if (asUser) {
        if (u.role!=="admin") return send(res,403,{error:"Admin access required"});
        const target=readJSON(USERS_FILE,[]).find(x=>x.id===asUser);
        if(!target) return send(res,404,{error:"Player not found"});
        return send(res,200,{state:filterStateForUser(state,target),previewUser:publicUser(target)});
      }
      return send(res,200,{state:filterStateForUser(state,u)});
    }
    if (p === "/api/state" && req.method === "PUT") {
      const u=requireAdmin(req,res); if(!u)return;
      const b=await bodyJSON(req);
      const state=normalizeCampaign(b.state || b);
      writeJSON(CAMPAIGN_FILE,state);
      audit("updated campaign",u,{targetType:"campaign"});
      return send(res,200,{ok:true});
    }

    if(p === "/api/my-character" && req.method === "PUT"){
      const u=requireUser(req,res); if(!u)return;
      if(!u.characterId) return send(res,400,{error:"No character is linked to this login"});
      const b=await bodyJSON(req), state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const rec=state.records.find(r=>r.id===u.characterId && r.type==="pc");
      if(!rec || !recordVisibleToUser(rec,u)) return send(res,404,{error:"Your character is not available"});
      const access=rec.access||{};
      const hiddenFields=new Set(access.hiddenFields||[]);
      const hiddenMeta=new Set(access.hiddenMeta||[]);
      const allowedFields=["knownFor","appearance","goal","history","relationships","inventory"];
      const allowedMeta=["status","ancestry","role","level","location"];
      rec.fields=rec.fields&&typeof rec.fields==="object"?rec.fields:{};
      rec.meta=rec.meta&&typeof rec.meta==="object"?rec.meta:{};
      for(const key of allowedFields){
        if(!hiddenFields.has(key) && typeof b.fields?.[key]==="string") rec.fields[key]=b.fields[key].slice(0,20000);
      }
      for(const key of allowedMeta){
        if(!hiddenMeta.has(key) && typeof b.meta?.[key]==="string") rec.meta[key]=b.meta[key].slice(0,500);
      }
      if(typeof b.title==="string" && b.title.trim()) rec.title=b.title.trim().slice(0,200);
      if(typeof b.subtitle==="string") rec.subtitle=b.subtitle.trim().slice(0,300);
      if(typeof b.image==="string" && b.image.length<=3_000_000) rec.image=b.image;
      if(Array.isArray(b.tags)) rec.tags=b.tags.map(x=>String(x).trim().slice(0,80)).filter(Boolean).slice(0,30);
      rec.updatedAt=now();
      writeJSON(CAMPAIGN_FILE,state);
      audit("updated their character",u,{targetType:"record",targetId:rec.id,recordType:"pc"});
      return send(res,200,{record:recordForUser(rec,u)});
    }

    // Player Journal / Discoveries: any signed-in player can write notes on visible campaign material.
    if (p === "/api/notes" && req.method === "POST") {
      const u=requireUser(req,res); if(!u)return;
      const b=await bodyJSON(req);
      const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const targetType=["record","session","general"].includes(b.targetType)?b.targetType:(b.recordId?"record":"general");
      const targetId=String(b.targetId||b.recordId||"");
      if(targetType==="record"){
        const record=state.records.find(r=>r.id===targetId);
        if(!record || !recordVisibleToUser(record,u)) return send(res,404,{error:"Record not available"});
      }
      if(targetType==="session"){
        const visible=filterStateForUser(state,u).sessions.some(s=>s.id===targetId);
        if(!visible) return send(res,404,{error:"Session not available"});
      }
      const text=String(b.text||"").trim();
      if(!text) return send(res,400,{error:"Write a note first"});
      const kind=["note","discovery","session-note"].includes(b.kind)?b.kind:"note";
      const visibility=b.visibility==="private"?"private":"party";
      const status=["confirmed","rumour","theory","unknown"].includes(b.status)?b.status:(kind==="discovery"?"unknown":"");
      const linkedRecordIds=Array.isArray(b.linkedRecordIds)?b.linkedRecordIds.filter(id=>{
        const rec=state.records.find(r=>r.id===id); return rec && recordVisibleToUser(rec,u);
      }):[];
      const sessionId=String(b.sessionId||(targetType==="session"?targetId:""));
      if(sessionId && !filterStateForUser(state,u).sessions.some(s=>s.id===sessionId)) return send(res,400,{error:"That session is not available to this account"});
      const note={
        id:newId("note"),targetType,targetId,recordId:targetType==="record"?targetId:"",
        text,title:String(b.title||"").trim(),kind,visibility,status,
        tags:Array.isArray(b.tags)?b.tags.map(String).map(x=>x.trim()).filter(Boolean):[],
        pinned:!!b.pinned,sessionId,linkedRecordIds,
        authorId:u.id,authorName:u.displayName||u.username,authorRole:u.role,
        createdAt:now(),updatedAt:now(),access:{mode:"all",users:[]}
      };
      state.notes.push(note); writeJSON(CAMPAIGN_FILE,state);
      audit(kind==="discovery"?"added a discovery":"added a note",u,{targetType:"note",targetId:note.id});
      return send(res,200,{note});
    }
    const noteMatch=p.match(/^\/api\/notes\/([^/]+)$/);
    if(noteMatch && req.method === "PUT"){
      const u=requireUser(req,res); if(!u)return;
      const b=await bodyJSON(req); const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const n=state.notes.find(x=>x.id===noteMatch[1]); if(!n)return send(res,404,{error:"Note not found"});
      if(u.role!=="admin" && n.authorId!==u.id) return send(res,403,{error:"You can only edit your own notes"});
      const text=String(b.text??n.text??"").trim(); if(!text)return send(res,400,{error:"Note cannot be empty"});
      n.text=text; n.title=String(b.title??n.title??"").trim();
      n.visibility=b.visibility==="private"?"private":(b.visibility==="party"?"party":n.visibility||"party");
      n.kind=["note","discovery","session-note"].includes(b.kind)?b.kind:n.kind||"note";
      n.status=["confirmed","rumour","theory","unknown"].includes(b.status)?b.status:n.status||"";
      n.tags=Array.isArray(b.tags)?b.tags.map(String).map(x=>x.trim()).filter(Boolean):n.tags||[];
      n.pinned=typeof b.pinned==="boolean"?b.pinned:!!n.pinned;
      if(Array.isArray(b.linkedRecordIds)) n.linkedRecordIds=b.linkedRecordIds.filter(id=>state.records.some(r=>r.id===id && recordVisibleToUser(r,u)));
      if(typeof b.sessionId==="string") n.sessionId=b.sessionId;
      n.updatedAt=now();
      writeJSON(CAMPAIGN_FILE,state); audit(n.kind==="discovery"?"edited a discovery":"edited a note",u,{targetType:"note",targetId:n.id});
      return send(res,200,{note:n});
    }
    if(noteMatch && req.method === "DELETE"){
      const u=requireUser(req,res); if(!u)return;
      const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{})); const n=state.notes.find(x=>x.id===noteMatch[1]); if(!n)return send(res,404,{error:"Note not found"});
      if(u.role!=="admin" && n.authorId!==u.id) return send(res,403,{error:"You can only delete your own notes"});
      state.notes=state.notes.filter(x=>x.id!==n.id); writeJSON(CAMPAIGN_FILE,state); audit("deleted a note",u,{targetType:"note",targetId:n.id});
      return send(res,200,{ok:true});
    }

    // Trusted Players can create structured D&D records and edit their own contributions.
    if(p === "/api/records" && req.method === "POST"){
      const u=requireContributor(req,res); if(!u)return;
      const b=await bodyJSON(req); const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const type=String(b.type||"");
      if(u.role!=="admin" && !TRUSTED_TYPES.has(type)) return send(res,403,{error:"Trusted Players cannot create that record type"});
      const title=String(b.title||"").trim(); if(!title)return send(res,400,{error:"Give the entry a title"});
      const rec={id:newId("rec"),type,title,subtitle:String(b.subtitle||"").trim(),image:String(b.image||""),fields:b.fields&&typeof b.fields==="object"?b.fields:{},meta:b.meta&&typeof b.meta==="object"?b.meta:{},tags:Array.isArray(b.tags)?b.tags:[],source:u.role==="admin"?String(b.source||""):"Party Discovery",preset:false,createdAt:now(),updatedAt:now(),createdBy:u.id,createdByName:u.displayName||u.username,createdByRole:u.role,reviewStatus:u.role==="admin"?(["canon","party","pending"].includes(b.reviewStatus)?b.reviewStatus:"canon"):"pending",access:u.role==="admin"&&b.access?b.access:{mode:"all",users:[],hiddenFields:[],hiddenMeta:[]}};
      if(u.role!=="admin"){
        delete rec.fields.secret; delete rec.fields.notes;
      }
      state.records.unshift(rec); writeJSON(CAMPAIGN_FILE,state); audit("added a new entry",u,{targetType:"record",targetId:rec.id,recordType:rec.type,recordTitle:rec.title});
      return send(res,200,{record:recordForUser(rec,u)});
    }
    const recordMatch=p.match(/^\/api\/records\/([^/]+)$/);
    if(recordMatch && req.method === "PUT"){
      const u=requireContributor(req,res); if(!u)return;
      const b=await bodyJSON(req); const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{})); const i=state.records.findIndex(x=>x.id===recordMatch[1]);
      if(i<0)return send(res,404,{error:"Entry not found"}); const old=state.records[i];
      if(u.role!=="admin" && old.createdBy!==u.id) return send(res,403,{error:"Trusted Players can only edit entries they created"});
      const type=String(b.type||old.type);
      if(u.role!=="admin" && !TRUSTED_TYPES.has(type)) return send(res,403,{error:"Trusted Players cannot use that record type"});
      const updated={...old,type,title:String(b.title||old.title).trim(),subtitle:String(b.subtitle??old.subtitle??"").trim(),image:String(b.image??old.image??""),fields:b.fields&&typeof b.fields==="object"?b.fields:old.fields,meta:b.meta&&typeof b.meta==="object"?b.meta:old.meta,tags:Array.isArray(b.tags)?b.tags:old.tags,updatedAt:now()};
      if(u.role==="admin" && b.access) updated.access=b.access;
      if(u.role!=="admin"){
        updated.access=old.access; updated.createdBy=old.createdBy; updated.createdByName=old.createdByName; updated.createdByRole=old.createdByRole; updated.reviewStatus="pending"; delete updated.fields.secret; delete updated.fields.notes;
      }
      state.records[i]=updated; writeJSON(CAMPAIGN_FILE,state); audit("edited an entry",u,{targetType:"record",targetId:updated.id,recordType:updated.type,recordTitle:updated.title});
      return send(res,200,{record:recordForUser(updated,u)});
    }
    if(recordMatch && req.method === "DELETE"){
      const u=requireContributor(req,res); if(!u)return;
      const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{})); const rec=state.records.find(x=>x.id===recordMatch[1]); if(!rec)return send(res,404,{error:"Entry not found"});
      if(u.role!=="admin" && rec.createdBy!==u.id) return send(res,403,{error:"Trusted Players can only delete entries they created"});
      state.records=state.records.filter(x=>x.id!==rec.id); state.notes=state.notes.filter(n=>n.recordId!==rec.id); writeJSON(CAMPAIGN_FILE,state); audit("deleted an entry",u,{targetType:"record",targetId:rec.id,recordTitle:rec.title});
      return send(res,200,{ok:true});
    }


    const reviewMatch=p.match(/^\/api\/records\/([^/]+)\/review$/);
    if(reviewMatch && req.method === "POST"){
      const admin=requireAdmin(req,res); if(!admin)return;
      const b=await bodyJSON(req); const state=normalizeCampaign(readJSON(CAMPAIGN_FILE,{}));
      const rec=state.records.find(x=>x.id===reviewMatch[1]); if(!rec)return send(res,404,{error:"Entry not found"});
      const status=["canon","party","pending"].includes(b.status)?b.status:"pending";
      rec.reviewStatus=status; rec.reviewedBy=admin.id; rec.reviewedByName=admin.displayName||admin.username; rec.reviewedAt=now(); rec.updatedAt=now();
      writeJSON(CAMPAIGN_FILE,state); audit(status==="canon"?"approved an entry as canon":status==="party"?"kept an entry as party knowledge":"returned an entry for review",admin,{targetType:"record",targetId:rec.id});
      return send(res,200,{record:rec});
    }

    if(p === "/api/profile" && req.method === "PUT"){
      const u=requireUser(req,res); if(!u)return;
      const b=await bodyJSON(req), users=readJSON(USERS_FILE,[]);
      const i=users.findIndex(x=>x.id===u.id); if(i<0)return send(res,404,{error:"User not found"});
      users[i].profile=users[i].profile||{};
      if(typeof b.personalGoal==="string") users[i].profile.personalGoal=b.personalGoal.slice(0,2000);
      if(typeof b.characterNote==="string") users[i].profile.characterNote=b.characterNote.slice(0,5000);
      writeJSON(USERS_FILE,users);
      return send(res,200,{user:publicUser(users[i])});
    }

    if (p === "/api/users" && req.method === "GET") {
      const u=requireAdmin(req,res); if(!u)return;
      return send(res,200,{users:readJSON(USERS_FILE,[]).map(publicUser)});
    }
    if (p === "/api/users" && req.method === "POST") {
      const u=requireAdmin(req,res); if(!u)return;
      const b=await bodyJSON(req), users=readJSON(USERS_FILE,[]);
      const username=String(b.username||"").trim();
      if(!username || !b.password || String(b.password).length<8) return send(res,400,{error:"Username and password of at least 8 characters are required"});
      if(users.some(x=>x.username.toLowerCase()===username.toLowerCase())) return send(res,409,{error:"That username already exists"});
      const hp=hashPassword(String(b.password)); const role=["admin","trusted"].includes(b.role)?b.role:"player";
      const user={id:newId(),username,displayName:String(b.displayName||username).trim(),role,sections:Array.isArray(b.sections)?b.sections:[],characterId:String(b.characterId||""),profile:{personalGoal:"",characterNote:""},salt:hp.salt,passwordHash:hp.hash,createdAt:now()};
      users.push(user); writeJSON(USERS_FILE,users); audit("created a login",u,{targetType:"user",targetId:user.id,targetName:user.displayName});
      return send(res,200,{user:publicUser(user)});
    }
    const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === "PUT") {
      const admin=requireAdmin(req,res); if(!admin)return;
      const b=await bodyJSON(req), users=readJSON(USERS_FILE,[]);
      const i=users.findIndex(x=>x.id===userMatch[1]); if(i<0)return send(res,404,{error:"User not found"});
      const username=String(b.username||users[i].username).trim();
      if(users.some((x,j)=>j!==i && x.username.toLowerCase()===username.toLowerCase())) return send(res,409,{error:"That username already exists"});
      users[i].username=username; users[i].displayName=String(b.displayName||username).trim(); users[i].role=["admin","trusted"].includes(b.role)?b.role:"player"; users[i].sections=Array.isArray(b.sections)?b.sections:[]; if(typeof b.characterId==="string")users[i].characterId=b.characterId; users[i].profile=users[i].profile||{personalGoal:"",characterNote:""};
      if(b.password){ if(String(b.password).length<8)return send(res,400,{error:"New password must be at least 8 characters"}); const hp=hashPassword(String(b.password)); users[i].salt=hp.salt; users[i].passwordHash=hp.hash; }
      writeJSON(USERS_FILE,users); audit("updated a login",admin,{targetType:"user",targetId:users[i].id,targetName:users[i].displayName});
      return send(res,200,{user:publicUser(users[i])});
    }
    if (userMatch && req.method === "DELETE") {
      const admin=requireAdmin(req,res); if(!admin)return;
      if(admin.id===userMatch[1]) return send(res,400,{error:"You cannot delete the account you are currently using"});
      let users=readJSON(USERS_FILE,[]); const target=users.find(x=>x.id===userMatch[1]); if(!target)return send(res,404,{error:"User not found"});
      users=users.filter(x=>x.id!==target.id); writeJSON(USERS_FILE,users); for(const [token,s] of sessions){ if(s.userId===target.id)sessions.delete(token); }
      audit("deleted a login",admin,{targetType:"user",targetId:target.id,targetName:target.displayName||target.username});
      return send(res,200,{ok:true});
    }

    if (p.startsWith("/api/")) return send(res,404,{error:"Not found"});
    serveStatic(req,res);
  } catch (err) {
    console.error(err);
    if(!res.headersSent) send(res,500,{error:"Server error"}); else res.end();
  }
});

server.listen(PORT, "0.0.0.0", ()=>console.log(`Heroes of the Realm portal running on port ${PORT}`));
