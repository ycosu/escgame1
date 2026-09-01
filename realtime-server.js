const express = require('express');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const PORT = Number(process.env.PORT || 3001);
const REDIS_URL = process.env.REDIS_URL || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(o => o.trim()) }));
app.use(express.static('.'));
app.use(express.json());

// In-memory team rosters: key = "teamNum_teamLetter", value = array of members
const teamRosters = new Map();
const teamStates = new Map();
const allResults = [];

// Merges an incoming per-player team-state publish into the authoritative stored
// state instead of blind-replacing it. This is what lets 4 players' concurrent
// submissions accumulate in `dayOrders` so the "all 4 submitted -> advance day"
// check can actually pass. Used by BOTH the REST /state endpoint and the socket
// set-room-node path so the two channels share one consistent state.
function mergeTeamState(teamKey, incoming) {
  const existing = teamStates.get(teamKey) || {};
  const prevDay = Number(existing.currentDay ?? 0);
  const newDay = Number(incoming.currentDay ?? prevDay);
  const dayAdvanced = newDay > prevDay;

  const merged = {
    ...existing,
    ...incoming,
    roleStates: { ...(existing.roleStates || {}), ...(incoming.roleStates || {}) },
    dayOrders: dayAdvanced
      ? (incoming.dayOrders || {})
      : { ...(existing.dayOrders || {}), ...(incoming.dayOrders || {}) },
    // Never let a lagging client's stale publish roll the day backwards.
    currentDay: Math.max(prevDay, newDay),
    // Preserve submission markers written by the /submit endpoint.
    roleSubmissions: existing.roleSubmissions || incoming.roleSubmissions || {}
  };

  teamStates.set(teamKey, merged);
  return merged;
}

// Create server FIRST so routes can access io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(o => o.trim()),
    methods: ['GET', 'POST']
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'emergency-supply-chain-realtime',
    redis: REDIS_URL ? 'configured' : 'disabled'
  });
});

app.get('/', (_req, res) => {
  res.redirect('/beer_game.html');
});

// API endpoint to get team roster
app.get('/api/team/:teamNum/:teamLetter/roster', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const teamKey = `${teamNum}_${teamLetter}`;
  const roster = teamRosters.get(teamKey) || [];
  res.json({ roster });
});

// API endpoint to join team
app.post('/api/team/:teamNum/:teamLetter/join', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const { playerId, name, role } = req.body;
  
  if (!playerId || !name || !role) {
    return res.status(400).json({ error: 'Missing playerId, name, or role' });
  }
  
  const teamKey = `${teamNum}_${teamLetter}`;
  let roster = teamRosters.get(teamKey) || [];
  
  // Check if role is already taken by another player
  const roleAlreadyTaken = roster.some(m => m.playerId !== playerId && m.role === role);
  if (roleAlreadyTaken) {
    console.log(`❌ Role "${role}" already taken in Team ${teamKey}`);
    return res.status(409).json({ error: `Role "${role}" is already taken in this team. Please choose a different role.` });
  }
  
  // Check if player already exists
  const existing = roster.find(m => m.playerId === playerId);
  if (existing) {
    Object.assign(existing, { name, role, lastSeen: new Date().toISOString(), online: true });
  } else {
    roster.push({
      playerId,
      name,
      role,
      joinedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      online: true
    });
  }
  
  teamRosters.set(teamKey, roster);
  console.log(`✅ Team ${teamKey} has ${roster.length} members:`, roster.map(m => `${m.name} (${m.role})`));
  res.json({ success: true, roster });
  
  // Broadcast roster to the room key clients actually join, plus legacy room/event for compatibility.
  io.to(teamKey).emit(`team-roster-${teamKey}`, roster);
  io.to(`team_${teamNum}_${teamLetter}`).emit('team-roster-updated', { teamNum, teamLetter, roster });
});

