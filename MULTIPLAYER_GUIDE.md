# 🎮 Multiplayer Beer Game - Setup & Architecture Guide

## Overview

Your beer game now has **full multiplayer support with real-time synchronization**! Multiple players can join the same team, each taking a different role in the supply chain (End Users, State/Local Hubs, Regional Hubs, Federal Stockpile).

## What's New: Multiplayer Features

### 1. **Turn-Based Coordination**
- Each role takes turns **sequentially**: End Users → State/Local Hubs → Regional Hubs → Federal Stockpile
- The active role can submit orders; other roles are locked out
- UI shows whose turn it is with **"YOUR TURN"** indicator

### 2. **Submission Tracking**
- When a player submits, the backend records it with their role
- All team members see a live ✓ **Submitted** indicator next to completed roles
- The turn automatically advances when **all 4 roles** have submitted

### 3. **Real-Time Updates**
- Socket.IO keeps all players synchronized
- Submission status updates in real-time (every 2 seconds fallback)
- Team roster shows online status of all players
- Chat messages broadcast to entire team (if enabled by treatment)

### 4. **Game State Sharing**
- Each role's inventory, backorders, and costs are shared with the team
- Visibility can be controlled via treatment groups:
  - **Group A & B**: Can see all other tiers
  - **Group C & D**: Can only see their own tier
- Team penalty (End User shortages) affects everyone

## Technical Architecture

### Backend APIs (Express + Socket.IO)

```
POST /api/team/:teamNum/:teamLetter/join
  - Player claims a role on a team
  - Returns roster of all team members
  
GET /api/team/:teamNum/:teamLetter/roster
  - Get current team roster with online status
  
GET /api/team/:teamNum/:teamLetter/submissions
  - Get which roles have submitted this round
  
POST /api/team/:teamNum/:teamLetter/submit
  - Record a player's order submission
  - Broadcasts to other team members
  
POST /api/team/:teamNum/:teamLetter/advance-turn
  - Move to next role's turn (only called when all submitted)
  - Clears submission tracking for new round

Socket.IO Events:
  - team-roster-{roomKey}      : Roster updates (online/offline)
  - team-submission-update     : Someone submitted an order
  - team-turn-advanced         : All submitted, turn advanced
  - room-node:*:teamState      : Game state updates
```

### Frontend State Management

```javascript
game.submittedThisRound      // Has THIS player submitted this round?
game.submittedRoles          // Array of roles that have submitted
game.sharedTeamState         // Current turn and role states
game.teamRoster              // All players on team + online status
```

## How to Run

### 1. Start the Backend Server

```bash
cd multiplayer-setup
npm install  # First time only
npm start
```

Server runs on `http://localhost:3001`

### 2. Open Browser

Visit `http://localhost:3001/beer_game.html` in multiple browser windows/tabs

### 3. Setup Game

Each player:
1. Click **🎮 Play Game**
2. Select **same Team Number** and **Team Letter** (e.g., both select "Team 5-A")
3. Select **different roles** (Federal, Regional, State/Local, End Users)
4. Answer the CRT question
5. Game starts and turn begins!

## Player Experience

### During Your Turn
- Order input field is **ENABLED** ✓
- Submit button is active
- You see "YOUR TURN" indicator

### When Waiting
- Order input field is **DISABLED** 🔒
- Message shows "Waiting for: [Role names]"
- You see other roles' inventory/costs (if treatment allows)
- Submit button shows "✓ Order Submitted - Waiting..."

### Team Status Panel
Shows each team member:
- Online status (green = online, red = offline)
- Whether they've submitted this round
- Whose turn it is now

## Example: 2-Player Game

**Player 1 (Alice - Federal Stockpile)**
- Joins Team 5-A as Federal Stockpile
- Sees "YOUR TURN" - submits order for 20 units
- Order submitted ✓
- Now waits for Regional Hubs to submit

**Player 2 (Bob - Regional Hubs)**
- Joins Team 5-A as Regional Hubs
- Initially locked out (Federal's turn)
- Gets notification when order advances to his role
- Submits order for 15 units
- Turn cycles back to State/Local Hubs...

(Pattern repeats: State/Local → End Users → back to Federal)

## Treatment Groups (Experimental Variations)

Control information visibility and communication:

| Group | See Others | Chat | Effect |
|-------|-----------|------|--------|
| **A** | Yes | Yes | Maximum visibility & communication |
| **B** | Yes | No | Full visibility but isolated |
| **C** | No | Yes | Blindfolded but can communicate |
| **D** | No | No | Complete information isolation |

## Troubleshooting

### ❌ "Role already taken" error
- Another player has that role on this team already
- Choose a different role or join a different team

### ❌ Players not seeing each other
1. Check both are on **same team number AND letter**
2. Verify server is running: `curl http://localhost:3001/health`
3. Check browser console for Socket.IO errors

### ❌ Turn not advancing after submission
1. Check all 4 roles have submitted (look at submission status)
2. If stuck, admin can reset: Admin Console → "Clear Teams"

### ⚠️ Player goes offline but game continues
- Their role shows "Offline" in team status
- Game still waits for that role's submission
- If they reconnect, submission from before is still recorded

## Admin Controls

Access via Admin Console (password: `admin123`):

- **Global Game Controls**: Days, lag time, initial inventory, disaster schedule
- **Clear Teams**: Reset all rosters and states (use if testing)
- **Participant Results**: View all completed games and download data
- **CSV Export**: Download per-person per-round results

## For Researchers

### Data Collection
All data is automatically collected and can be exported as CSV:
- Per-player costs (inventory, backlog, team penalty)
- Order history by round
- CRT responses
- Treatment group assignments
- Chat logs (if applicable)

### Key Metrics
- `totalCost` = inventoryCost + backlogCost + teamPenaltyCost
- `inventoryCost` = inventory × $1/unit/day
- `backlogCost` = backlog × $2/unit/day  
- `teamPenaltyCost` = $3/day when End Users have any backlog

## Redis Support (Multi-Server)

For horizontal scaling with multiple server instances:

```bash
# Set REDIS_URL environment variable
export REDIS_URL=redis://localhost:6379
npm start
```

Redis syncs:
- Team rosters across instances
- Game state updates
- Socket.IO adapter (pub/sub)

## Next Steps

1. **Test with your team**: Have 4 people join same team
2. **Try different treatments**: Run Team A, Team B, etc.
3. **Analyze results**: Use CSV export for statistical analysis
4. **Customize**: Modify shock schedule or cost parameters in Admin Console

---

**Need help?** Check the console (F12) for detailed error messages and Socket.IO connection logs.
