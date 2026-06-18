# 🚀 Quick Start - Running Multiplayer Beer Game

## Prerequisites
- Node.js v14+ installed
- Multiple browser windows/tabs (for testing locally)
- OR multiple computers on same network

## 1. Install Dependencies

```bash
cd multiplayer-setup
npm install
```

## 2. Start the Server

```bash
npm start
```

Expected output:
```
Realtime server listening on http://localhost:3001
GET /api/admin/config → config exists: false
```

Server is now running at: **http://localhost:3001**

## 3. Open the Game

In your browser (open multiple windows):
```
http://localhost:3001/beer_game.html
```

## 4. Create a Team Game

### Player 1:
1. Click "🎮 Play Game"
2. Select:
   - Team Number: **5**
   - Team Letter: **A**
   - Role: **Federal Stockpile**
3. Answer CRT question
4. **Game starts, waiting for teammates...**

### Player 2:
1. Open new browser tab/window
2. Go to: `http://localhost:3001/beer_game.html`
3. Click "🎮 Play Game"
4. Select:
   - Team Number: **5** (SAME as Player 1)
   - Team Letter: **A** (SAME as Player 1)
   - Role: **Regional Hubs** (DIFFERENT role)
5. Answer CRT question
6. **Game starts!**

### Player 3 & 4 (Optional):
Repeat with roles: **State/Local Hubs** and **End Users**

## 5. Playing the Game

**Current Player's Turn:**
- Order input is ENABLED ✓
- Button shows "YOUR TURN"
- Enter order quantity (0-100)
- Click "Submit Order »"

**Other Players:**
- Order input is DISABLED 🔒
- Button shows "✓ Order Submitted - Waiting..."
- Watch team status to see who submitted

**Turn cycles:**
End Users → State/Local Hubs → Regional Hubs → Federal Stockpile → repeat

## 6. Customizing the Game

### Change Game Settings:
1. Click 🔐 **Admin** on start screen
2. Password: `admin123`
3. Edit:
   - Game Days (default 52)
   - Lag Time (default 2 days)
   - Initial Inventory (default 10)
   - Disaster Schedule (round numbers and severity)
4. Click "Save Global Controls"

## 7. View Results

After game ends:
- See 🏆 final costs and rankings
- Download CSV reports
- Check Admin Console for all data

## Troubleshooting

### "Cannot GET /beer_game.html"
- Server not running. Run: `npm start`
- Check URL: Should be `http://localhost:3001` not `http://localhost`

### Players not connecting
- Both need **same Team Number AND Letter**
- Different roles required (can't have 2 Federal Stockpiles)
- Check browser console (F12) for errors

### "Role already taken"
- That role was already claimed
- Choose a different role
- OR join a different team (change Team Number)

### Turn not advancing
- All 4 roles must submit
- Missing a player? They need to join the same team
- With 1-2 players, game waits for other roles indefinitely

## For Testing with 1 Player

You can test with fewer players by:
1. Set up game with your role
2. Test single-player experience
3. Real multiplayer needs 2-4 players on same team

## Running on Multiple Computers

### Setup:
1. Get server's IP: `ipconfig` (Windows) or `ifconfig` (Mac/Linux)
2. On server machine: Run `npm start`
3. On other machines: Visit `http://[SERVER_IP]:3001/beer_game.html`

### Example:
- Server machine IP: `192.168.1.100`
- Other players visit: `http://192.168.1.100:3001/beer_game.html`

All must use same Team Number/Letter combination.

## Stop the Server

Press `Ctrl+C` in terminal

## Full Documentation

See [MULTIPLAYER_GUIDE.md](./MULTIPLAYER_GUIDE.md) for detailed architecture and features.
