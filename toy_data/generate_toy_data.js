const fs = require('fs');
const path = require('path');

const outDir = __dirname;
const roles = ['End Users', 'State/Local Hubs', 'Regional Hubs', 'Federal Stockpile'];
const roleDefs = [
  { role: 'End Users', prefix: 'endUsers' },
  { role: 'State/Local Hubs', prefix: 'stateLocal' },
  { role: 'Regional Hubs', prefix: 'regional' },
  { role: 'Federal Stockpile', prefix: 'federal' }
];

const settings = {
  totalDays: 12,
  baseLag: 1,
  initialInventory: 12,
  inventoryPenaltyRate: 0.1,
  backlogPenaltyRate: 0.3,
  teamBacklogPenaltyRate: 0.5,
  shocks: [
    { round: 3, lagDelta: 1 },
    { round: 4, lagDelta: 2 },
    { round: 5, lagDelta: 1 },
    { round: 8, lagDelta: 2 },
    { round: 10, lagDelta: 1 }
  ],
  shockScheduleText: '3:1; 4:2; 5:1; 8:2; 10:1'
};

function createRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296);
  };
}

function normalizeQueue(queue, target, fill) {
  const q = Array.isArray(queue) ? queue.slice() : [];
  while (q.length < target) q.push(fill);
  while (q.length > target) q.shift();
  return q;
}

function activeShocks(day) {
  return settings.shocks.filter(s => s.round === day);
}

function lagForDay(day) {
  const delta = activeShocks(day).reduce((sum, s) => sum + Math.max(0, Number(s.lagDelta || 0)), 0);
  return Math.max(1, settings.baseLag + delta);
}

function externalDemand(day) {
  return activeShocks(day).length > 0 ? 8 : 4;
}

function humanOrder(state, incomingDemand, day, rng) {
  const demandBias = incomingDemand;
  const backlogPressure = Math.ceil(state.backorders * 0.7);
  const invGap = Math.max(0, 12 - state.inventory);
  const noise = Math.floor(rng() * 3) - 1; // -1,0,1
  const dayFactor = day <= 2 ? 0 : (day >= 8 ? 1 : 0);
  const order = Math.max(0, demandBias + backlogPressure + Math.ceil(invGap * 0.25) + noise + dayFactor);
  return Math.min(30, order);
}

