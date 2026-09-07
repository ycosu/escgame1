const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeTeamState, resolveTeamDay, teamStates } = require('./realtime-server');

const ROLES = ['Shelters', 'State/Local Hubs', 'Regional Hubs', 'Federal Stockpile'];

function createRoleState(inventory = 0, backorders = 0) {
  return {
    inventory,
    backorders,
    incomingShipments: [],
    incomingOrders: [],
    factoryOrders: [],
    history: []
  };
}

function createTeamState(day, shocks = []) {
  return {
    roomKey: 'test_A',
    currentDay: day,
    totalDays: 20,
    isTrial: false,
    dayOrders: Object.fromEntries(ROLES.map(role => [role, 0])),
    roleStates: Object.fromEntries(ROLES.map(role => [role, createRoleState()])),
    gameConfig: {
      totalDays: 20,
      lagTime: 1,
      inventoryPenaltyRate: 0.1,
      backlogPenaltyRate: 0.3,
      teamBacklogPenaltyRate: 0.5,
      replenishmentShockMultiplier: 3,
      shocks
    }
  };
}

test('Shelter backlog cannot decrease without a shipment', () => {
  const state = createTeamState(17);
  state.roleStates.Shelters.backorders = 20;

  resolveTeamDay(state);

  const shelterDay = state.roleStates.Shelters.history.at(-1);
  assert.equal(shelterDay.demand, 4);
  assert.equal(shelterDay.arrived, 0);
  assert.equal(shelterDay.shipped, 0);
  assert.equal(shelterDay.backorders, 24);
});

test('configured flooding demand is applied to Shelters', () => {
  const state = createTeamState(4, [{ round: 4, demand: 12, lagDelta: 1 }]);
  state.roleStates.Shelters.inventory = 20;

  resolveTeamDay(state);

  const shelterDay = state.roleStates.Shelters.history.at(-1);
  assert.equal(shelterDay.demand, 12);
  assert.equal(shelterDay.shipped, 12);
  assert.equal(shelterDay.inventory, 8);
  assert.equal(shelterDay.backorders, 0);
});

test('stale browser state cannot overwrite a server-resolved Shelter balance', () => {
  const teamKey = 'stale-state-test_A';
  const state = createTeamState(17);
  state.roomKey = teamKey;
  state.roleStates.Shelters.backorders = 20;
  resolveTeamDay(state);
  teamStates.set(teamKey, state);

  const merged = mergeTeamState(teamKey, {
    ...state,
    roleStates: {
      Shelters: {
        ...state.roleStates.Shelters,
        inventory: 8,
        backorders: 4,
        history: []
      }
    }
  });

  assert.equal(merged.roleStates.Shelters.inventory, 0);
  assert.equal(merged.roleStates.Shelters.backorders, 24);
  assert.equal(merged.roleStates.Shelters.history.length, 1);
  teamStates.delete(teamKey);
});
