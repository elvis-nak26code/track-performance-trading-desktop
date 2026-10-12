// =============================================================================
// Point d'entrée du serveur local (processus Node détaché d'Electron).
// Lance : base SQLite (état global + bases par compte), application Express
// sur 127.0.0.1, moteur de synchro.
// =============================================================================

const config = require('../config');
const dbm = require('./db');
const { createApp } = require('./server');
const { createSync } = require('./sync');

const db = dbm.open(); // état global : session + comptes (et migration)
const data = dbm.createDataStore(); // données isolées du compte actif

try {
  const moved = dbm.migrateLegacy(db, data);
  if (moved) {
    // eslint-disable-next-line no-console
    console.log(`[migrate] données de l'ancienne base déplacées vers le compte courant`);
  }
} catch (err) {
  // Ne pas bloquer le démarrage : la migration retentera à la session suivante.
  // eslint-disable-next-line no-console
  console.error('[migrate] échec de la migration, reprise à la prochaine session :', err.message);
}

const sync = createSync(db, data);
const app = createApp(db, { sync, data });

const server = app.listen(config.PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[\u2713] Serveur local BlackTracker prêt sur http://127.0.0.1:${config.PORT}/app/`);
  sync.start();

  const shutdown = () => {
    sync.stop();
    server.close(() => {
      data.close();
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});

server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Impossible de démarrer le serveur local :', err.message);
  process.exit(1);
});