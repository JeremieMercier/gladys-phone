// -----------------------------------------------------------------------------
// Registre des téléphones et publication vers Gladys (côté conteneur principal).
//
// Reçoit les lots drainés du sous-conteneur receiver et les traduit en appels
// SDK : publishDiscoveredDevices (le téléphone apparaît dans l'écran
// Découverte, l'utilisateur l'ajoute) puis publishStates (états horodatés).
//
// Le registre est persisté dans /data/devices.json : publishDiscoveredDevices
// REMPLACE la liste complète à chaque appel, un redémarrage sans registre
// ferait donc disparaître les téléphones déjà découverts. Le token du drain
// interne est lui aussi persisté (/data/internal-token) pour rester stable
// entre deux redémarrages du conteneur principal.
//
// Sémantique at-least-once : un échec de publication re-met les états en file
// (bornée) ; le filtre lastPublishedAt évite de republier un même
// (feature, recorded_at) au tour suivant.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { buildPhoneDevice, featureExternalId } from './sensors.js';

export const MAX_PENDING_STATES_PER_DEVICE = 500;
export const MAX_STATES_PER_PUBLISH = 100;
const GET_DEVICES_CACHE_MS = 60_000;

/**
 * @param {object} options
 * @param {object} options.gladys instance du SDK d'intégration
 * @param {string} [options.dataDir] seul chemin inscriptible du conteneur
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} [options.log]
 * @param {() => number} [options.now] injectable pour les tests
 */
