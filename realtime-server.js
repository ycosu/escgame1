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
const allTrialResults = [];
let activeStateWriteQueue = Promise.resolve();
let resultWriteQueue = Promise.resolve();

// Merges an incoming per-player team-state publish into the authoritative stored
// state instead of blind-replacing it. This is what lets 4 players' concurrent
// submissions accumulate in `dayOrders` so the "all 4 submitted -> advance day"
// check can actually pass. Used by BOTH the REST /state endpoint and the socket
// set-room-node path so the two channels share one consistent state.
function mergeTeamState(teamKey, incoming) {
  const existing = teamStates.get(teamKey) || {};
  const prevDay = Number(existing.currentDay ?? 0);
  const newDay = Number(incoming.currentDay ?? prevDay);
  if (prevDay > 0 && newDay < prevDay) return existing;
  const dayAdvanced = newDay > prevDay;
  const incomingRoleStates = incoming.roleStates || {};
  const roleStates = { ...(existing.roleStates || {}), ...incomingRoleStates };
  const isTrial = String(teamKey).startsWith('TRIAL');
  const serverConfig = getTeamConfigSnapshot(teamKey);
  const canonicalConfig = existing.gameConfig
    || (isTrial && globalTrialConfig ? serverConfig : incoming.gameConfig)
    || serverConfig;
  const gameConfig = {
    ...serverConfig,
    ...canonicalConfig
  };

  Object.keys(existing.roleStates || {}).forEach(role => {
    const existingRole = existing.roleStates[role] || {};
    const incomingRole = incomingRoleStates[role];
    if (!incomingRole || newDay > prevDay) return;
    roleStates[role] = {
      ...incomingRole,
      inventoryCostTotal: existingRole.inventoryCostTotal,
      backlogCostTotal: existingRole.backlogCostTotal,
      shortagePenaltyCost: existingRole.shortagePenaltyCost,
      totalCost: existingRole.totalCost,
      lastRoundCost: existingRole.lastRoundCost,
      history: existingRole.history
    };
  });

  const merged = {
    ...existing,
    ...incoming,
    roomKey: existing.roomKey || incoming.roomKey || teamKey,
    isTrial,
    gameConfig,
    roleStates,
    dayOrders: dayAdvanced
      ? (incoming.dayOrders || {})
      : { ...(existing.dayOrders || {}), ...(incoming.dayOrders || {}) },
    // Never let a lagging client's stale publish roll the day backwards.
    currentDay: Math.max(prevDay, newDay),
    // Preserve submission markers written by the /submit endpoint.
    roleSubmissions: existing.roleSubmissions || incoming.roleSubmissions || {}
  };

  teamStates.set(teamKey, merged);
  queueActiveStateWrite();
  return merged;
}

const ROLES = ['End Users', 'State/Local Hubs', 'Regional Hubs', 'Federal Stockpile'];
function isHighVisibilityRoom(roomKey) {
  const treatment = String(roomKey || '').split('_').pop().toUpperCase();
  return treatment === 'A' || treatment === 'B';
}

function getTeamConfigSnapshot(roomKey) {
  const trial = String(roomKey || '').startsWith('TRIAL');
  const source = trial ? (globalTrialConfig || {}) : (globalAdminConfig || {});
  return {
    lagTime: 1,
    initialInventory: 12,
    endowment: 25,
    inventoryPenaltyRate: 0.1,
    backlogPenaltyRate: 0.3,
    teamBacklogPenaltyRate: 0.5,
    ...source,
    totalDays: trial ? 5 : Math.max(1, Number(source.totalDays || 20)),
    shocks: trial ? [] : [...(source.shocks || [])],
    shockScheduleText: trial ? '' : (source.shockScheduleText || '')
  };
}

function filterTeamStateForRole(state, role) {
  if (isHighVisibilityRoom(state.roomKey) || !role) return state;
  const roleIndex = ROLES.indexOf(role);
  const downstreamRole = roleIndex > 0 ? ROLES[roleIndex - 1] : null;
  const filteredStates = {};
  if (state.roleStates?.[role]) filteredStates[role] = state.roleStates[role];
  if (downstreamRole && state.roleStates?.[downstreamRole]) {
    filteredStates[downstreamRole] = {
      role: downstreamRole,
      lastDayOrder: state.roleStates[downstreamRole].lastDayOrder
    };
  }
  return {
    roomKey: state.roomKey,
    teamName: state.teamName,
    currentDay: state.currentDay,
    totalDays: state.totalDays,
    isTrial: state.isTrial,
    gameConfig: state.gameConfig,
    lastResolvedDay: state.lastResolvedDay,
    completed: state.completed,
    submittedRoles: Object.keys(state.dayOrders || {}),
    visibilityFiltered: true,
    roleStates: filteredStates
  };
}

