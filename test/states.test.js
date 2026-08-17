// Tests des routes états de capteurs : validation de la clé API contre le
// core (avec cache), contrat du corps, drain interne authentifié sur son
// port séparé, et absence des routes en mode 0.1.0 (sans buffer injecté).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReceiverServer, createInternalServer } from '../src/server.js';
import { createStatesBuffer } from '../src/statesBuffer.js';
import { createApiKeyValidator } from '../src/apiKeyCache.js';

const silentLog = { info() {}, warn() {}, error() {} };
const INTERNAL_TOKEN = 'shared-internal-token';

/** Faux core Gladys : route /api/v1/me selon le scénario et compte les appels. */
function startFakeCore({ meStatus = 200 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization });
    const status = req.url === '/api/v1/me' ? meStatus : 404;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status < 400 ? { selector: 'john' } : { error: 'nope' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/**
 * Démarre le récepteur complet : serveur public (positions/états/santé) et
 * serveur interne (drain) sur deux ports distincts, partageant le buffer.
 */
async function startStatesReceiver(coreUrl, { log = silentLog } = {}) {
  const statesBuffer = createStatesBuffer({ log });
  const publicServer = createReceiverServer({
    gladysBaseUrl: coreUrl,
    log,
    statesBuffer,
    validateApiKey: createApiKeyValidator({ gladysBaseUrl: coreUrl }),
  });
  const internalServer = createInternalServer({ statesBuffer, internalToken: INTERNAL_TOKEN, log });

  const url = await listen(publicServer);
  const internalUrl = await listen(internalServer);

  return {
    url,
    internalUrl,
    close() {
      publicServer.close();
      internalServer.close();
    },
  };
}

function statesPost(url, { token = 'my-api-key', deviceId = 'phone-1', body } = {}) {
  return fetch(`${url}/devices/${deviceId}/states`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(
      body ?? {
        device: { name: 'iPhone de J', model: 'iPhone15,2', platform: 'ios' },
        states: [
          { sensor: 'battery-level', value: 87, recorded_at: '2026-08-15T10:00:00Z' },
          { sensor: 'battery-charging', value: 1, recorded_at: '2026-08-15T10:00:00Z' },
        ],
      },
    ),
  });
}

function drainPost(url, { token = INTERNAL_TOKEN } = {}) {
  return fetch(`${url}/internal/drain`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

let core;
let receiver;

beforeEach(async () => {
  core = await startFakeCore();
  receiver = await startStatesReceiver(core.url);
});

afterEach(() => {
  receiver.close();
  core.server.close();
});

test('accepts a states batch after validating the api key against the core', async () => {
  const response = await statesPost(receiver.url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 2, dropped: 0 });

  // La clé est validée contre /api/v1/me, brute (sans préfixe Bearer).
  assert.equal(core.received.length, 1);
  assert.equal(core.received[0].url, '/api/v1/me');
  assert.equal(core.received[0].authorization, 'my-api-key');
});

test('caches a valid api key: two posts, one core call', async () => {
  await statesPost(receiver.url);
  await statesPost(receiver.url, {
    body: { states: [{ sensor: 'battery-level', value: 86, recorded_at: '2026-08-15T10:15:00Z' }] },
  });
  assert.equal(core.received.length, 1);
});

test('rejects a states post without bearer token', async () => {
  const response = await statesPost(receiver.url, { token: null });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'missing_bearer_token' });
  assert.equal(core.received.length, 0);
});

test('passes through an invalid api key as 401', async () => {
  const unauthorized = await startFakeCore({ meStatus: 401 });
  const front = await startStatesReceiver(unauthorized.url);
  try {
    const response = await statesPost(front.url);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_api_key' });
  } finally {
    front.close();
    unauthorized.server.close();
  }
});

test('answers 502 when the core cannot validate the key', async () => {
  const front = await startStatesReceiver('http://127.0.0.1:1');
  try {
    const response = await statesPost(front.url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'gladys_unreachable' });
  } finally {
    front.close();
  }
});

test('rejects malformed states bodies', async () => {
  for (const body of [
    {},
    { states: [] },
    { states: [{ sensor: 'battery-level', value: 87 }] },
    { states: [{ sensor: 'battery-level', value: 'high', recorded_at: '2026-08-15T10:00:00Z' }] },
    { states: [{ sensor: 'battery-level', value: Infinity, recorded_at: '2026-08-15T10:00:00Z' }] },
    { states: [{ sensor: 'Battery Level!', value: 87, recorded_at: '2026-08-15T10:00:00Z' }] },
    { states: [{ sensor: 'battery-level', value: 87, recorded_at: 'not a date' }] },
  ]) {
    const response = await statesPost(receiver.url, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_states' });
  }
});

test('accepts sensors unknown to the mapping (newer app than receiver)', async () => {
  const response = await statesPost(receiver.url, {
    body: { states: [{ sensor: 'future-sensor', value: 42, recorded_at: '2026-08-15T10:00:00Z' }] },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, dropped: 0 });
});

test('the drain endpoint is not exposed on the public server', async () => {
  // Sur le port public, /internal/drain n'existe pas : ni le token ni la
  // méthode ne sont même évalués, c'est un 404 comme un chemin inconnu.
  const onPublic = await drainPost(receiver.url);
  assert.equal(onPublic.status, 404);
});

test('internal drain requires the shared token on the internal port', async () => {
  await statesPost(receiver.url);

  const unauthorized = await drainPost(receiver.internalUrl, { token: 'wrong' });
  assert.equal(unauthorized.status, 401);
  const missing = await drainPost(receiver.internalUrl, { token: null });
  assert.equal(missing.status, 401);

  const drained = await drainPost(receiver.internalUrl);
  assert.equal(drained.status, 200);
  const { devices } = await drained.json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, 'phone-1');
  assert.deepEqual(devices[0].device, {
    name: 'iPhone de J',
    model: 'iPhone15,2',
    platform: 'ios',
  });
  assert.equal(devices[0].readings.length, 2);

  // Le drain vide le buffer.
  const empty = await drainPost(receiver.internalUrl);
  assert.deepEqual(await empty.json(), { devices: [] });
});

test('states routes are absent in 0.1.0 mode (no buffer injected)', async () => {
  const bare = createReceiverServer({ gladysBaseUrl: core.url, log: silentLog });
  const url = await listen(bare);
  try {
    assert.equal((await statesPost(url)).status, 404);
  } finally {
    bare.close();
  }
});

test('states requests log without leaking keys or values', async () => {
  const lines = [];
  const spyLog = {
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
  };
  const front = await startStatesReceiver(core.url, { log: spyLog });
  try {
    await statesPost(front.url);
    await statesPost(front.url, { token: null });

    assert.match(lines[0], /^info: Accepted 2 state\(s\) for device phone-1$/);
    assert.match(
      lines[1],
      /^warn: Rejected states POST for phone-1: missing bearer token \(401\)$/,
    );
    assert.ok(!lines.join(' ').includes('my-api-key'));
    assert.ok(!lines.join(' ').includes('87'));
  } finally {
    front.close();
  }
});
