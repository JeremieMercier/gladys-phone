// -----------------------------------------------------------------------------
// Validation des clés d'API Gladys présentées par les téléphones.
//
// L'endpoint positions n'a pas besoin de valider : chaque POST est relayé au
// core, qui répond 401 lui-même. L'endpoint states, lui, ne relaie rien en
// direct (le buffer est drainé par le conteneur principal) — on valide donc la
// clé contre GET /api/v1/me du core, avec un cache borné pour ne pas marteler
// Gladys à chaque beacon. Seule l'empreinte SHA-256 de la clé est retenue.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

const VALIDATION_TIMEOUT_MS = 5000;

/**
 * Construit le validateur de clé d'API.
 * @param {object} options
 * @param {string} options.gladysBaseUrl URL du core Gladys
 * @param {typeof fetch} [options.fetchImpl] injectable pour les tests
 * @param {number} [options.validTtlMs] durée de cache d'une clé valide
 * @param {number} [options.invalidTtlMs] durée de cache d'un rejet (courte :
 *   un téléphone reconnecté doit repasser vite)
 * @param {number} [options.maxEntries]
 * @param {() => number} [options.now] injectable pour les tests
 * @returns {(rawKey: string) => Promise<'valid' | 'invalid' | 'unreachable'>}
 */
export function createApiKeyValidator({
  gladysBaseUrl,
  fetchImpl = fetch,
  validTtlMs = 5 * 60_000,
  invalidTtlMs = 30_000,
  maxEntries = 100,
  now = Date.now,
}) {
  const baseUrl = gladysBaseUrl.replace(/\/+$/, '');
  /** @type {Map<string, { result: 'valid' | 'invalid', expiresAt: number }>} */
  const cache = new Map();

  return async function validateApiKey(rawKey) {
    const cacheKey = createHash('sha256').update(rawKey).digest('hex');
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > now()) {
      return hit.result;
    }
    cache.delete(cacheKey);

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/api/v1/me`, {
        headers: {
          // Clé d'API brute, sans le préfixe Bearer : le contrat de l'API Gladys.
          authorization: rawKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
      });
    } catch {
      return 'unreachable';
    }

    if (response.ok) {
      remember(cacheKey, 'valid', validTtlMs);
      return 'valid';
    }
    if (response.status === 401 || response.status === 403) {
      remember(cacheKey, 'invalid', invalidTtlMs);
      return 'invalid';
    }
    // 5xx et statuts inattendus : état transitoire du core, jamais mis en cache.
    return 'unreachable';
  };

  /**
   * @param {string} cacheKey
   * @param {'valid' | 'invalid'} result
   * @param {number} ttlMs
   */
  function remember(cacheKey, result, ttlMs) {
    cache.set(cacheKey, { result, expiresAt: now() + ttlMs });
    if (cache.size > maxEntries) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }
  }
}