export function createPhoneManager({ gladys, dataDir = '/data', log = console, now = Date.now }) {
  const registryPath = join(dataDir, 'devices.json');
  const tokenPath = join(dataDir, 'internal-token');

  /** @type {Record<string, { name?: string, model?: string, platform?: string, lastSeenAt?: string }>} */
  let registry = {};
  /** @type {Map<string, Array<{ device_feature_external_id: string, state: number, created_at: string }>>} */
  const pendingStates = new Map();
  /** @type {Map<string, string>} dernier created_at publié par feature */
  const lastPublishedAt = new Map();
  /** @type {Set<string>} devices déjà signalés « pas encore ajouté dans Gladys » */
  const waitingLogged = new Set();
  let devicesCache = { at: 0, ids: null };

  return {
    /** Recharge le registre persisté ; un fichier absent/corrompu = départ vide. */
    async load() {
      try {
        const parsed = JSON.parse(await readFile(registryPath, 'utf8'));
        registry = parsed && typeof parsed.devices === 'object' ? parsed.devices : {};
      } catch {
        registry = {};
      }
      return registry;
    },

    /**
     * Token du drain interne, créé au premier appel puis stable.
     * Si /data est indisponible (exécution hors conteneur), retombe sur un
     * token éphémère en mémoire.
     */
    async internalToken() {
      try {
        const existing = (await readFile(tokenPath, 'utf8')).trim();
        if (existing !== '') {
          return existing;
        }
      } catch {
        // fichier absent : on le crée ci-dessous
      }
      const token = randomUUID();
      try {
        await mkdir(dataDir, { recursive: true });
        await writeAtomically(tokenPath, token);
      } catch (err) {
        log.warn(`Could not persist the internal token (${err.message}), using an ephemeral one`);
      }
      return token;
    },

    /**
     * Cœur de la boucle : intègre un drain du receiver.
     * @param {Array<{ deviceId: string, device: object, readings: Array }>} entries
     */
    async processDrain(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return flushPendingStates();
      }

      let registryChanged = false;
      for (const { deviceId, device, readings } of entries) {
        registryChanged = upsertRegistry(deviceId, device) || registryChanged;
        enqueueReadings(deviceId, readings);
      }

      if (registryChanged) {
        await saveRegistry();
        await publishDiscovery();
      }
      await flushPendingStates();
    },

    /** Republie la découverte depuis le registre (onScanRequest, reconnexion). */
    async republishDiscovery() {
      await publishDiscovery();
    },

    /** Nombre de téléphones connus (pour les messages de santé). */
    phoneCount() {
      return Object.keys(registry).length;
    },
  };

  /**
   * @param {string} deviceId
   * @param {{ name?: string, model?: string, platform?: string }} meta
   * @returns {boolean} true si le registre a changé (nouveau téléphone ou meta)
   */
  function upsertRegistry(deviceId, meta) {
    const existing = registry[deviceId];
    const merged = { ...existing, ...compactMeta(meta) };
    const changed =
      !existing ||
      merged.name !== existing.name ||
      merged.model !== existing.model ||
      merged.platform !== existing.platform;
    registry[deviceId] = { ...merged, lastSeenAt: new Date(now()).toISOString() };
    return changed;
  }

  /** @param {{ name?: string, model?: string, platform?: string }} meta */
  function compactMeta(meta = {}) {
    const compact = {};
    for (const field of ['name', 'model', 'platform']) {
      if (typeof meta[field] === 'string' && meta[field] !== '') {
        compact[field] = meta[field];
      }
    }
    return compact;
  }

  /**
   * Traduit les relevés en états SDK et les met en file (bornée par device).
   * @param {string} deviceId
   * @param {Array<{ sensor: string, value: number, recorded_at: string }>} readings
   */
  function enqueueReadings(deviceId, readings) {
    if (!Array.isArray(readings) || readings.length === 0) {
      return;
    }
    const queue = pendingStates.get(deviceId) ?? [];
    for (const reading of readings) {
      const externalId = featureExternalId(gladys, deviceId, reading.sensor);
      if (externalId === null) {
        log.debug?.(`Unknown sensor "${reading.sensor}" for ${deviceId}, skipping`);
        continue;
      }
      const published = lastPublishedAt.get(externalId);
      if (published !== undefined && reading.recorded_at <= published) {
        continue; // déjà publié lors d'un tour précédent (redrain, retry app)
      }
      queue.push({
        device_feature_external_id: externalId,
        state: reading.value,
        created_at: reading.recorded_at,
      });
    }
    if (queue.length > MAX_PENDING_STATES_PER_DEVICE) {
      const dropped = queue.length - MAX_PENDING_STATES_PER_DEVICE;
      queue.splice(0, dropped);
      log.warn(`Pending states cap reached for ${deviceId}, dropped ${dropped} oldest state(s)`);
    }
    if (queue.length > 0) {
      pendingStates.set(deviceId, queue);
    }
  }

  /** Publie les états des téléphones que l'utilisateur a créés dans Gladys. */
  async function flushPendingStates() {
    if (pendingStates.size === 0) {
      return;
    }
    const createdIds = await getCreatedDeviceIds();
    if (createdIds === null) {
      return; // host API indisponible : on garde tout pour le prochain tour
    }

    for (const [deviceId, queue] of pendingStates) {
      const deviceExternalId = buildPhoneDevice(gladys, deviceId).external_id;
      if (!createdIds.has(deviceExternalId)) {
        if (!waitingLogged.has(deviceId)) {
          waitingLogged.add(deviceId);
          log.info(`Phone ${deviceId} discovered but not added in Gladys yet, buffering states`);
        }
        continue;
      }
      waitingLogged.delete(deviceId);

      while (queue.length > 0) {
        const chunk = queue.slice(0, MAX_STATES_PER_PUBLISH);
        try {
          await gladys.publishStates(chunk);
        } catch (err) {
          log.warn(`publishStates failed for ${deviceId} (${err.message}), will retry`);
          return; // on garde le reliquat, l'échec vaut sans doute pour tous
        }
        queue.splice(0, chunk.length);
        for (const state of chunk) {
          const previous = lastPublishedAt.get(state.device_feature_external_id);
          if (previous === undefined || state.created_at > previous) {
            lastPublishedAt.set(state.device_feature_external_id, state.created_at);
          }
        }
      }
      pendingStates.delete(deviceId);
    }
  }

  /** @returns {Promise<Set<string> | null>} external_ids des devices créés, null si indisponible */
  async function getCreatedDeviceIds() {
    if (devicesCache.ids !== null && now() - devicesCache.at < GET_DEVICES_CACHE_MS) {
      return devicesCache.ids;
    }
    try {
      const devices = await gladys.getDevices();
      devicesCache = { at: now(), ids: new Set(devices.map((device) => device.external_id)) };
      return devicesCache.ids;
    } catch (err) {
      log.warn(`getDevices failed (${err.message}), keeping states buffered`);
      return null;
    }
  }

  async function publishDiscovery() {
    const devices = Object.entries(registry).map(([deviceId, meta]) =>
      buildPhoneDevice(gladys, deviceId, meta),
    );
    try {
      await gladys.publishDiscoveredDevices(devices);
      log.info(`Published ${devices.length} discovered phone(s)`);
    } catch (err) {
      log.warn(`publishDiscoveredDevices failed (${err.message}), will retry on next change`);
    }
  }

  async function saveRegistry() {
    try {
      await mkdir(dataDir, { recursive: true });
      await writeAtomically(registryPath, JSON.stringify({ devices: registry }, null, 2));
    } catch (err) {
      log.warn(`Could not persist the phone registry (${err.message})`);
    }
  }

  /**
   * Écriture temp + rename : un crash en pleine écriture ne corrompt jamais
   * le fichier existant.
   * @param {string} path
   * @param {string} content
   */
  async function writeAtomically(path, content) {
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, path);
  }
}
