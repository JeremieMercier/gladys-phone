// -----------------------------------------------------------------------------
// Point d'entrée du sous-conteneur « receiver ».
//
// Processus volontairement indépendant du SDK Gladys : il ne reçoit aucune
// variable GLADYS_* — seulement l'URL du core, fournie par le conteneur
// principal au démarrage (RECEIVER_GLADYS_URL). Il écoute le port publié
// déclaré dans le manifeste et transmet chaque position reçue au core.
// Seule entorse à cette indépendance : le logger du SDK, utilitaire sans
// dépendance ni connexion, pour horodater les lignes comme le conteneur
// principal.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { createReceiverServer, createInternalServer } from './src/server.js';
import { createStatesBuffer } from './src/statesBuffer.js';
import { createApiKeyValidator } from './src/apiKeyCache.js';

const gladysBaseUrl = process.env.RECEIVER_GLADYS_URL;
const port = Number(process.env.RECEIVER_PORT ?? 8080);
// Port du plan de contrôle interne : jamais déclaré dans le manifeste, donc
// jamais publié vers l'hôte. Joignable seulement par le conteneur principal
// sur le réseau privé Docker (http://receiver:8091/internal/drain).
const internalPort = Number(process.env.RECEIVER_INTERNAL_PORT ?? 8091);
// Optionnel : absent (main 0.1.0), seules les routes positions sont montées.
const internalToken = process.env.RECEIVER_INTERNAL_TOKEN ?? null;

if (!gladysBaseUrl) {
  logger.error('RECEIVER_GLADYS_URL is required (set by the main container on start)');
  process.exit(1);
}

const servers = [];

const statesBuffer = internalToken ? createStatesBuffer({ log: logger }) : null;

const publicServer = createReceiverServer({
  gladysBaseUrl,
  log: logger,
  ...(internalToken
    ? { statesBuffer, validateApiKey: createApiKeyValidator({ gladysBaseUrl }) }
    : {}),
});
servers.push(publicServer);

publicServer.listen(port, '0.0.0.0', () => {
  logger.info(`Gladys Phone receiver listening on :${port}, forwarding to ${gladysBaseUrl}`);
});

if (internalToken) {
  const internalServer = createInternalServer({ statesBuffer, internalToken, log: logger });
  servers.push(internalServer);
  internalServer.listen(internalPort, '0.0.0.0', () => {
    logger.info(`Internal drain endpoint listening on :${internalPort} (private network only)`);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info(`Received ${signal} -> shutting down`);
    for (const server of servers) {
      server.close();
    }
    // Filet de sécurité si des connexions traînent au-delà du délai du superviseur.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
