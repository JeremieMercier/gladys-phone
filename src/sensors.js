// -----------------------------------------------------------------------------
// Mapping capteur → feature Gladys.
//
// Table unique de vérité pour la structure des devices « téléphone » publiés
// en découverte : ajouter un capteur = une entrée ici (l'app peut l'envoyer
// avant même que le receiver la connaisse — les sensors inconnus sont
// simplement ignorés au moment de la publication).
//
// Chaque téléphone publie TOUTES les features de la table (pas seulement
// celles déjà vues) : la structure reste stable et l'utilisateur ne voit pas
// un bouton « Update » en découverte à chaque capteur activé côté app.
//
// Choix vérifiés dans le core Gladys : batterie = battery/integer/percent ;
// « en charge » = unknown/binary (pas de catégorie dédiée, et jamais `switch`
// pour un capteur en lecture seule — le dashboard le rendrait actionnable).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

/** Segment `type` des external_ids : ext:<selector>:phone:<deviceId>[:<sensor>]. */
export const PHONE_DEVICE_TYPE = 'phone';

// Le nom d'une feature Gladys est une chaîne unique (pas de i18n côté
// serveur) : on publie en français, la langue du public visé par
// l'intégration ; l'utilisateur peut renommer via l'upsert du device.
export const SENSOR_FEATURES = {
  'battery-level': {
    name: 'Batterie',
    category: DEVICE_FEATURE_CATEGORIES.BATTERY,
    type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
  },
  'battery-charging': {
    name: 'En charge',
    category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  },
};

/**
 * Nom affiché du device en découverte : le nom du téléphone s'il est connu.
 * @param {string} deviceId
 * @param {{ name?: string }} [meta]
 */
export function phoneDeviceName(deviceId, meta = {}) {
  return meta.name || `Gladys Phone ${deviceId.slice(0, 8)}`;
}

/**
 * Device Gladys complet pour publishDiscoveredDevices.
 * @param {{ externalIds: Function }} gladys instance du SDK
 * @param {string} deviceId identifiant stable du téléphone (Device::getId())
 * @param {{ name?: string, model?: string, platform?: string }} [meta]
 */
export function buildPhoneDevice(gladys, deviceId, meta = {}) {
  const ids = gladys.externalIds(PHONE_DEVICE_TYPE, deviceId);
  return {
    name: phoneDeviceName(deviceId, meta),
    external_id: ids.device,
    ...(meta.model ? { model: meta.model } : {}),
    features: Object.entries(SENSOR_FEATURES).map(([sensor, feature]) => ({
      name: feature.name,
      external_id: ids.feature(sensor),
      category: feature.category,
      type: feature.type,
      ...(feature.unit ? { unit: feature.unit } : {}),
      min: feature.min,
      max: feature.max,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    })),
  };
}

/**
 * External_id de la feature d'un capteur, ou null si le capteur est inconnu
 * de la table (app plus récente que le receiver).
 * @param {{ externalIds: Function }} gladys
 * @param {string} deviceId
 * @param {string} sensor
 */
export function featureExternalId(gladys, deviceId, sensor) {
  if (!(sensor in SENSOR_FEATURES)) {
    return null;
  }
  return gladys.externalIds(PHONE_DEVICE_TYPE, deviceId).feature(sensor);
}