// API endpoint to get team state
app.get('/api/team/:teamNum/:teamLetter/state', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const teamKey = `${teamNum}_${teamLetter}`;
  const state = teamStates.get(teamKey);
  console.log(`GET /api/team/${teamNum}/${teamLetter}/state → state exists: ${!!state}`);
  res.json({ state });
});

// API endpoint to record player submission for current round
app.post('/api/team/:teamNum/:teamLetter/submit', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const { role, order, playerId } = req.body;
  
  if (!role || order === undefined || !playerId) {
    return res.status(400).json({ error: 'Missing role, order, or playerId' });
  }
  
  const teamKey = `${teamNum}_${teamLetter}`;
  let state = teamStates.get(teamKey) || { roleSubmissions: {}, currentRound: 0 };
  
  if (!state.roleSubmissions) state.roleSubmissions = {};
  if (!state.dayOrders) state.dayOrders = {};

  const parsedOrder = parseInt(order, 10);
  
  state.roleSubmissions[role] = {
    playerId,
    order: parsedOrder,
    submittedAt: new Date().toISOString()
  };
  state.dayOrders[role] = parsedOrder;
  state.lastSubmittedRole = role;
  state.lastSubmittedAt = new Date().toISOString();
  const requiredRoles = ['End Users', 'State/Local Hubs', 'Regional Hubs', 'Federal Stockpile'];
  const currentDay = Number(state.currentDay || 0);
  const allSubmitted = requiredRoles.every(requiredRole => state.dayOrders[requiredRole] !== undefined && state.dayOrders[requiredRole] !== null);
  const shouldResolve = allSubmitted && state.lastResolvedDay !== currentDay && state.resolvingDay !== currentDay;
  if (shouldResolve) state.resolvingDay = currentDay;

  teamStates.set(teamKey, state);
  console.log(`✅ Team ${teamKey} - ${role} submitted order: ${order}.`);
  res.json({ success: true, submittedRoles: Object.keys(state.roleSubmissions || {}) });
  
  // Broadcast submission update to all clients listening to this team.
  const submissionPayload = {
    teamNum,
    teamLetter,
    role,
    submittedRoles: Object.keys(state.roleSubmissions || {})
  };
  io.to(teamKey).emit('team-submission-update', submissionPayload);
  io.to(`team_${teamNum}_${teamLetter}`).emit('team-submission-update', submissionPayload);
  io.to(teamKey).emit(`room-node:${teamKey}:teamState`, state);

  if (shouldResolve) {
    io.to(teamKey).emit('resolve-team-day', {
      roomKey: teamKey,
      day: currentDay,
      resolverPlayerId: playerId,
      state
    });
  }
});

// API endpoint to get current submission status
app.get('/api/team/:teamNum/:teamLetter/submissions', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const teamKey = `${teamNum}_${teamLetter}`;
  const state = teamStates.get(teamKey) || {};
  const submittedRoles = Object.keys(state.roleSubmissions || {});
  res.json({ submittedRoles });
});

// API endpoint to advance turn one step in the role sequence
app.post('/api/team/:teamNum/:teamLetter/advance-turn', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const { nextTurn, submittedRole, currentDay, totalDays } = req.body;
  
  const teamKey = `${teamNum}_${teamLetter}`;
  let state = teamStates.get(teamKey) || {};
  
  // Each handoff clears submission markers so only the current step is considered active.
  state.roleSubmissions = {};
  state.turnStep = (state.turnStep || 0) + 1;
  state.teamTurn = nextTurn || 'End Users';
  state.lastSubmittedRole = submittedRole || state.lastSubmittedRole || null;
  if (Number.isFinite(Number(currentDay))) {
    state.currentDay = Number(currentDay);
  }
  if (Number.isFinite(Number(totalDays)) && Number(totalDays) > 0) {
    state.totalDays = Number(totalDays);
  }
  state.roundAdvancedAt = new Date().toISOString();
  
  teamStates.set(teamKey, state);
  console.log(`✅ Team ${teamKey} advanced to step ${state.turnStep}, turn: ${state.teamTurn}`);
  res.json({ success: true, nextStep: state.turnStep, teamTurn: state.teamTurn });
  
  // Broadcast turn advancement to all clients.
  const turnPayload = {
    teamNum,
    teamLetter,
    nextStep: state.turnStep,
    teamTurn: state.teamTurn,
    submittedRole: state.lastSubmittedRole || null,
    currentDay: Number(state.currentDay || 0),
    totalDays: Number(state.totalDays || 0)
  };
  io.to(teamKey).emit('team-turn-advanced', turnPayload);
  io.to(`team_${teamNum}_${teamLetter}`).emit('team-turn-advanced', turnPayload);
});