function broadcastTeamState(roomKey, state) {
  const sockets = io.sockets.adapter.rooms.get(roomKey);
  if (!sockets) return;
  for (const socketId of sockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;
    const role = socket.data.playerData?.role;
    socket.emit(`room-node:${roomKey}:teamState`, filterTeamStateForRole(state, role));
  }
}

function resolveTeamDay(state) {
  const day = Number(state.currentDay || 1);
  const config = state.gameConfig || getTeamConfigSnapshot(state.roomKey);
  const finalDay = Math.max(1, Number(config.totalDays || state.totalDays || 20));
  state.gameConfig = { ...config, totalDays: finalDay };
  state.totalDays = finalDay;
  const baseLag = Math.max(1, Number(config.lagTime || 1));
  const shocks = state.isTrial ? [] : (Array.isArray(config.shocks) ? config.shocks : []);
  const shockLag = shocks.filter(shock => Number(shock.round) === day).reduce((sum, shock) => sum + Math.max(0, Number(shock.lagDelta || 0)), 0);
  const lag = baseLag + shockLag;
  const roleStates = state.roleStates || {};
  const updates = {};

  ROLES.forEach((role, index) => {
    const roleState = roleStates[role];
    const receive = (queue) => {
      let quantity = 0;
      const remaining = [];
      (Array.isArray(queue) ? queue : []).forEach(entry => {
        const item = entry && typeof entry === 'object' ? entry : { quantity: Number(entry || 0), dueDay: day };
        if (Number(item.dueDay) <= day) quantity += Number(item.quantity || 0);
        else remaining.push(item);
      });
      return { quantity, remaining };
    };
    const shipments = receive(roleState.incomingShipments);
    const information = receive(roleState.incomingOrders);
    const production = receive(roleState.factoryOrders);
    const incomingDemand = index === 0 ? (state.isTrial ? 4 : (shocks.some(shock => Number(shock.round) === day) ? 8 : 4)) : information.quantity;
    const available = Math.max(0, Number(roleState.inventory || 0)) + shipments.quantity + (role === 'Federal Stockpile' ? production.quantity : 0);
    const totalDemand = incomingDemand + Math.max(0, Number(roleState.backorders || 0));
    const shipped = Math.min(available, totalDemand);
    updates[role] = { roleState, shipments, information, production, incomingDemand, shipped, inventory: available - shipped, backlog: totalDemand - shipped, order: Number(state.dayOrders[role] || 0) };
  });

  const teamPenalty = updates['End Users'].backlog > 0 ? Math.max(0, Number(config.teamBacklogPenaltyRate || 0)) : 0;
  // Clear every role's processed arrivals before scheduling new ones. Doing this
  // inside the scheduling loop would overwrite orders queued for a later role.
  ROLES.forEach(role => {
    const update = updates[role];
    update.roleState.incomingShipments = update.shipments.remaining;
    update.roleState.incomingOrders = update.information.remaining;
    update.roleState.factoryOrders = update.production.remaining;
  });
  ROLES.forEach((role, index) => {
    const update = updates[role];
    const roleState = update.roleState;
    const upstream = ROLES[index + 1];
    const downstream = ROLES[index - 1];
    if (downstream) roleStates[downstream].incomingShipments.push({ quantity: update.shipped, dueDay: day + lag });
    if (upstream) roleStates[upstream].incomingOrders.push({ quantity: update.order, dueDay: day + lag });
    else roleState.factoryOrders.push({ quantity: update.order, dueDay: day + (2 * lag) });
    const inventoryCost = update.inventory * Math.max(0, Number(config.inventoryPenaltyRate || 0));
    const backlogCost = update.backlog * Math.max(0, Number(config.backlogPenaltyRate || 0));
    const roundCost = inventoryCost + backlogCost + teamPenalty;
    Object.assign(roleState, { inventory: update.inventory, backorders: update.backlog, demand: update.incomingDemand, receivedDemand: update.incomingDemand, order: 0, pendingOrder: null, lastDayOrder: update.order, lastRoundCost: roundCost });
    roleState.inventoryCostTotal = Number((Number(roleState.inventoryCostTotal || 0) + inventoryCost).toFixed(2));
    roleState.backlogCostTotal = Number((Number(roleState.backlogCostTotal || 0) + backlogCost).toFixed(2));
    roleState.shortagePenaltyCost = Number((Number(roleState.shortagePenaltyCost || 0) + teamPenalty).toFixed(2));
    roleState.totalCost = Number((Number(roleState.totalCost || 0) + roundCost).toFixed(2));
    roleState.history = Array.isArray(roleState.history) ? roleState.history : [];
    roleState.history.push({ day, role, arrived: update.shipments.quantity + (role === 'Federal Stockpile' ? update.production.quantity : 0), demand: update.incomingDemand, receivedDemand: update.incomingDemand, shipped: update.shipped, order: update.order, inventory: update.inventory, backorders: update.backlog, lagTime: lag, shortageDay: teamPenalty ? 1 : 0, roundCost });
  });

  state.lastResolvedDay = day;
  state.dayOrders = {};
  state.roleSubmissions = {};
  state.resolvingDay = null;
  if (day < finalDay) state.currentDay = day + 1;
  else state.completed = true;
  return state;
}

