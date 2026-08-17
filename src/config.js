// -----------------------------------------------------------------------------
// Configuration de l'intégration.
//
// Un seul réglage : l'URL locale de l'instance Gladys, que le sous-conteneur
// « receiver » utilise pour transmettre les positions à l'API REST du core.
// Laissé vide, on la déduit de GLADYS_HOST_API_URL (même hôte, port HTTP par
// défaut) : l'API host des intégrations et l'API REST publique vivent sur la
// même machine.
// -----------------------------------------------------------------------------

// Piège vécu : ne jamais préfixer une clé de config par `gladys_`. Le serveur
// stocke les clés en MAJUSCULES et le préfixe GLADYS_ est réservé à ses
// préférences internes — la valeur serait écrite mais jamais relue.
export const DEFAULT_CONFIG = {
  instance_url: '',
};

/**
 * Fusionne la config utilisateur avec les défauts.
 * @param {Record<string, unknown>} raw config renvoyée par le SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    instance_url: normalizeBaseUrl(raw.instance_url),
  };
}

/**
 * Nettoie une URL saisie par l'utilisateur : trim, suppression du slash final,
 * chaîne vide si invalide ou absente.
 * @param {unknown} value
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return '';
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Déduit l'URL du core Gladys depuis l'URL de l'API host injectée par le
 * superviseur (même hôte, port HTTP implicite).
 * @param {string | undefined} hostApiUrl valeur de GLADYS_HOST_API_URL
 */
export function deriveGladysUrl(hostApiUrl) {
  if (!hostApiUrl) {
    return '';
  }
  try {
    const url = new URL(hostApiUrl);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return '';
  }
}

/**
 * URL effective du core : le réglage utilisateur prime, la déduction sinon.
 * @param {{ instance_url: string }} config config normalisée
 * @param {NodeJS.ProcessEnv} env
 */
export function effectiveGladysUrl(config, env = process.env) {
  return config.instance_url || deriveGladysUrl(env.GLADYS_HOST_API_URL);
}