// API endpoint to save team state
app.post('/api/team/:teamNum/:teamLetter/state', (req, res) => {
  const { teamNum, teamLetter } = req.params;
  const incoming = req.body;
  
  if (!incoming) {
    return res.status(400).json({ error: 'Missing state data' });
  }
  
  const teamKey = `${teamNum}_${teamLetter}`;
  const merged = mergeTeamState(teamKey, incoming);

  const dayOrderCount = merged.dayOrders ? Object.keys(merged.dayOrders).length : 0;
  console.log(`✅ Saved state for Team ${teamKey}: Day ${merged.currentDay || 0}, dayOrders submitted: ${dayOrderCount}/4`);
  res.json({ success: true, state: merged });
  
  // Broadcast the MERGED state so every client sees one consistent accumulated
  // set of orders (via both the room key and the legacy team_ channel).
  io.to(`${teamNum}_${teamLetter}`).emit(`room-node:${teamNum}_${teamLetter}:teamState`, merged);
  io.to(`team_${teamNum}_${teamLetter}`).emit('team-state-updated', { teamNum, teamLetter, state: merged });
});

// API endpoint to get global admin config
app.get('/api/admin/config', async (_req, res) => {
  let config = null;
  try {
    config = await getGlobalAdminConfig();
  } catch (err) {
    console.error('Failed to get global admin config:', err);
  }
  console.log(`GET /api/admin/config → config exists: ${!!config}`);
  res.json({ config: config || null });
});

// API endpoint to save global admin config
app.post('/api/admin/config', async (req, res) => {
  const config = req.body;
  
  if (!config) {
    return res.status(400).json({ error: 'Missing config data' });
  }
  
  try {
    await setGlobalAdminConfig(config);
  } catch (err) {
    console.error('Failed to save global admin config:', err);
    return res.status(500).json({ error: 'Failed to save global admin config' });
  }

  console.log(`✅ Saved global admin config:`, { totalDays: config.totalDays, lagTime: config.lagTime, initialInventory: config.initialInventory });
  res.json({ success: true, config });
  
  // Broadcast to all clients
  io.emit('global-admin-config', config);
});

app.get('/api/admin/trial-config', async (_req, res) => {
  if (!globalTrialConfig) globalTrialConfig = await readTrialConfigFromDisk();
  res.json({ config: globalTrialConfig });
});

app.post('/api/admin/trial-config', async (req, res) => {
  const config = req.body;
  if (!config) return res.status(400).json({ error: 'Missing trial config data' });

  const safeConfig = { ...config, shocks: [], shockScheduleText: '' };
  try {
    await writeTrialConfigToDisk(safeConfig);
    globalTrialConfig = safeConfig;
  } catch (err) {
    console.error('Failed to save trial config:', err);
    return res.status(500).json({ error: 'Failed to save trial config' });
  }

  io.emit('global-trial-config', safeConfig);
  res.json({ success: true, config: safeConfig });
});

// Lets the admin panel show whether config will actually survive a redeploy
// (Render Disk writable) instead of silently relying on it.
app.get('/api/admin/persistence-status', async (_req, res) => {
  const diskWritable = await checkDiskPersistence();
  res.json({
    diskWritable,
    diskPath: ADMIN_CONFIG_DIR,
    redisConfigured: !!REDIS_URL,
    redisConnected: !!redisState
  });
});

