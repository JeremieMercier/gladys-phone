// Tests du serveur récepteur : parsing du format beacon, authentification,
// transfert vers un faux core Gladys, remontée des erreurs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReceiverServer } from '../src/server.js';

const silentLog = { info() {}, warn() {}, error() {} };

/** Faux core Gladys : enregistre les requêtes reçues et répond selon le scénario. */
function startFakeGladys({ status = 200 } = {}) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { success: true } : { error: 'nope' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startReceiver(gladysBaseUrl) {
  const server = createReceiverServer({ gladysBaseUrl, log: silentLog });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function beaconPost(url, { token = 'my-api-key', body } = {}) {
  return fetch(`${url}/users/john/positions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(
      body ?? {
        points: [
          {
            latitude: 45.5017,
            longitude: -73.5673,
            accuracy: 8.2,
            speed: 3.1,
            heading: 121.5,
            timestamp: '2026-07-13T14:03:22Z',
          },
        ],
      },
    ),
  });
}

let fake;
let receiver;

beforeEach(async () => {
  fake = await startFakeGladys();
  receiver = await startReceiver(fake.url);
});

afterEach(() => {
  receiver.server.close();
  fake.server.close();
});

test('health endpoint answers ok', async () => {
  const response = await fetch(`${receiver.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('forwards a beacon point to the Gladys user location endpoint', async () => {
  const response = await beaconPost(receiver.url);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { forwarded: 1 });

  assert.equal(fake.received.length, 1);
  const [request] = fake.received;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/user/john/location');
  // Clé d'API brute, sans le préfixe Bearer : le contrat de l'API Gladys.
  assert.equal(request.authorization, 'my-api-key');
  // Corps à plat, champs beacon superflus (speed, heading, timestamp) écartés.
  assert.deepEqual(request.body, {
    latitude: 45.5017,
    longitude: -73.5673,
    altitude: null,
    accuracy: 8.2,
  });
});

test('forwards several points in order and reports the count', async () => {
  const response = await beaconPost(receiver.url, {
    body: {
      points: [
        { latitude: 1, longitude: 1 },
        { latitude: 2, longitude: 2, altitude: 231 },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { forwarded: 2 });
  assert.equal(fake.received.length, 2);
  assert.equal(fake.received[0].body.latitude, 1);
  assert.equal(fake.received[1].body.altitude, 231);
});

test('rejects a request without bearer token, nothing forwarded', async () => {
  const response = await beaconPost(receiver.url, { token: null });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'missing_bearer_token' });
  assert.equal(fake.received.length, 0);
});

test('maps a Gladys 401 to invalid_api_key', async () => {
  const unauthorized = await startFakeGladys({ status: 401 });
  const front = await startReceiver(unauthorized.url);
  try {
    const response = await beaconPost(front.url);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_api_key' });
  } finally {
    front.server.close();
    unauthorized.server.close();
  }
});

test('maps a Gladys server error to 502', async () => {
  const broken = await startFakeGladys({ status: 500 });
  const front = await startReceiver(broken.url);
  try {
    const response = await beaconPost(front.url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'gladys_error', forwarded: 0 });
  } finally {
    front.server.close();
    broken.server.close();
  }
});

test('answers 502 gladys_unreachable when the core is down', async () => {
  const front = await startReceiver('http://127.0.0.1:1');
  try {
    const response = await beaconPost(front.url);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'gladys_unreachable', forwarded: 0 });
  } finally {
    front.server.close();
  }
});

test('rejects malformed bodies', async () => {
  for (const body of [
    {},
    { points: [] },
    { points: [{ latitude: 91, longitude: 0 }] },
    { points: [{ latitude: 0, longitude: 181 }] },
    { points: [{ latitude: '45.5', longitude: 3 }] },
  ]) {
    const response = await beaconPost(receiver.url, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_points' });
  }
  assert.equal(fake.received.length, 0);
});

test('rejects invalid JSON', async () => {
  const response = await fetch(`${receiver.url}/users/john/positions`, {
    method: 'POST',
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_json' });
});

test('every beacon request leaves a log line, including rejections', async () => {
  const lines = [];
  const spyLog = {
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    error: (msg) => lines.push(`error: ${msg}`),
  };
  const server = createReceiverServer({ gladysBaseUrl: fake.url, log: spyLog });
  const front = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });

  try {
    await beaconPost(front.url);
    await beaconPost(front.url, { token: null });
    await beaconPost(front.url, { body: { points: [] } });
    await fetch(`${front.url}/health`);

    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(
      lines[0],
      /^info: Forwarded 1 position\(s\) for john \(last fix at 2026-07-13T14:03:22Z\)$/,
    );
    assert.match(lines[1], /^warn: Rejected POST for john: missing bearer token \(401\)$/);
    assert.match(lines[2], /^warn: Rejected POST for john: invalid_points \(400\)$/);
    // Ni la clé d'API ni des coordonnées ne doivent fuiter dans les logs.
    assert.ok(!lines.join(' ').includes('my-api-key'));
    assert.ok(!lines.join(' ').includes('45.5017'));
  } finally {
    front.server.close();
  }
});

test('a Gladys error logs the HTTP status answered', async () => {
  const lines = [];
  const spyLog = { info: () => {}, warn: (msg) => lines.push(msg), error: () => {} };
  const broken = await startFakeGladys({ status: 500 });
  const server = createReceiverServer({ gladysBaseUrl: broken.url, log: spyLog });
  const front = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    );
  });

  try {
    await beaconPost(front.url);
    assert.match(lines[0], /gladys_error, Gladys answered HTTP 500/);
  } finally {
    front.server.close();
    broken.server.close();
  }
});

test('unknown paths are 404, wrong methods are 405', async () => {
  assert.equal((await fetch(`${receiver.url}/nope`)).status, 404);
  assert.equal((await fetch(`${receiver.url}/users/john/positions`)).status, 405);
  assert.equal((await fetch(`${receiver.url}/health`, { method: 'POST' })).status, 405);
});
