# Deploy Heroes of the Realm v9 to Railway

This version supports live party collaboration, Trusted Players and server-side logins.

## 1. Upload to GitHub
Create a private GitHub repository and upload the contents of this folder.

Important files:
- package.json
- server.js
- index.html
- group_logo.png
- initial_campaign.json

## 2. Deploy in Railway
Create a Railway project from the GitHub repository. Railway should detect the Node.js app automatically.

Start command:

`node server.js`

## 3. Add persistent storage
Add a Railway Volume to the service and mount it at exactly:

`/app/data`

This stores:
- Admin / Trusted Player / Player accounts
- password hashes
- campaign entries
- party notes
- permissions
- connection board changes

Without persistent storage, those changes can be lost after a redeploy.
Keep this file-backed deployment to one running service instance. Live update streams are held by the Node.js process, and the JSON store is not designed for multiple app replicas.

## 4. Public domain
Open the Railway service -> Settings -> Networking -> Public Networking -> Generate Domain.

Railway will give you an HTTPS link. Send that one link to the whole party.

## 5. First launch
Open the public URL yourself first and create the initial Admin account.

Then open Admin & Access and create accounts with one of these roles:
- Player: read access + their own shared field notes.
- Trusted Player: Player abilities plus creating NPCs, monsters, items, locations, lore, factions and quests.
- Admin: full DM control.

Every player can open the Connection Board and edit the player-facing fields on their own linked Player Character. DM Secrets and DM Notes stay protected, and individual board tiles still follow their access settings.

## 6. Live updates
No extra service is required. Live updates use Server-Sent Events over the same Node.js service.
When someone adds or edits information, other connected browsers update automatically.

## Updating later
Push the new code to the same GitHub repository. Railway redeploys it while the `/app/data` Volume keeps your campaign and accounts.


## Updating from V8 to V9
Replace the files in the same GitHub repository and push/commit them.
Keep the same Railway Volume mounted at `/app/data`.

The server automatically upgrades the stored campaign structure to V9 in memory and preserves existing records, accounts, notes, permissions, and sessions.
Trusted Player entries gain a review state, and old field notes continue to work.