function buildTeam(teamNumber, treatmentGroup, seedBase) {
  const rng = createRng(seedBase);
  const teamName = `Team ${teamNumber}-${treatmentGroup}`;
  const ts = new Date(Date.UTC(2026, 5, 18, 18, seedBase % 40, 0)).toISOString();

  const states = {};
  roles.forEach(role => {
    states[role] = {
      role,
      inventory: settings.initialInventory,
      backorders: 0,
      incomingOrders: Array(settings.baseLag).fill(0),
      incomingShipments: Array(settings.baseLag).fill(0),
      totalCost: 0,
      inventoryCostTotal: 0,
      backlogCostTotal: 0,
      shortagePenaltyCost: 0,
      history: []
    };
  });

  const participants = roles.map((role, idx) => ({
    timestamp: ts,
    participantId: `P-${teamNumber}${treatmentGroup}-${idx + 1}`,
    name: `${teamName} ${role}`,
    role,
    teamNumber: String(teamNumber),
    treatmentGroup,
    lagTime: settings.baseLag,
    shockScheduleText: settings.shockScheduleText,
    crtAnswer: idx % 2 === 0 ? '0.05' : '0.10',
    crtCorrect: idx % 2 === 0 ? 'true' : 'false'
  }));

  const rows = [];

  for (let day = 1; day <= settings.totalDays; day++) {
    const lagTime = lagForDay(day);
    const updates = {};

    roles.forEach(role => {
      const s = states[role];
      s.incomingOrders = normalizeQueue(s.incomingOrders, lagTime, 0);
      s.incomingShipments = normalizeQueue(s.incomingShipments, lagTime, 0);

      const arrived = Number(s.incomingShipments.shift() || 0);
      const incomingDemand = role === 'End Users'
        ? externalDemand(day)
        : Number(s.incomingOrders.shift() || 0);

      const startInv = Math.max(0, s.inventory) + arrived;
      const totalDemand = incomingDemand + Math.max(0, s.backorders);
      const shipped = Math.min(startInv, totalDemand);
      const endingInv = Math.max(0, startInv - shipped);
      const endingBacklog = Math.max(0, totalDemand - shipped);

      const order = humanOrder({ inventory: endingInv, backorders: endingBacklog }, incomingDemand, day, rng);

      updates[role] = {
        incomingDemand,
        arrived,
        shipped,
        endingInv,
        endingBacklog,
        order
      };
    });

    // Propagate flows after all role updates are prepared.
    roles.forEach(role => {
      const idx = roles.indexOf(role);
      const downstream = idx > 0 ? roles[idx - 1] : null;
      const upstream = idx < roles.length - 1 ? roles[idx + 1] : null;
      const u = updates[role];

      if (downstream) {
        states[downstream].incomingShipments.push(u.shipped);
      }
      if (upstream) {
        states[upstream].incomingOrders.push(u.order);
      } else {
        // Federal gets replenishment from external factory.
        states[role].incomingShipments.push(u.order);
      }
    });

    const endUserBacklog = updates['End Users'].endingBacklog > 0;
    const teamPenaltyDay = endUserBacklog ? settings.teamBacklogPenaltyRate : 0;

    let teamTotalInventory = 0;
    let teamTotalBacklog = 0;
    const snapshots = {};

    roles.forEach(role => {
      const s = states[role];
      const u = updates[role];

      s.inventory = u.endingInv;
      s.backorders = u.endingBacklog;

      const invCost = u.endingInv * settings.inventoryPenaltyRate;
      const backCost = u.endingBacklog * settings.backlogPenaltyRate;
      const totalDay = invCost + backCost + teamPenaltyDay;

      s.inventoryCostTotal += invCost;
      s.backlogCostTotal += backCost;
      s.shortagePenaltyCost += teamPenaltyDay;
      s.totalCost += totalDay;

      const hist = {
        day: day - 1,
        role,
        demand: u.incomingDemand,
        order: u.order,
        inventory: u.endingInv,
        backorders: u.endingBacklog,
        arrived: u.arrived,
        shipped: u.shipped
      };
      s.history.push(hist);

      teamTotalInventory += u.endingInv;
      teamTotalBacklog += u.endingBacklog;
      snapshots[role] = hist;
    });

    const teamInventoryCostDay = teamTotalInventory * settings.inventoryPenaltyRate;
    const teamBacklogCostDay = teamTotalBacklog * settings.backlogPenaltyRate;
    const teamTotalCostDay = teamInventoryCostDay + teamBacklogCostDay + teamPenaltyDay;

    participants.forEach(p => {
      const s = states[p.role];
      const snap = snapshots[p.role];
      const invCost = snap.inventory * settings.inventoryPenaltyRate;
      const backCost = snap.backorders * settings.backlogPenaltyRate;
      const totalCostDay = invCost + backCost + teamPenaltyDay;

      const row = {
        timestamp: p.timestamp,
        participantId: p.participantId,
        name: p.name,
        role: p.role,
        teamNumber: p.teamNumber,
        treatmentGroup: p.treatmentGroup,
        day: day - 1,
        demand: snap.demand,
        order: snap.order,
        inventory: snap.inventory,
        backlog: snap.backorders,
        arrived: snap.arrived,
        shipped: snap.shipped,
        inventoryCostDay: invCost.toFixed(2),
        backlogCostDay: backCost.toFixed(2),
        teamPenaltyDay: teamPenaltyDay.toFixed(2),
        totalCostDay: totalCostDay.toFixed(2),
        teamTotalInventory,
        teamTotalBacklog,
        teamInventoryCostDay: teamInventoryCostDay.toFixed(2),
        teamBacklogCostDay: teamBacklogCostDay.toFixed(2),
        teamTotalCostDay: teamTotalCostDay.toFixed(2),
        lagTime,
        shockScheduleText: settings.shockScheduleText,
        crtAnswer: p.crtAnswer,
        crtCorrect: p.crtCorrect
      };

      roleDefs.forEach(({ role, prefix }) => {
        const r = snapshots[role];
        row[`${prefix}_demand`] = r.demand;
        row[`${prefix}_order`] = r.order;
        row[`${prefix}_inventory`] = r.inventory;
        row[`${prefix}_backlog`] = r.backorders;
        row[`${prefix}_arrived`] = r.arrived;
        row[`${prefix}_shipped`] = r.shipped;
      });

      rows.push(row);
    });
  }

  return { rows, participants, teamName };
}

