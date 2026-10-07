HEROES OF THE REALM — LIVE D&D PARTY PORTAL v9

This build turns the campaign website into a live collaborative D&D knowledge base.

ROLES

ADMIN / DM
- Full campaign access and DM Vault access.
- Creates accounts and assigns roles.
- Controls which sections and entries players can see.
- Can edit/delete all campaign entries and all party notes.
- Can preview exactly what any Player or Trusted Player sees.

TRUSTED PLAYER
- Can read any sections the Admin grants.
- Can add NPCs, Factions, Locations, Lore, Monsters, Items and Quests.
- Their name is permanently shown on entries they create.
- Can edit/delete only structured entries they personally created.
- Cannot create or edit hidden DM fields such as Secrets or DM Notes.
- Can add and edit their own Party Field Notes on visible entries.

PLAYER
- Can read sections released by the Admin, plus their own linked character page and the Connection Board.
- Can add Party Field Notes to any entry they can see.
- Can edit/delete only their own notes.
- Can edit all player-facing details on their own linked character page. DM Secrets and DM Notes remain protected.
- Cannot modify other DM sourcebook/canon entries.

LIVE UPDATES
The server uses Server-Sent Events (SSE). When somebody adds or edits a note, entry,
character or campaign detail, connected users receive a generic update and fetch their
own filtered campaign data without manually refreshing the page. Reconnecting clients
also refresh their campaign state. Keep one Railway service instance when using the
file-based data store, so the server can reach every connected browser and avoid split
live-update streams.

ATTRIBUTION
Community-created entries show who added them and their role.
Party Field Notes show the author and timestamp.

START LOCALLY
1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run:
       npm start
   or:
       node server.js
4. Visit:
       http://localhost:3000

RAILWAY
This build remains Railway-ready. See RAILWAY_DEPLOY.md.
Mount a Railway Volume at /app/data so logins, notes and campaign edits persist.

DATA
- data/campaign.json: live campaign, party notes, permissions and board.
- data/users.json: accounts and password hashes.
- initial_campaign.json: clean starter campaign copied into a new empty Railway Volume.

BACKUPS
Use the Admin Export button regularly, and back up the Railway Volume when possible.


V9 PLAYER COMPANION
- My Character page linked to each player's PC by the DM.
- My Journal with shared or Personal (player + DM) entries.
- Discoveries separated into Confirmed, Rumour, Theory and Unknown.
- Notes can link to NPCs, monsters, items, locations, factions, lore, quests and sessions.
- Party Members, People We Know, Bestiary, Important Items, Quest Journal, Session Journal and Places We Know pages.
- Live Session mode with rapid Note / Discovery / NPC / Monster / Item capture.
- Trusted Player submissions are marked Player Submitted and enter the DM Review queue.
- DM can Approve as Canon or Keep as Party Knowledge.
- Live updates use the existing Server-Sent Events connection and now filter private/hidden activity server-side.
- Admin can link a login to a Player Character in Admin & Access.
- Players can edit the name, portrait, tags, player-facing fields and public metadata on their own linked Player Character.
- The Connection Board is available to every player; DM-only or selected-player tiles remain filtered by tile permissions.
- Campaign-wide save events now reach players, who fetch their own permission-filtered state automatically.

IMPORTANT
Personal notes are hidden from other players but remain visible to the Admin/DM, so the DM can use player discoveries when preparing session recaps.
