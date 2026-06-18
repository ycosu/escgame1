# 🚨 Emergency Supply Chain - Multiplayer Setup

## Quick Start (Local)

### Option 1: Run on Your Computer
```bash
cd multiplayer-setup
npm install
npm start
```

Then open **multiple browser windows/tabs** and visit:
```
http://localhost:3001/beer_game.html
```

All players on the same computer can now play multiplayer together!

---

## Multiplayer URLs

### Local Network (Same Network)
If players are on the **same WiFi/LAN**:
1. Find your computer's IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. Share this URL with teammates:
   ```
   http://[YOUR_IP]:3001/beer_game.html
   ```

### Cloud Deployment (Recommended for Production)
For players **anywhere on the internet**, deploy to Render:
1. See [DEPLOY_RENDER.md](DEPLOY_RENDER.md)
2. After deployment, you'll get a public URL like:
   ```
   https://emergency-supply-chain-realtime.onrender.com/beer_game.html
   ```

---

## File Structure

```
multiplayer-setup/
├── beer_game.html        → Frontend UI (HTML/CSS/JavaScript)
├── realtime-server.js    → Backend server (Node.js + Socket.IO)
├── package.json          → Dependencies
├── render.yaml           → Deployment config (Render)
└── SETUP_INSTRUCTIONS.md → This file
```

---

## How to Play Multiplayer

### Step 1: Start the Server
```bash
npm start
```

### Step 2: Open Game in 2-4 Browser Windows
- Visit `http://localhost:3001/beer_game.html`
- Click **"🎮 Play Game"**
- Each player:
  1. Enter same **Team Number** (1-100)
  2. Enter same **Team Letter** (A-D)
  3. Select different **Role** (End Users, State/Local Hubs, Regional Hubs, or Federal Stockpile)
  4. Click **Start Game**

### Step 3: Play Together!
- See all team members in real-time
- Coordinate orders
- View shared team cost
- Chat with teammates (depends on treatment group)

---

## Key Features

| Feature | Solo | Multiplayer |
|---------|------|------------|
| Works offline | ✅ | ❌ (needs server) |
| Multiple players | ❌ | ✅ |
| Real-time sync | ❌ | ✅ |
| Team chat | ❌ | ✅ (Groups A/C) |
| Visibility rules | ❌ | ✅ (Groups A-D) |

---

## Treatment Groups (Team Letter)

| Letter | Other Roles Visible | Team Chat | Use Case |
|--------|------------------|-----------|----------|
| **A** | ✅ Yes | ✅ Yes | Full collaboration |
| **B** | ✅ Yes | ❌ No | Limited communication |
| **C** | ❌ No | ✅ Yes | High difficulty |
| **D** | ❌ No | ❌ No | Maximum difficulty |

---

## Troubleshooting

### Port 3001 already in use?
```bash
# Change the port
PORT=3002 npm start
# Then visit: http://localhost:3002/beer_game.html
```

### Players can't see each other?
1. Make sure they're on the **same Team Number + Letter**
2. Check they selected **different Roles**
3. Verify server is running (you should see "Realtime server listening on...")

### Can't connect from another computer?
1. Use the computer's local IP (e.g., `http://192.168.1.100:3001`)
2. Ensure both computers are on the same network
3. Check firewall settings (port 3001 must be accessible)

---

## For Production (Cloud Deployment)

See **[DEPLOY_RENDER.md](DEPLOY_RENDER.md)** for:
- Deploying to Render (free cloud hosting)
- Configuring Redis (for distributed play)
- Setting up team synchronization
- Getting your public multiplayer URL

---

## Admin Features

Access the admin console to:
- Configure game duration (days)
- Adjust lead time / lag effects
- Set initial inventory
- Add supply disruptions
- Download results as CSV

**Password**: `admin123` (change before classroom use!)

---

## Need Help?

- **Local play not working?** Check that `npm start` ran successfully
- **Multiplayer sync issues?** Try refreshing the browser
- **Want to deploy?** Follow [DEPLOY_RENDER.md](../DEPLOY_RENDER.md)