function toCsv(rows, headers) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(',')];
  rows.forEach(r => {
    lines.push(headers.map(h => esc(r[h])).join(','));
  });
  return lines.join('\n');
}

const teams = [
  buildTeam(1, 'A', 101),
  buildTeam(1, 'B', 202),
  buildTeam(1, 'C', 303),
  buildTeam(1, 'D', 404)
];

const allRows = teams.flatMap(t => t.rows);
const headers = [
  'timestamp','participantId','name','role','teamNumber','treatmentGroup','day','demand','order','inventory','backlog','arrived','shipped','inventoryCostDay','backlogCostDay','teamPenaltyDay','totalCostDay',
  'teamTotalInventory','teamTotalBacklog','teamInventoryCostDay','teamBacklogCostDay','teamPenaltyDay','teamTotalCostDay',
  'lagTime','shockScheduleText','crtAnswer','crtCorrect'
];
roleDefs.forEach(({ prefix }) => {
  headers.push(
    `${prefix}_demand`,
    `${prefix}_order`,
    `${prefix}_inventory`,
    `${prefix}_backlog`,
    `${prefix}_arrived`,
    `${prefix}_shipped`
  );
});

const participantCsv = toCsv(allRows, headers);
fs.writeFileSync(path.join(outDir, 'toy_participant_round_data.csv'), participantCsv, 'utf8');

const chatRows = [
  { teamName: 'Team 1-A', sender: 'Team 1-A End Users', message: 'Demand jumped today, increasing order to 8.', timestamp: '2026-06-18T18:12:00.000Z' },
  { teamName: 'Team 1-A', sender: 'Team 1-A State/Local Hubs', message: 'Copy, seeing higher downstream pull. Keeping safety stock.', timestamp: '2026-06-18T18:12:24.000Z' },
  { teamName: 'Team 1-A', sender: 'Team 1-A Regional Hubs', message: 'Lead time is elevated this round, expect delayed replenishment.', timestamp: '2026-06-18T18:12:47.000Z' },
  { teamName: 'Team 1-C', sender: 'Team 1-C End Users', message: 'Backlog risk. I am ordering above baseline.', timestamp: '2026-06-18T18:25:10.000Z' },
  { teamName: 'Team 1-C', sender: 'Team 1-C Federal Stockpile', message: 'Received. Upstream order increased for next cycle.', timestamp: '2026-06-18T18:25:43.000Z' },
  { teamName: 'Team 1-C', sender: 'Team 1-C Regional Hubs', message: 'Let us smooth orders after shock day if inventory recovers.', timestamp: '2026-06-18T18:26:09.000Z' }
];

const chatCsv = toCsv(chatRows, ['teamName', 'sender', 'message', 'timestamp']);
fs.writeFileSync(path.join(outDir, 'toy_chat_logs.csv'), chatCsv, 'utf8');

console.log('Generated:');
console.log('- toy_participant_round_data.csv');
console.log('- toy_chat_logs.csv');
