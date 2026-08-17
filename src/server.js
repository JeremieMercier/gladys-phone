// -----------------------------------------------------------------------------
// Serveur HTTP du récepteur.
//
// Deux flux entrants depuis les téléphones :
//   - positions : POST du beacon natif du plugin nativephp/mobile-geolocation
//     (format figé : Authorization Bearer + {"points":[{latitude,…}]}),
//     relayées immédiatement à l'API REST publique de Gladys
//     (POST /api/v1/user/:selector/location, clé d'API brute dans
//     `authorization`, corps à plat) ;
//   - états de capteurs : POST /devices/:deviceId/states (contrat à nous),
//     accumulés dans un buffer mémoire borné que le conteneur principal
//     draine via POST /internal/drain (token partagé) pour publier devices et
//     états par le SDK d'intégration.
//
// Le récepteur reste sans secret durable : le token Bearer envoyé par le
// téléphone EST la clé d'API Gladys de l'utilisateur — relayée telle quelle
// pour les positions, validée contre GET /api/v1/me (avec cache) pour les
// états. Sans buffer/token injectés, seules les routes 0.1.0 sont montées.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_POINTS_PER_REQUEST = 25;
export const MAX_STATES_PER_REQUEST = 100;
const FORWARD_TIMEOUT_MS = 10_000;

const POSITIONS_PATH = /^\/users\/([A-Za-z0-9._~-]+)\/positions$/;
const DEVICE_STATES_PATH = /^\/devices\/([A-Za-z0-9._~-]{1,64})\/states$/;
const INTERNAL_DRAIN_PATH = '/internal/drain';

const SENSOR_PATTERN = /^[a-z0-9-]{1,40}$/;
const DEVICE_META_FIELDS = ['name', 'model', 'platform'];

// Fenêtres de sécurité contre les connexions lentes (slowloris) : une fois
// le récepteur exposé sur Internet, une requête qui n'envoie ni ses en-têtes
// ni son corps dans ces délais est abandonnée.
const HEADERS_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Applique les garde-fous de timeout communs à tout serveur exposé.
 * @param {import('node:http').Server} server
 */
function harden(server) {
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

/**
 * Serveur HTTP PUBLIC du récepteur : positions, états de capteurs, santé.
 * Le drain interne n'y est volontairement PAS monté — il vit sur un port
 * séparé jamais publié (voir createInternalServer), pour rester injoignable
 * depuis Internet même si le reverse proxy relaie tout le chemin.
 * @param {object} options
 * @param {string} options.gladysBaseUrl URL du core Gladys (ex. http://192.168.1.10)
 * @param {typeof fetch} [options.fetchImpl] injectable pour les tests
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {ReturnType<import('./statesBuffer.js').createStatesBuffer>} [options.statesBuffer]
 *   absent → routes states non montées (mode 0.1.0)
 * @param {(rawKey: string) => Promise<'valid' | 'invalid' | 'unreachable'>} [options.validateApiKey]
 */
export function createReceiverServer({
  gladysBaseUrl,
  fetchImpl = fetch,
  log = console,
  statesBuffer = null,
  validateApiKey = null,
}) {
  if (!gladysBaseUrl) {
    throw new Error('gladysBaseUrl is required');
  }
  const baseUrl = gladysBaseUrl.replace(/\/+$/, '');

  return harden(
    createServer(async (req, res) => {
      try {
        await handleRequest(req, res, { baseUrl, fetchImpl, log, statesBuffer, validateApiKey });
      } catch (err) {
        log.error(`Unhandled receiver error: ${err.message}`);
        sendJson(res, 500, { error: 'internal_error' });
      }
    }),
  );
}

/**
 * Serveur HTTP INTERNE : uniquement POST /internal/drain, authentifié par le
 * token partagé. Écoute sur un port jamais déclaré dans le manifeste, donc
 * jamais publié vers l'hôte : seul le conteneur principal le joint, par le
 * réseau privé Docker. C'est un plan de contrôle, il n'a aucune raison
 * d'être atteignable depuis l'extérieur.
 * @param {object} options
 * @param {ReturnType<import('./statesBuffer.js').createStatesBuffer>} options.statesBuffer
 * @param {string} options.internalToken
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 */
export function createInternalServer({ statesBuffer, internalToken, log = console }) {
  if (!statesBuffer || !internalToken) {
    throw new Error('statesBuffer and internalToken are required');
  }

  return harden(
    createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://receiver-internal');
        if (url.pathname !== INTERNAL_DRAIN_PATH) {
          return sendJson(res, 404, { error: 'not_found' });
        }
        return handleInternalDrain(req, res, { statesBuffer, internalToken });
      } catch (err) {
        log.error(`Unhandled internal error: ${err.message}`);
        sendJson(res, 500, { error: 'internal_error' });
      }
    }),
  );
}

