// =============================================================================
// Connexion SQLite (better-sqlite3) + schéma de la base locale.
//
// Chaque collection "active" (trades, journal, marchés) a :
//   - une table avec `id TEXT PRIMARY KEY`, `data` (JSON tel que renvoyé par
//     l'API distante, avec id embarqué), `updated_at` (ISO), `dirty` (0/1)
//     qui marque une modification locale pas encore poussée vers le cloud,
//   - la table `deleted_ops` qui sert de pierre tombale pour rejouer les
//     suppressions au prochain passage en ligne,
//   - `screenshots` pour associer chaque capture à un fichier local sur disque
//     (et savoir si elle a déjà été uploadée vers Cloudinary).
//
// Les dates sont toujours stockées en ISO-8601 (UTC) et comparées en chaîne :
// c'est l'approche "last write wins" utilisée par le moteur de synchro.
// =============================================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

function open() {
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(config.IMAGES_DIR)) {
    fs.mkdirSync(config.IMAGES_DIR, { recursive: true });
  }

  const db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Session unique du compte courant : { token, user } comme le localStorage web.
    CREATE TABLE IF NOT EXISTS session (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      token      TEXT NOT NULL,
      user_json  TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Snapshot du profil distant (préférences, forfait) quand il change.
    -- op indique quelle mutation rejouer vers le cloud :
    --   'settings' -> PUT /users/me/settings
    --   'profile'  -> PUT /users/me
    --   'choose'   -> POST /subscriptions/choose
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty      INTEGER NOT NULL DEFAULT 0,
      op         TEXT NOT NULL DEFAULT 'profile'
    );

    CREATE TABLE IF NOT EXISTS trades (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id       TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      file_path TEXT,
      public_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id        TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty     INTEGER NOT NULL DEFAULT 0,
      is_custom INTEGER NOT NULL DEFAULT 0,
      hidden    INTEGER NOT NULL DEFAULT 0
    );

    -- Pierres tombales : suppression locale à rejouer en ligne.
    CREATE TABLE IF NOT EXISTS deleted_ops (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      pushed     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collection, id)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_dirty   ON trades(dirty);
    CREATE INDEX IF NOT EXISTS idx_journal_dirty  ON journal_entries(dirty);
    CREATE INDEX IF NOT EXISTS idx_markets_hidden ON markets(hidden);
    CREATE INDEX IF NOT EXISTS idx_feed_dirty     ON deleted_ops(pushed);
    CREATE INDEX IF NOT EXISTS idx_screens_entries ON screenshots(entry_id);
  `);

  return db;
}

// Encode un objet JSON en ligne de table.
function rowJson(data) {
  return JSON.stringify(data);
}

// Décode une ligne de table en objet, avec son horodatage.
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Lecture + tri des éléments d'une collection (hors pierres tombales).
function list(db, table, sortFn) {
  const rows = db.prepare(`SELECT data FROM ${table}`).all();
  const items = rows.map((r) => parseJson(r.data)).filter(Boolean);
  return sortFn ? items.sort(sortFn) : items;
}

// Compare deux ISO-8601 : retourne 0, 1 ou -1.
function compareIso(a, b) {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

// Une mutation locale en attente est "plus récente" qu'une donnée distante si
// elle est sale OU si sa date locale est postérieure.
function localWins(localRow, remoteUpdatedAt) {
  if (localRow && localRow.dirty) return true;
  if (localRow && compareIso(localRow.updated_at, remoteUpdatedAt) >= 0) return true;
  return false;
}

module.exports = { open, rowJson, parseJson, list, compareIso, localWins };