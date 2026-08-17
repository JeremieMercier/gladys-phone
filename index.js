// -----------------------------------------------------------------------------
// Point d'entrée du conteneur principal de l'intégration.
//
// Rôle : la glue SDK — lire la config, démarrer le sous-conteneur « receiver »
// avec l'URL du core Gladys, refléter l'état de santé dans l'écran de
// configuration, et drainer périodiquement les états de capteurs accumulés
// par le receiver pour les publier via le SDK (découverte + états). La
// logique de réception HTTP vit dans le sous-conteneur (src/server.js), la
// traduction vers Gladys dans src/phones.js.
//
// Variables injectées par le superviseur Gladys :
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// Le SDK les lit automatiquement.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, effectiveGladysUrl } from './src/config.js';
import { createPhoneManager } from './src/phones.js';

const RECEIVER_CONTAINER = 'receiver';
const RECEIVER_HEALTH_URL = 'http://receiver:8080/health';
// Port interne non publié : atteint le drain par le réseau privé Docker.
const RECEIVER_DRAIN_URL = 'http://receiver:8091/internal/drain';
const DRAIN_INTERVAL_MS = 20_000;

const gladys = new GladysIntegration();
const phones = createPhoneManager({ gladys, log: logger });

let config = normalizeConfig();
let drainTimer = null;
let draining = false;
let lastDrainOk = true;

// --- Cycle de vie de la connexion --------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await phones.load();
    // Stop d'abord : après un restart du conteneur principal, le sous-conteneur
    // doit repartir avec l'env courante (URL du core + token de drain).
    await gladys.stopContainer(RECEIVER_CONTAINER).catch(() => {});
    await startReceiver();
    await reportHealth();
    startDrainLoop();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Config modifiée : redémarrer le receiver avec la nouvelle URL ------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> restarting the receiver');
  config = normalizeConfig(newConfig);
  await gladys.stopContainer(RECEIVER_CONTAINER).catch(() => {});
  await startReceiver();
  await reportHealth();
});

// --- Scan demandé depuis l'écran de l'intégration -----------------------------
gladys.onScanRequest(() => phones.republishDiscovery());

// --- Action « Tester le récepteur » ------------------------------------------
gladys.onAction('check_health', async () => {
  const gladysUrl = effectiveGladysUrl(config);
  const receiverUp = await isReceiverHealthy();
  const coreReachable = gladysUrl !== '' && (await isCoreReachable(gladysUrl));

  if (receiverUp && coreReachable) {
    const detected = config.instance_url === '';
    return {
      en: `Receiver up, Gladys reachable at "${gladysUrl}" (${detected ? 'auto-detected' : 'from your configuration'}). Ready to receive positions.`,
      fr: `Récepteur actif, Gladys joignable sur « ${gladysUrl} » (${detected ? 'détectée automatiquement' : 'issue de votre configuration'}). Prêt à recevoir des positions.`,
    };
  }
  if (!receiverUp) {
    return {
      en: 'The receiver container does not answer, check the integration logs.',
      fr: 'Le conteneur récepteur ne répond pas, consultez les logs de l’intégration.',
    };
  }
  return {
    en: `The receiver is up but Gladys is not reachable at "${gladysUrl}". Set the local Gladys URL in the configuration.`,
    fr: `Le récepteur est actif mais Gladys est injoignable à « ${gladysUrl} ». Renseignez l'URL locale de Gladys dans la configuration.`,
  };
});

/**
 * Démarre le sous-conteneur receiver avec l'URL effective du core.
 * `start: "manual"` dans le manifeste : rien ne tourne tant que la config
 * n'a pas été lue ici.
 */
async function startReceiver() {
  const gladysUrl = effectiveGladysUrl(config);
  if (!gladysUrl) {
    throw new Error('No Gladys URL available (config empty and derivation failed)');
  }
  logger.info(`Starting the receiver container (core at ${gladysUrl})`);
  await gladys.startContainer(RECEIVER_CONTAINER, {
    env: {
      RECEIVER_GLADYS_URL: gladysUrl,
      RECEIVER_INTERNAL_TOKEN: await phones.internalToken(),
    },
  });
}

/**
 * Boucle de drain des états de capteurs. Démarrée une fois pour toutes : un
 * receiver en cours de redémarrage fait simplement échouer le tour courant
 * (loggué au changement d'état seulement) et le suivant récupère.
 */
function startDrainLoop() {
  if (drainTimer !== null) {
    return;
  }
  drainTimer = setInterval(drainOnce, DRAIN_INTERVAL_MS);
  logger.info(`Sensor states drain loop started (every ${DRAIN_INTERVAL_MS / 1000}s)`);
}

async function drainOnce() {
  if (draining) {
    return;
  }
  draining = true;
  try {
    const response = await fetch(RECEIVER_DRAIN_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${await phones.internalToken()}` },
      signal: AbortSignal.timeout(5000),
    });
    // Un receiver 0.1.0 (image pas encore à jour) répond 404 : silencieux.
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw new Error(`drain answered HTTP ${response.status}`);
    }
    const { devices } = await response.json();
    await phones.processDrain(devices);
    if (!lastDrainOk) {
      lastDrainOk = true;
      logger.info('Sensor states drain recovered');
    }
  } catch (err) {
    if (lastDrainOk) {
      lastDrainOk = false;
      logger.warn(`Sensor states drain failed (${err.message}), will keep retrying`);
    }
  } finally {
    draining = false;
  }
}

/** Reflète la santé du receiver dans l'écran de configuration. */
async function reportHealth() {
  const healthy = await isReceiverHealthy({ retries: 5, delayMs: 1000 });
  await gladys.setConnectionStatus(
    healthy,
    healthy
      ? undefined
      : {
          en: 'The receiver container did not come up.',
          fr: "Le conteneur récepteur n'a pas démarré.",
        },
  );
}

/**
 * Sonde /health du receiver (alias DNS du sous-conteneur sur le réseau privé).
 * @param {{ retries?: number, delayMs?: number }} [options]
 */
async function isReceiverHealthy({ retries = 1, delayMs = 0 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(RECEIVER_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // le conteneur démarre peut-être encore : on retente
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/**
 * Vérifie que le core Gladys répond (n'importe quel statut HTTP < 500 :
 * l'interface web sert la racine, une 404 prouve aussi que le serveur est là).
 * @param {string} gladysUrl
 */
async function isCoreReachable(gladysUrl) {
  try {
    const response = await fetch(gladysUrl, { signal: AbortSignal.timeout(5000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

// --- Arrêt propre -------------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  if (drainTimer !== null) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
});

// --- Démarrage ----------------------------------------------------------------
logger.info('Starting Gladys Phone...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
