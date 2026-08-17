// Tests du phone manager : découverte, rétention avant ajout dans Gladys,
// publication des états, re-queue sur échec, persistance registre + token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhoneManager, MAX_PENDING_STATES_PER_DEVICE } from '../src/phones.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Faux SDK espionné : mêmes formats d'ids que le vrai. */
function fakeGladys({ createdDevices = [] } = {}) {
  const calls = { discovered: [], states: [], getDevices: 0 };
  return {
    calls,
    createdDevices,
    externalIds: (type, platformId) => ({
      device: `ext:tracks:${type}:${platformId}`,
      feature: (key) => `ext:tracks:${type}:${platformId}:${key}`,
    }),
    async publishDiscoveredDevices(devices) {
      calls.discovered.push(devices);
    },
    async publishStates(states) {
      calls.states.push(states);
    },
    async getDevices() {
      calls.getDevices += 1;
      return this.createdDevices.map((externalId) => ({ external_id: externalId }));
    },
  };
}

async function makeManager(gladys, { now } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'phones-test-'));
  const manager = createPhoneManager({ gladys, dataDir, log: silentLog, ...(now ? { now } : {}) });
  await manager.load();
  return { manager, dataDir };
}

const drainEntry = (overrides = {}) => ({
  deviceId: 'abc-123',
  device: { name: 'iPhone de J', model: 'iPhone15,2', platform: 'ios' },
  readings: [
    { sensor: 'battery-level', value: 87, recorded_at: '2026-08-15T10:00:00Z' },
    { sensor: 'battery-charging', value: 1, recorded_at: '2026-08-15T10:00:00Z' },
  ],
  ...overrides,
});

test('a new phone triggers a discovery publication with the full registry', async () => {
  const gladys = fakeGladys();
  const { manager } = await makeManager(gladys);

  await manager.processDrain([drainEntry()]);

  assert.equal(gladys.calls.discovered.length, 1);
  const [devices] = gladys.calls.discovered;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'iPhone de J');
  assert.equal(devices[0].external_id, 'ext:tracks:phone:abc-123');

  // Même meta au drain suivant : pas de re-publication.
  await manager.processDrain([drainEntry({ readings: [] })]);
  assert.equal(gladys.calls.discovered.length, 1);
});

test('states are buffered until the user adds the device in Gladys', async () => {
  const gladys = fakeGladys();
  let clock = Date.now();
  const { manager } = await makeManager(gladys, { now: () => clock });

  await manager.processDrain([drainEntry()]);
  assert.equal(gladys.calls.states.length, 0);

  // L'utilisateur ajoute le device ; le cache getDevices (60 s) expire.
  gladys.createdDevices = ['ext:tracks:phone:abc-123'];
  clock += 120_000;
  await manager.processDrain([
    drainEntry({
      readings: [{ sensor: 'battery-level', value: 86, recorded_at: '2026-08-15T10:15:00Z' }],
    }),
  ]);

  assert.equal(gladys.calls.states.length, 1);
  const published = gladys.calls.states[0];
  assert.equal(published.length, 3);
  assert.deepEqual(published[0], {
    device_feature_external_id: 'ext:tracks:phone:abc-123:battery-level',
    state: 87,
    created_at: '2026-08-15T10:00:00Z',
  });
});

test('unknown sensors are skipped, known ones still published', async () => {
  const gladys = fakeGladys({ createdDevices: ['ext:tracks:phone:abc-123'] });
  const { manager } = await makeManager(gladys);

  await manager.processDrain([
    drainEntry({
      readings: [
        { sensor: 'future-sensor', value: 42, recorded_at: '2026-08-15T10:00:00Z' },
        { sensor: 'battery-level', value: 87, recorded_at: '2026-08-15T10:00:00Z' },
      ],
    }),
  ]);

  assert.equal(gladys.calls.states.length, 1);
  assert.equal(gladys.calls.states[0].length, 1);
  assert.equal(
    gladys.calls.states[0][0].device_feature_external_id,
    'ext:tracks:phone:abc-123:battery-level',
  );
});

test('a publishStates failure requeues without duplicating on retry', async () => {
  const gladys = fakeGladys({ createdDevices: ['ext:tracks:phone:abc-123'] });
  let failNext = true;
  const originalPublish = gladys.publishStates.bind(gladys);
  gladys.publishStates = async (states) => {
    if (failNext) {
      failNext = false;
      throw new Error('host api down');
    }
    return originalPublish(states);
  };
  const { manager } = await makeManager(gladys);

  await manager.processDrain([drainEntry()]);
  assert.equal(gladys.calls.states.length, 0);

  // Tour suivant sans nouveau relevé : le reliquat part, une seule fois.
  await manager.processDrain([]);
  assert.equal(gladys.calls.states.length, 1);
  assert.equal(gladys.calls.states[0].length, 2);

  await manager.processDrain([]);
  assert.equal(gladys.calls.states.length, 1);
});

test('already published (feature, recorded_at) pairs are not re-enqueued', async () => {
  const gladys = fakeGladys({ createdDevices: ['ext:tracks:phone:abc-123'] });
  const { manager } = await makeManager(gladys);

  await manager.processDrain([drainEntry()]);
  // Le receiver re-livre le même lot (restart entre drain et trim côté app).
  await manager.processDrain([drainEntry()]);

  assert.equal(gladys.calls.states.length, 1);
});

test('pending states are capped per device, oldest dropped', async () => {
  const lines = [];
  const gladys = fakeGladys();
  const dataDir = await mkdtemp(join(tmpdir(), 'phones-test-'));
  const manager = createPhoneManager({
    gladys,
    dataDir,
    log: { ...silentLog, warn: (msg) => lines.push(msg) },
  });
  await manager.load();

  const readings = Array.from({ length: MAX_PENDING_STATES_PER_DEVICE + 5 }, (_, i) => ({
    sensor: 'battery-level',
    value: i % 100,
    recorded_at: `2026-08-15T10:00:00.${String(i).padStart(4, '0')}Z`,
  }));
  await manager.processDrain([drainEntry({ readings })]);

  assert.ok(
    lines.some((line) => /dropped 5 oldest/.test(line)),
    lines.join('\n'),
  );
});

test('the registry survives a restart and getDevices errors keep states buffered', async () => {
  const gladys = fakeGladys();
  const { manager, dataDir } = await makeManager(gladys);
  await manager.processDrain([drainEntry()]);

  const persisted = JSON.parse(await readFile(join(dataDir, 'devices.json'), 'utf8'));
  assert.equal(persisted.devices['abc-123'].name, 'iPhone de J');

  // « Restart » : nouveau manager sur le même dataDir.
  const restarted = createPhoneManager({ gladys, dataDir, log: silentLog });
  await restarted.load();
  assert.equal(restarted.phoneCount(), 1);
  await restarted.republishDiscovery();
  assert.equal(gladys.calls.discovered.at(-1).length, 1);

  // Host API en panne pour getDevices : rien n'est publié, rien n'est perdu.
  gladys.getDevices = async () => {
    throw new Error('host api down');
  };
  await restarted.processDrain([
    drainEntry({
      readings: [{ sensor: 'battery-level', value: 80, recorded_at: '2026-08-15T11:00:00Z' }],
    }),
  ]);
  assert.equal(gladys.calls.states.length, 0);
});

test('the internal token is created once and stable across restarts', async () => {
  const gladys = fakeGladys();
  const { manager, dataDir } = await makeManager(gladys);

  const token = await manager.internalToken();
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(await manager.internalToken(), token);

  const restarted = createPhoneManager({ gladys, dataDir, log: silentLog });
  assert.equal(await restarted.internalToken(), token);
});