// API endpoint to get all results
app.get('/api/results', (req, res) => {
  console.log(`GET /api/results → ${allResults.length} results`);
  res.json({ results: allResults });
});

// API endpoint to save a result
app.post('/api/results', async (req, res) => {
  const result = req.body;
  
  if (!result) {
    return res.status(400).json({ error: 'Missing result data' });
  }
  
  allResults.push(result);
  try {
    await writeResultsToDisk(allResults);
  } catch (err) {
    allResults.pop();
    console.error('Failed to persist result to disk:', err);
    return res.status(500).json({ error: 'Failed to persist result data' });
  }
  console.log(`✅ Saved result for ${result.role} in Team ${result.teamNumber}-${result.treatmentGroup}: Total Cost $${result.totalCost}`);
  res.json({ success: true, result, totalResults: allResults.length });
  
  // Broadcast to all clients
  io.emit('result-recorded', { result, totalResults: allResults.length });
});

// Admin endpoint to clear all stored participant results
app.post('/api/admin/clear-results', async (_req, res) => {
  const cleared = allResults.length;
  try {
    await writeResultsToDisk([]);
  } catch (err) {
    console.error('Failed to clear persisted results:', err);
    return res.status(500).json({ error: 'Failed to clear result data' });
  }
  allResults.length = 0;
  console.log(`✅ Cleared ${cleared} stored participant results`);
  io.emit('results-cleared', { cleared });
  res.json({ success: true, cleared });
});

// API endpoint to get chat logs from all active rooms
app.get('/api/chat-logs', (_req, res) => {
  const logs = [];

  rooms.forEach((roomState, roomKey) => {
    const messages = Array.isArray(roomState?.teamChat) ? roomState.teamChat : [];
    messages.forEach((msg) => {
      logs.push({
        roomKey,
        teamName: roomKey,
        sender: msg?.sender || '-',
        text: msg?.text || '',
        timestamp: msg?.timestamp || new Date().toISOString()
      });
    });
  });

  console.log(`GET /api/chat-logs → ${logs.length} messages`);
  res.json({ logs });
});

// Admin endpoint to clear all team rosters and states (seat reset only)
app.post('/api/admin/clear-teams', async (_req, res) => {
  const keys = new Set([
    ...Array.from(teamRosters.keys()),
    ...Array.from(teamStates.keys()),
    ...Array.from(rooms.keys())
  ]);
  const clearedTeams = [];

  try {
    for (const key of keys) {
      await setTeamRoster(key, []);
      teamStates.delete(key);

      const roomState = getRoomState(key);
      roomState.teamState = null;
      roomState.teamTurn = null;
      roomState.teamChat = [];
      await setRoomNode(key, 'teamState', null);
      await setRoomNode(key, 'teamTurn', null);
      await setRoomNode(key, 'teamChat', []);

      // Broadcast reset to current room subscribers and legacy team_<key> listeners.
      io.to(key).emit(`team-roster-${key}`, []);
      io.to(key).emit(`room-node:${key}:teamState`, null);
      io.to(key).emit('team-submission-update', { teamNum: null, teamLetter: null, role: null, submittedRoles: [] });
      io.to(`team_${key}`).emit(`team-roster-${key}`, []);

      clearedTeams.push(key);
    }

    console.log(`✅ Cleared ${clearedTeams.length} team rosters and team states`);
    return res.json({ success: true, cleared: clearedTeams.length, teams: clearedTeams });
  } catch (err) {
    console.error('Failed to clear teams:', err);
    return res.status(500).json({ error: 'Failed to clear teams' });
  }
});

// Other global variables
const rooms = new Map();
let globalAdminConfig = null;
let globalTrialConfig = null;
let redisState = null;
const ROOM_KEY_PREFIX = 'dsc:room:';
const TEAM_ROSTER_PREFIX = 'dsc:roster:';
const GLOBAL_KEY = 'dsc:global:adminConfig';
const ADMIN_CONFIG_DIR = path.join(__dirname, '.persist');
const ADMIN_CONFIG_FILE = path.join(ADMIN_CONFIG_DIR, 'admin-config.json');
const TRIAL_CONFIG_FILE = path.join(ADMIN_CONFIG_DIR, 'trial-config.json');
const RESULTS_FILE = path.join(ADMIN_CONFIG_DIR, 'results.json');
let adminConfigLoadedFromDisk = false;

