// -----------------------------------------------------------------------------
// Buffer mémoire des états de capteurs reçus des téléphones.
//
// Le sous-conteneur receiver accumule ici les relevés entre deux drains du
// conteneur principal (POST /internal/drain, toutes les ~20 s). Tout est
// volontairement en mémoire et borné : un restart perd au pire une fenêtre de
// drain de télémétrie — assumé et documenté. La dédup (sensor, recorded_at)
// neutralise les retries de l'app (réponse 2xx perdue → re-POST du même lot).
// -----------------------------------------------------------------------------

export const MAX_DEVICES = 25;
export const MAX_READINGS_PER_DEVICE = 500;

/**
 * Construit le buffer d'états.
 * @param {{ log?: { info: Function, warn: Function, error: Function } }} [options]
 */
export function createStatesBuffer({ log = console } = {}) {
  /** @type {Map<string, { device: object, readings: Map<string, object> }>} */
  const devices = new Map();

  return {
    /**
     * Ajoute un lot de relevés pour un téléphone.
     * @param {string} deviceId
     * @param {{ name?: string, model?: string, platform?: string }} deviceMeta
     * @param {Array<{ sensor: string, value: number, recorded_at: string }>} readings
     * @returns {{ accepted: number, dropped: number }} dropped = évincés par les caps
     */
    add(deviceId, deviceMeta, readings) {
      let entry = devices.get(deviceId);
      if (!entry) {
        if (devices.size >= MAX_DEVICES) {
          log.warn(`States buffer full (${MAX_DEVICES} devices), dropping batch for ${deviceId}`);
          return { accepted: 0, dropped: readings.length };
        }
        entry = { device: {}, readings: new Map() };
        devices.set(deviceId, entry);
      }

      entry.device = { ...entry.device, ...deviceMeta };

      let accepted = 0;
      let dropped = 0;
      for (const reading of readings) {
        const key = `${reading.sensor}|${reading.recorded_at}`;
        if (entry.readings.has(key)) {
          continue; // doublon d'un retry : déjà en file, ni accepté ni perdu
        }
        entry.readings.set(key, reading);
        accepted += 1;
        // Map préserve l'ordre d'insertion : le premier inséré est le plus ancien.
        if (entry.readings.size > MAX_READINGS_PER_DEVICE) {
          const oldestKey = entry.readings.keys().next().value;
          entry.readings.delete(oldestKey);
          dropped += 1;
        }
      }
      if (dropped > 0) {
        log.warn(`States buffer cap reached for ${deviceId}, dropped ${dropped} oldest reading(s)`);
      }
      return { accepted, dropped };
    },

    /**
     * Renvoie tout le contenu et vide le buffer.
     * @returns {Array<{ deviceId: string, device: object, readings: Array<object> }>}
     */
    drain() {
      const drained = [];
      for (const [deviceId, entry] of devices) {
        drained.push({ deviceId, device: entry.device, readings: [...entry.readings.values()] });
      }
      devices.clear();
      return drained;
    },

    /** Nombre total de relevés en attente, tous téléphones confondus. */
    size() {
      let total = 0;
      for (const entry of devices.values()) {
        total += entry.readings.size;
      }
      return total;
    },
  };
}