async function handleRequest(req, res, { baseUrl, fetchImpl, log, statesBuffer, validateApiKey }) {
  const url = new URL(req.url, 'http://receiver');

  if (url.pathname === '/health') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    return sendJson(res, 200, { status: 'ok' });
  }

  const statesMatch = statesBuffer && url.pathname.match(DEVICE_STATES_PATH);
  if (statesMatch) {
    return handleDeviceStates(req, res, {
      deviceId: statesMatch[1],
      statesBuffer,
      validateApiKey,
      log,
    });
  }

  const match = url.pathname.match(POSITIONS_PATH);
  if (!match) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  // Chaque requête du beacon laisse une trace, y compris les rejets :
  // c'est le journal qu'on lit pour déboguer un téléphone mal configuré.
  // Jamais de clé d'API ni de coordonnées dans les logs.
  const selector = match[1];
  const apiKey = bearerToken(req.headers.authorization);
  if (!apiKey) {
    log.warn(`Rejected POST for ${selector}: missing bearer token (401)`);
    return sendJson(res, 401, { error: 'missing_bearer_token' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    const error = err.code?.toLowerCase() ?? 'invalid_body';
    log.warn(`Rejected POST for ${selector}: ${error} (${status})`);
    return sendJson(res, status, { error });
  }

  const points = validatePoints(body);
  if (points === null) {
    log.warn(`Rejected POST for ${selector}: invalid_points (400)`);
    return sendJson(res, 400, { error: 'invalid_points' });
  }

  // Le beacon envoie un seul point par requête ; on accepte néanmoins un
  // lot ordonné (les plus récents en dernier) en le plafonnant.
  const batch = points.slice(-MAX_POINTS_PER_REQUEST);

  let forwarded = 0;
  for (const point of batch) {
    const { outcome, httpStatus } = await forwardToGladys({
      baseUrl,
      fetchImpl,
      selector,
      apiKey,
      point,
    });
    if (outcome !== 'ok') {
      const detail = httpStatus !== undefined ? `, Gladys answered HTTP ${httpStatus}` : '';
      log.warn(
        `Forward failed for ${selector}: ${outcome}${detail} (${forwarded}/${batch.length} sent)`,
      );
      if (outcome === 'unauthorized') {
        return sendJson(res, 401, { error: 'invalid_api_key' });
      }
      return sendJson(res, 502, { error: outcome, forwarded });
    }
    forwarded += 1;
  }

  const lastFixAt = batch[batch.length - 1].timestamp;
  log.info(
    `Forwarded ${forwarded} position(s) for ${selector}${lastFixAt ? ` (last fix at ${lastFixAt})` : ''}`,
  );
  return sendJson(res, 200, { forwarded });
}

/**
 * Réceptionne un lot d'états de capteurs d'un téléphone.
 * Chaque requête laisse une trace, y compris les rejets — jamais de clé d'API
 * ni de valeur de capteur dans les logs.
 */
async function handleDeviceStates(req, res, { deviceId, statesBuffer, validateApiKey, log }) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  const apiKey = bearerToken(req.headers.authorization);
  if (!apiKey) {
    log.warn(`Rejected states POST for ${deviceId}: missing bearer token (401)`);
    return sendJson(res, 401, { error: 'missing_bearer_token' });
  }

  const validity = await validateApiKey(apiKey);
  if (validity === 'invalid') {
    log.warn(`Rejected states POST for ${deviceId}: invalid_api_key (401)`);
    return sendJson(res, 401, { error: 'invalid_api_key' });
  }
  if (validity === 'unreachable') {
    log.warn(`Rejected states POST for ${deviceId}: gladys_unreachable (502)`);
    return sendJson(res, 502, { error: 'gladys_unreachable' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    const error = err.code?.toLowerCase() ?? 'invalid_body';
    log.warn(`Rejected states POST for ${deviceId}: ${error} (${status})`);
    return sendJson(res, status, { error });
  }

  const parsed = validateStatesBody(body);
  if (parsed === null) {
    log.warn(`Rejected states POST for ${deviceId}: invalid_states (400)`);
    return sendJson(res, 400, { error: 'invalid_states' });
  }

  const { accepted, dropped } = statesBuffer.add(deviceId, parsed.device, parsed.states);
  log.info(`Accepted ${accepted} state(s) for device ${deviceId}`);
  return sendJson(res, 200, { accepted, dropped });
}

/** Rend le buffer au conteneur principal et le vide (authentifié par token partagé). */
function handleInternalDrain(req, res, { statesBuffer, internalToken }) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  const provided = bearerToken(req.headers.authorization);
  if (!provided || !tokensMatch(provided, internalToken)) {
    return sendJson(res, 401, { error: 'invalid_internal_token' });
  }
  return sendJson(res, 200, { devices: statesBuffer.drain() });
}

/**
 * Comparaison en temps constant, via empreintes de taille fixe pour ne pas
 * fuiter la longueur du token.
 * @param {string} provided
 * @param {string} expected
 */
function tokensMatch(provided, expected) {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Valide le corps d'un POST states. Les sensors inconnus du mapping sont
 * acceptés ici (le tri se fait côté conteneur principal) : une app plus
 * récente que le receiver ne doit pas voir ses lots rejetés en bloc.
 * @param {unknown} body
 * @returns {{ device: object, states: Array<{sensor: string, value: number, recorded_at: string}> } | null}
 */
function validateStatesBody(body) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(body.states) ||
    body.states.length === 0 ||
    body.states.length > MAX_STATES_PER_REQUEST
  ) {
    return null;
  }
  for (const state of body.states) {
    if (
      typeof state !== 'object' ||
      state === null ||
      typeof state.sensor !== 'string' ||
      !SENSOR_PATTERN.test(state.sensor) ||
      typeof state.value !== 'number' ||
      !Number.isFinite(state.value) ||
      typeof state.recorded_at !== 'string' ||
      !Number.isFinite(Date.parse(state.recorded_at))
    ) {
      return null;
    }
  }

  const device = {};
  if (typeof body.device === 'object' && body.device !== null) {
    for (const field of DEVICE_META_FIELDS) {
      const value = body.device[field];
      if (typeof value === 'string' && value.trim() !== '') {
        device[field] = value.trim().slice(0, 64);
      }
    }
  }

  return {
    device,
    states: body.states.map((state) => ({
      sensor: state.sensor,
      value: state.value,
      recorded_at: state.recorded_at,
    })),
  };
}

