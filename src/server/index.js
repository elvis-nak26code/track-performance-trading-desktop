// =============================================================================
// Point d'entrée du serveur local (processus Node détaché d'Electron).
// Lance : base SQLite, application Express sur 127.0.0.1, moteur de synchro.
// =============================================================================

const config = require('../config');
const dbm = require('./db');
const { createApp } = require('./server');
const { createSync } = require('./sync');

const db = dbm.open();
const sync = createSync(db);
const app = createApp(db, { sync });

const server = app.listen(config.PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[\u2713] Serveur local BlackTracker prêt sur http://127.0.0.1:${config.PORT}/app/`);
  sync.start();

  const shutdown = () => {
    sync.stop();
    server.close(() => {
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