async function readAdminConfigFromDisk() {
  try {
    const raw = await fs.readFile(ADMIN_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

async function writeAdminConfigToDisk(config) {
  try {
    await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
    if (!config) {
      await fs.rm(ADMIN_CONFIG_FILE, { force: true });
      return;
    }
    await fs.writeFile(ADMIN_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to persist admin config to disk:', err.message);
  }
}

async function readTrialConfigFromDisk() {
  try {
    const raw = await fs.readFile(TRIAL_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_err) {
    return null;
  }
}

async function writeTrialConfigToDisk(config) {
  await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
  await fs.writeFile(TRIAL_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

async function loadResultsFromDisk() {
  try {
    const raw = await fs.readFile(RESULTS_FILE, 'utf8');
    const stored = JSON.parse(raw);
    if (Array.isArray(stored)) allResults.push(...stored);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load results from disk:', err.message);
  }
}

async function writeResultsToDisk(results) {
  await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
  const tempFile = `${RESULTS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(results, null, 2), 'utf8');
  await fs.rename(tempFile, RESULTS_FILE);
}

// Round-trips a small test file through the .persist mount so admins can verify
// (via /api/admin/persistence-status) that the Render Disk actually survives redeploys.
async function checkDiskPersistence() {
  const testFile = path.join(ADMIN_CONFIG_DIR, '.write-test');
  try {
    await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
    const token = String(Date.now());
    await fs.writeFile(testFile, token, 'utf8');
    const readBack = await fs.readFile(testFile, 'utf8');
    return readBack === token;
  } catch (err) {
    console.warn('Disk persistence check failed:', err.message);
    return false;
  }
}

function getRoomState(roomKey) {
  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, {
      teamState: null,
      teamTurn: null,
      teamChat: []
    });
  }
  return rooms.get(roomKey);
}

function getTeamRoster(roomKey) {
  if (!teamRosters.has(roomKey)) {
    teamRosters.set(roomKey, []);
  }
  return teamRosters.get(roomKey);
}

function emitTeamRosterUpdate(roomKey, roster) {
  io.to(roomKey).emit(`team-roster-${roomKey}`, roster);
}

function upsertRosterMember(roomKey, playerData, extras = {}) {
  if (!roomKey || !playerData || !playerData.playerId) return [];

  const roster = getTeamRoster(roomKey);
  const now = new Date().toISOString();
  const existing = roster.find(m => m.playerId === playerData.playerId);

  if (existing) {
    Object.assign(existing, playerData, extras, {
      lastSeen: now,
      online: extras.online !== undefined ? extras.online : true
    });
  } else {
    roster.push({
      ...playerData,
      ...extras,
      joinedAt: extras.joinedAt || now,
      lastSeen: now,
      online: extras.online !== undefined ? extras.online : true
    });
  }

  setTeamRoster(roomKey, roster);
  return roster;
}

function markRosterMemberOffline(roomKey, playerId) {
  if (!roomKey || !playerId) return [];

  const roster = getTeamRoster(roomKey);
  const member = roster.find(m => m.playerId === playerId);
  if (member) {
    member.online = false;
    member.lastSeen = new Date().toISOString();
    setTeamRoster(roomKey, roster);
  }

  return roster;
}

function getRoomRedisKey(roomKey) {
  return `${ROOM_KEY_PREFIX}${roomKey}`;
}

function getTeamRosterRedisKey(roomKey) {
  return `${TEAM_ROSTER_PREFIX}${roomKey}`;
}

async function initRedis() {
  if (!REDIS_URL) {
    console.log('Redis not configured. Running in single-instance memory mode.');
    return;
  }

  try {
    const pubClient = new Redis(REDIS_URL);
    const subClient = pubClient.duplicate();
    redisState = pubClient.duplicate();

    io.adapter(createAdapter(pubClient, subClient));
    console.log('Redis adapter enabled. Realtime works across multiple server instances.');
  } catch (err) {
    console.error('Redis initialization failed. Falling back to memory mode.', err);
    redisState = null;
  }
}

async function setRoomNode(roomKey, nodeName, payload) {
  const roomState = getRoomState(roomKey);
  roomState[nodeName] = payload;

  if (!redisState) return;
  await redisState.hset(getRoomRedisKey(roomKey), nodeName, JSON.stringify(payload));
}

async function getRoomNode(roomKey, nodeName) {
  if (!redisState) {
    const roomState = getRoomState(roomKey);
    return roomState[nodeName];
  }

  const raw = await redisState.hget(getRoomRedisKey(roomKey), nodeName);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

async function setTeamRoster(roomKey, members) {
  const roster = getTeamRoster(roomKey);
  const nextMembers = Array.isArray(members) ? members.map(member => ({ ...member })) : [];
  roster.length = 0;
  roster.push(...nextMembers);

  if (!redisState) return;
  await redisState.set(getTeamRosterRedisKey(roomKey), JSON.stringify(nextMembers));
}

async function loadTeamRosterFromRedis(roomKey) {
  if (!redisState) {
    return getTeamRoster(roomKey) || [];
  }

  const raw = await redisState.get(getTeamRosterRedisKey(roomKey));
  if (!raw) return [];

  try {
    return JSON.parse(raw);
  } catch (_err) {
    return [];
  }
}

async function setGlobalAdminConfig(payload) {
  globalAdminConfig = payload || null;
  await writeAdminConfigToDisk(globalAdminConfig);
  if (!redisState) return;

  if (!globalAdminConfig) {
    await redisState.del(GLOBAL_KEY);
    return;
  }

  await redisState.set(GLOBAL_KEY, JSON.stringify(globalAdminConfig));
}

async function getGlobalAdminConfig() {
  if (!redisState) {
    if (!adminConfigLoadedFromDisk) {
      globalAdminConfig = await readAdminConfigFromDisk();
      adminConfigLoadedFromDisk = true;
    }
    return globalAdminConfig;
  }

  const raw = await redisState.get(GLOBAL_KEY);
  if (!raw) {
    if (!adminConfigLoadedFromDisk) {
      globalAdminConfig = await readAdminConfigFromDisk();
      adminConfigLoadedFromDisk = true;
    }
    return globalAdminConfig;
  }

  try {
    const parsed = JSON.parse(raw);
    globalAdminConfig = parsed;
    adminConfigLoadedFromDisk = true;
    await writeAdminConfigToDisk(globalAdminConfig);
    return parsed;
  } catch (_err) {
    return null;
  }
}

io.on('connection', (socket) => {
  socket.on('join-team-room', ({ room }) => {
    if (!room) return;
    socket.join(room);
    console.log('Socket joined room:', room);
  });

  socket.on('join-room', ({ roomKey, playerData }) => {
    if (!roomKey) return;
    socket.join(roomKey);
    socket.data.roomKey = roomKey;
    socket.data.playerId = playerData?.playerId || null;
    socket.data.playerData = playerData || null;
    
    if (playerData) {
      const roster = upsertRosterMember(roomKey, playerData, { online: true });
      
      // Send current roster back to the player who just joined
      socket.emit(`team-roster-${roomKey}`, roster);
      
      // Broadcast updated roster to ALL players in this room (including the one who just joined)
      emitTeamRosterUpdate(roomKey, roster);
    }
  });

  socket.on('presence-update', ({ roomKey, playerData }) => {
    const activeRoomKey = roomKey || socket.data.roomKey;
    const activePlayerData = playerData || socket.data.playerData;
    if (!activeRoomKey || !activePlayerData?.playerId) return;

    socket.data.roomKey = activeRoomKey;
    socket.data.playerId = activePlayerData.playerId;
    socket.data.playerData = activePlayerData;

    const roster = upsertRosterMember(activeRoomKey, activePlayerData, { online: true });
    emitTeamRosterUpdate(activeRoomKey, roster);
  });

  socket.on('leave-room', ({ roomKey, playerId }) => {
    if (!roomKey) return;
    socket.leave(roomKey);
    
    const roster = markRosterMemberOffline(roomKey, playerId || socket.data.playerId);
    emitTeamRosterUpdate(roomKey, roster);
  });

  socket.on('set-room-node', async ({ roomKey, nodeName, payload }) => {
    if (!roomKey || !nodeName) return;

    // For teamState, merge into the shared authoritative state (same store the
    // REST /state endpoint uses) and broadcast the MERGED result, so every
    // client receives one consistent accumulated set of orders rather than each
    // player's individual partial view. This is what allows the day to advance
    // once all four tiers have submitted.
    let outgoing = payload;
    if (nodeName === 'teamState' && payload && typeof payload === 'object') {
      outgoing = mergeTeamState(roomKey, payload);

      const requiredRoles = ['End Users', 'State/Local Hubs', 'Regional Hubs', 'Federal Stockpile'];
      const submittedRoles = outgoing.dayOrders || {};
      const currentDay = Number(outgoing.currentDay || 0);
      const allSubmitted = requiredRoles.every(role => submittedRoles[role] !== undefined && submittedRoles[role] !== null);

      if (allSubmitted && outgoing.lastResolvedDay !== currentDay && outgoing.resolvingDay !== currentDay) {
        outgoing.resolvingDay = currentDay;
        socket.emit('resolve-team-day', { roomKey, day: currentDay });
      }
    }

    try {
      await setRoomNode(roomKey, nodeName, outgoing);
    } catch (err) {
      console.error('Failed to persist room node:', err);
    }

    io.to(roomKey).emit(`room-node:${roomKey}:${nodeName}`, outgoing);
  });

  socket.on('get-room-node', async ({ roomKey, nodeName }) => {
    if (!roomKey || !nodeName) return;

    let value = null;
    try {
      value = await getRoomNode(roomKey, nodeName);
    } catch (err) {
      console.error('Failed to load room node:', err);
    }

    if (value === undefined || value === null) return;

    socket.emit(`room-node:${roomKey}:${nodeName}`, value);
  });

  socket.on('set-global-admin-config', async (payload) => {
    try {
      await setGlobalAdminConfig(payload);
    } catch (err) {
      console.error('Failed to persist global admin config:', err);
    }

    io.emit('global-admin-config', payload || null);
  });

  socket.on('get-global-admin-config', async () => {
    let value = null;
    try {
      value = await getGlobalAdminConfig();
    } catch (err) {
      console.error('Failed to load global admin config:', err);
    }

    if (!value) return;
    socket.emit('global-admin-config', value);
  });

  socket.on('disconnect', () => {
    const roomKey = socket.data.roomKey;
    const playerId = socket.data.playerId;
    if (!roomKey || !playerId) return;

    const roster = markRosterMemberOffline(roomKey, playerId);
    emitTeamRosterUpdate(roomKey, roster);
  });
});

initRedis()
  .then(async () => {
    try {
      const config = await getGlobalAdminConfig();
      console.log(`Admin config preload: ${config ? 'found persisted config' : 'no persisted config yet'}`);
      await loadResultsFromDisk();
      console.log(`Results preload: ${allResults.length} persisted record(s)`);
    } catch (err) {
      console.warn('Initial admin config preload failed:', err.message);
    }
    const diskOk = await checkDiskPersistence();
    console.log(`Disk persistence check (.persist mount): ${diskOk ? 'OK — survives redeploys' : 'FAILED — attach a Render Disk at ' + ADMIN_CONFIG_DIR}`);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Realtime server listening on http://localhost:${PORT}`);
    });
  });