/**
 * Transmet un point au core Gladys.
 * @returns {Promise<{outcome: 'ok' | 'unauthorized' | 'gladys_error' | 'gladys_unreachable', httpStatus?: number}>}
 */
async function forwardToGladys({ baseUrl, fetchImpl, selector, apiKey, point }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/user/${encodeURIComponent(selector)}/location`, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        latitude: point.latitude,
        longitude: point.longitude,
        altitude: point.altitude ?? null,
        accuracy: point.accuracy ?? null,
      }),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch {
    return { outcome: 'gladys_unreachable' };
  }

  if (response.ok) {
    return { outcome: 'ok' };
  }
  if (response.status === 401 || response.status === 403) {
    return { outcome: 'unauthorized', httpStatus: response.status };
  }
  return { outcome: 'gladys_error', httpStatus: response.status };
}

/**
 * Valide le corps du beacon et retourne les points, ou null si invalide.
 * @param {unknown} body
 * @returns {Array<{latitude: number, longitude: number, altitude?: number, accuracy?: number}> | null}
 */
function validatePoints(body) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray(body.points) ||
    body.points.length === 0
  ) {
    return null;
  }
  for (const point of body.points) {
    if (
      typeof point !== 'object' ||
      point === null ||
      !isFiniteInRange(point.latitude, -90, 90) ||
      !isFiniteInRange(point.longitude, -180, 180)
    ) {
      return null;
    }
  }
  return body.points;
}

function isFiniteInRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Extrait le token d'un en-tête `Authorization: Bearer xxx`.
 * @param {string | undefined} header
 */
function bearerToken(header) {
  if (typeof header !== 'string') {
    return null;
  }
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Lit et parse le corps JSON, avec plafond de taille.
 * @param {import('node:http').IncomingMessage} req
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
