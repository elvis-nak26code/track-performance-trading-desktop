// =============================================================================
// Configuration de l'application de bureau (desktop/).
//
// Le processus serveur local (src/server/index.js) tourne dans un enfant Node
// classique (pas dans le processus principal Electron) : c'est volontaire, il
// charge des modules natifs compilés pour le Node du système (better-sqlite3)
// sans avoir à recompiler pour l'ABI d'Electron. Le rendu React communique
// avec ce serveur en HTTP sur 127.0.0.1:<port> — exactement le même contrat
// REST que la version web, donc le code frontend reste identique.
// =============================================================================

const path = require('path');
const os = require('os');

// Port local sur lequel le serveur répond. Évite les plages habituelles des
// projets dev (5173, 3000, 8000…) pour minimiser les collisions.
const PORT = Number(process.env.BT_DESKTOP_PORT) || 43127;

// Binaire Node à utiliser pour lancer le processus serveur enfant. Par défaut
// "node" depuis le PATH ; on peut pointer ailleurs via BT_NODE_BIN.
const NODE_BIN = process.env.BT_NODE_BIN || 'node';

// Répertoire racine du projet desktop.
const DESKTOP_ROOT = path.resolve(__dirname, '..');

// Build du frontend réservé au desktop (frontend/dist-desktop), produit par
// `npm run build:desktop` dans frontend/.
const FRONTEND_DIST =
  process.env.BT_FRONTEND_DIST || path.resolve(DESKTOP_ROOT, '..', 'frontend', 'dist-desktop');

// Données locales de l'utilisateur : base SQLite + images stockées sur disque.
// BT_DATA_DIR permet de déplacer ces données (clé USB, dossier synchro, etc.).
const DATA_DIR = process.env.BT_DATA_DIR || path.join(os.homedir(), '.blacktracker');

const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const LOG_PATH = path.join(DATA_DIR, 'logs');

// API distante de référence (le "cloud") vers laquelle on se synchronise.
const REMOTE_API =
  process.env.BT_REMOTE_API || 'https://track-performance-trading-api.onrender.com/api';

// Intervalle (ms) entre deux passes de synchronisation automatique.
const SYNC_INTERVAL_MS = Number(process.env.BT_SYNC_INTERVAL_MS) || 30 * 1000;

// Délai réseau (ms) avant de considérer la connexion perdue.
const ONLINE_TIMEOUT_MS = Number(process.env.BT_ONLINE_TIMEOUT_MS) || 4000;

module.exports = {
  PORT,
  NODE_BIN,
  DESKTOP_ROOT,
  FRONTEND_DIST,
  DATA_DIR,
  IMAGES_DIR,
  DB_PATH,
  LOG_PATH,
  REMOTE_API,
  SYNC_INTERVAL_MS,
  ONLINE_TIMEOUT_MS,
};