async function persistCompletedTeamResults(state) {
  if (!state.completed || state.serverResultsSaved) return;
  const config = state.gameConfig || globalAdminConfig || {};
  const rosterByRole = new Map((teamRosters.get(state.roomKey) || []).map(member => [member.role, member]));
  const target = state.isTrial ? allTrialResults : allResults;
  const records = ROLES.map((role, index) => {
    const roleState = state.roleStates?.[role] || {};
    const member = rosterByRole.get(role) || {};
    const inventoryCost = Number(roleState.inventoryCostTotal || 0);
    const backorderCost = Number(roleState.backlogCostTotal || 0);
    return {
      rank: index + 1,
      timestamp: state.completedAt,
      participantId: member.playerId || `${state.roomKey}_${role.replace(/\s+/g, '_')}`,
      name: member.name || `${state.teamName || state.roomKey} - ${role}`,
      role,
      teamNumber: state.isTrial
        ? state.roomKey?.split('_')[0] || ''
        : state.roomKey?.split('_')[0] || '',
      treatmentGroup: state.roomKey?.split('_')[1] || '',
      totalDays: state.totalDays,
      inventoryCost: Number(inventoryCost.toFixed(2)),
      backorderCost: Number(backorderCost.toFixed(2)),
      totalCost: Number(Number(roleState.totalCost || (inventoryCost + backorderCost)).toFixed(2)),
      inventoryPenaltyRate: Number(config.inventoryPenaltyRate || 0),
      backlogPenaltyRate: Number(config.backlogPenaltyRate || 0),
      teamBacklogPenaltyRate: Number(config.teamBacklogPenaltyRate || 0),
      lagTime: config.lagTime,
      shockScheduleText: state.isTrial ? '' : (config.shockScheduleText || ''),
      endowment: Number(config.endowment || 0),
      crtAnswer: member.crtAnswer ?? '',
      crtCorrect: member.crtCorrect ?? '',
      isTrial: !!state.isTrial,
      history: Array.isArray(roleState.history) ? roleState.history : []
    };
  });
  target.push(...records);
  try {
    await (state.isTrial ? writeTrialResultsToDisk(target) : writeResultsToDisk(target));
    state.serverResultsSaved = true;
  } catch (err) {
    target.splice(target.length - records.length, records.length);
    throw err;
  }
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
  const { playerId, name, role, crtAnswer, crtCorrect } = req.body;
  
  if (!playerId || !name || !role) {
    return res.status(400).json({ error: 'Missing playerId, name, or role' });
  }
  
  const teamKey = `${teamNum}_${teamLetter}`;
  if (teamStates.get(teamKey)?.completed) {
    return res.status(409).json({ error: 'This team session is complete. Use a different team number and letter.' });
  }
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
    Object.assign(existing, { name, role, crtAnswer, crtCorrect, lastSeen: new Date().toISOString(), online: true });
  } else {
    roster.push({
      playerId,
      name,
      role,
      crtAnswer,
      crtCorrect,
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
  res.json({ state: state ? filterTeamStateForRole(state, req.query.role) : null });
});

// API endpoint to record player submission for current round
app.post('/api/team/:teamNum/:teamLetter/submit', async (req, res) => {
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
  const shouldResolve = allSubmitted && state.lastResolvedDay !== currentDay;
  if (shouldResolve) {
    resolveTeamDay(state);
    if (state.completed) {
      state.completedAt = new Date().toISOString();
      try {
        await persistCompletedTeamResults(state);
      } catch (err) {
        console.error('Failed to persist completed team results:', err);
        return res.status(500).json({ error: 'Failed to persist completed team results' });
      }
    }
  }

  teamStates.set(teamKey, state);
  queueActiveStateWrite();
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
  broadcastTeamState(teamKey, state);
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

  const safeConfig = { ...config, totalDays: 5, shocks: [], shockScheduleText: '' };
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

app.get('/api/trial-results', (_req, res) => {
  res.json({ results: allTrialResults });
});

app.post('/api/trial-results', async (req, res) => {
  const result = req.body;
  if (!result) return res.status(400).json({ error: 'Missing trial result data' });
  allTrialResults.push({ ...result, isTrial: true });
  try {
    await writeTrialResultsToDisk(allTrialResults);
  } catch (err) {
    allTrialResults.pop();
    return res.status(500).json({ error: 'Failed to persist trial result data' });
  }
  res.json({ success: true, totalResults: allTrialResults.length });
});

app.post('/api/admin/clear-trial-results', async (_req, res) => {
  const cleared = allTrialResults.length;
  try {
    await writeTrialResultsToDisk([]);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear trial result data' });
  }
  allTrialResults.length = 0;
  res.json({ success: true, cleared });
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
const TRIAL_RESULTS_FILE = path.join(ADMIN_CONFIG_DIR, 'trial-results.json');
const ACTIVE_TEAMS_FILE = path.join(ADMIN_CONFIG_DIR, 'active-teams.json');
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
  return queueResultsWrite(RESULTS_FILE, results);
}

function queueResultsWrite(filePath, results) {
  resultWriteQueue = resultWriteQueue.then(async () => {
    await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
    const tempFile = `${filePath}.${Date.now()}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(results, null, 2), 'utf8');
    await fs.rename(tempFile, filePath);
  });
  return resultWriteQueue;
}

function queueActiveStateWrite() {
  activeStateWriteQueue = activeStateWriteQueue.then(async () => {
    await fs.mkdir(ADMIN_CONFIG_DIR, { recursive: true });
    const snapshot = {
      teamStates: Array.from(teamStates.entries()),
      teamRosters: Array.from(teamRosters.entries()),
      rooms: Array.from(rooms.entries())
    };
    await fs.writeFile(ACTIVE_TEAMS_FILE, JSON.stringify(snapshot), 'utf8');
  }).catch(err => console.warn('Failed to persist active teams:', err.message));
}

async function loadActiveStateFromDisk() {
  try {
    const snapshot = JSON.parse(await fs.readFile(ACTIVE_TEAMS_FILE, 'utf8'));
    if (Array.isArray(snapshot.teamStates)) snapshot.teamStates.forEach(([key, value]) => teamStates.set(key, value));
    if (Array.isArray(snapshot.teamRosters)) snapshot.teamRosters.forEach(([key, value]) => teamRosters.set(key, value.map(member => ({ ...member, online: false }))));
    if (Array.isArray(snapshot.rooms)) snapshot.rooms.forEach(([key, value]) => rooms.set(key, value));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load active teams:', err.message);
  }
}

async function loadTrialResultsFromDisk() {
  try {
    const stored = JSON.parse(await fs.readFile(TRIAL_RESULTS_FILE, 'utf8'));
    if (Array.isArray(stored)) allTrialResults.push(...stored);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Failed to load trial results from disk:', err.message);
  }
}

async function writeTrialResultsToDisk(results) {
  return queueResultsWrite(TRIAL_RESULTS_FILE, results);
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
  queueActiveStateWrite();

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
  queueActiveStateWrite();

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

    }

    try {
      await setRoomNode(roomKey, nodeName, outgoing);
    } catch (err) {
      console.error('Failed to persist room node:', err);
    }

    if (nodeName === 'teamState') broadcastTeamState(roomKey, outgoing);
    else io.to(roomKey).emit(`room-node:${roomKey}:${nodeName}`, outgoing);
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

    const role = socket.data.playerData?.role;
    socket.emit(`room-node:${roomKey}:${nodeName}`, nodeName === 'teamState' ? filterTeamStateForRole(value, role) : value);
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
      await loadTrialResultsFromDisk();
      await loadActiveStateFromDisk();
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

