# 🚨 Emergency Supply Chain - Game Links

## 🎮 Play Now (Local)

### Quick Start
```bash
cd multiplayer-setup
npm install && npm start
```

Then open your browser to:

### 🌐 Local URLs
| Setup | URL |
|-------|-----|
| **Same Computer** | [http://localhost:3001/beer_game.html](http://localhost:3001/beer_game.html) |
| **Different Ports** | `http://localhost:3002/beer_game.html` (set PORT=3002) |

---

## 🌍 Cloud Deployment (Public URL)

To get a shareable public link that works anywhere on the internet:

### 1️⃣ Deploy to Render (Recommended)
Follow [DEPLOY_RENDER.md](DEPLOY_RENDER.md) for:
- Automatic cloud hosting
- Free tier available
- Public URL for all players
- Redis for multiplayer sync

### Example Public URL
```
https://emergency-supply-chain-realtime.onrender.com/beer_game.html
```

---

## 🎯 How to Play

### Solo Mode
1. Open the game URL
2. Click "🎮 Play Game"
3. Enter team info and answer CRT question
4. Play through 52 days alone

### Multiplayer (Same Network)
1. **Find your computer's IP:**
   ```bash
   # Mac/Linux:
   ifconfig
   
   # Windows:
   ipconfig
   ```
2. **Share URL with teammates:**
   ```
   http://YOUR_IP:3001/beer_game.html
   ```
3. All join same team number + letter with different roles

### Multiplayer (Internet/Cloud)
1. Deploy to Render (get public URL)
2. Share the public URL with teammates
3. They open it from anywhere and play!

---

## 🔧 Troubleshooting

**Port 3001 in use?**
```bash
PORT=3002 npm start
# Then use http://localhost:3002
```

**Players can't connect?**
- Check they're using same team number + letter
- Verify they selected different roles
- Make sure server is running

**Want a public URL?**
- Follow the Render deployment guide
- Takes ~5 minutes to set up

---

## 📊 Admin Access

Once game is running, access admin panel:
1. Click "🔐 Admin" button
2. Password: `admin123` (change before class!)
3. Configure game settings, download results, view chat logs

---

## ✅ Ready to Play!

Pick a setup above and have fun! 🍺
