// =============================================================================
// Connexion SQLite (better-sqlite3) + schéma de la base locale.
//
// Depuis la v2 du stockage, les données SONT ISOLÉES PAR COMPTE :
//   - `app.db` (global) ne contient QUE l'état de session et les comptes :
//     meta, session, users. C'est le fichier de "point d'entrée" qui permet
//     de savoir quel compte est actif.
//   - Chaque compte a SA base de données dédiée : <DATA_DIR>/users/<id>.db,
//     avec ses propres tables de données (trades, journal, marchés,
//     stratégies, captures, pierres tombales). Deux comptes sur la même
//     machine ne partagent donc AUCUNE donnée.
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

const SCHEMA_VERSION_KEY = 'schema_version';
const SCHEMA_VERSION = 2;

// Tables de données : présentes dans les bases utilisateur uniquement.
const DATA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    dirty      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS strategies (
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

  CREATE TABLE IF NOT EXISTS deleted_ops (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    deleted_at TEXT NOT NULL,
    pushed     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection, id)
  );

  CREATE INDEX IF NOT EXISTS idx_trades_dirty   ON trades(dirty);
  CREATE INDEX IF NOT EXISTS idx_strategies_dirty ON strategies(dirty);
  CREATE INDEX IF NOT EXISTS idx_journal_dirty  ON journal_entries(dirty);
  CREATE INDEX IF NOT EXISTS idx_markets_hidden ON markets(hidden);
  CREATE INDEX IF NOT EXISTS idx_feed_dirty     ON deleted_ops(pushed);
  CREATE INDEX IF NOT EXISTS idx_screens_entries ON screenshots(entry_id);
`;

// Base globale : session + comptes uniquement.
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
  `);

  // Anciennes bases (avant le stockage par compte) portaient aussi les tables
  // de données dans app.db : tant que la migration n'a pas eu lieu, on garde
  // ce schéma pour pouvoir déplacer les lignes (voir migrateLegacy).
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get(SCHEMA_VERSION_KEY);
  if (!version) {
    db.exec(DATA_SCHEMA);
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));

    // GARDE-FOU MIGRATION : on fige, dès cette première ouverture v2, la liste
    // des comptes qui existaient DÉJÀ avant l'upgrade (contenu de `users` à cet
    // instant, avant tout nouveau login). Seuls ces comptes-là pourront hériter
    // des anciennes tables de données (migrateLegacy). Un compte créé APRÈS
    // l'upgrade (ex. : autre personne sur la même machine) n'y a jamais droit.
    const preUpgradeIds = db.prepare('SELECT id FROM users').all().map((r) => r.id);
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('pre_upgrade_users', ?)"
    ).run(JSON.stringify(preUpgradeIds));
  }

  return db;
}

// Ouvre (ou crée) la base de données DÉDIÉE d'un compte.
function openUserData(userId) {
  const usersDir = path.join(config.DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) fs.mkdirSync(usersDir, { recursive: true });

  const db = new Database(path.join(usersDir, `${userId}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DATA_SCHEMA);
  return db;
}

// Tient la base de données du compte actif : une seule base ouverte à la
// fois. Changer de compte ferme la base précédente et ouvre celle du nouveau.
function createDataStore() {
  let current = null;
  let owner = null;

  return {
    // Retourne la base du compte (mise en cache), null si pas de compte.
    current(userId) {
      if (!userId) return null;
      if (current && current.open && owner === userId) return current;
      if (current) {
        try {
          current.close();
        } catch {
          // base déjà fermée
        }
      }
      owner = userId;
      current = openUserData(userId);
      return current;
    },
    owner() {
      return owner;
    },
    close() {
      if (current) {
        try {
          current.close();
        } catch {
          // base déjà fermée
        }
      }
      current = null;
      owner = null;
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

// Migration UNE FOIS : les anciennes app.db mélangeaient les données de tous
// les comptes dans le même fichier. Si des tables de données existent encore
// dans app.db, on les déplace dans la base du compte courant, puis on les
// supprime du fichier global. Nouveaux comptes => bases vides (isolées).
//
// GARDE-FOU : on ne migre JAMAIS dans un compte qui n'existait pas avant la
// mise à jour (un compte absent de la table `users` = créé après l'upgrade).
// Sans ça, un utilisateur déconnecté au moment du passage à la v2 puis
// créant un NOUVEAU compte récupérerait les données mélangées de l'ancienne
// base. Les tables legacy sont alors simplement conservées en attente qu'un
// compte historique se connecte à nouveau (ou extraites à la main).
function migrateLegacy(state, dataStore) {
  const session = state.prepare('SELECT user_json FROM session WHERE id = 1').get();
  const userId = session ? (JSON.parse(session.user_json).id || null) : null;
  if (!userId) return 0;

  // Déjà migré (tables de données absentes du fichier global) ?
  const table = state.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trades'").get();
  if (!table) return 0;

  // Compte créé après la migration (autre personne sur la même machine, etc.) :
  // on n'attribue PAS les données legacy à ce compte. Règle : le compte doit
  // figurer dans le snapshot des comptes qui existaient AVANT l'upgrade.
  const snapshotRaw = state.prepare("SELECT value FROM meta WHERE key = 'pre_upgrade_users'").get();
  if (snapshotRaw) {
    let known = false;
    try {
      known = JSON.parse(snapshotRaw.value).includes(userId);
    } catch {
      known = false;
    }
    if (!known) return 0;
  } else {
    // Pas de snapshot (upgrade déjà accompli avant ce correctif) : on retombe
    // sur la présence dans `users`, comportement historique.
    const knownUser = state.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
    if (!knownUser) return 0;
  }

  const data = dataStore.current(userId);
  const legacyTables = ['trades', 'strategies', 'journal_entries', 'markets'];
  const move = state.transaction(() => {
    for (const name of legacyTables) {
      const rows = state.prepare(`SELECT * FROM ${name}`).all();
      for (const r of rows) {
        const extra = name === 'markets' ? ', is_custom, hidden' : '';
        data
          .prepare(
            `INSERT OR REPLACE INTO ${name} (id, data, updated_at, dirty${extra}) VALUES (@id, @data, @updated_at, @dirty${extra})`
          )
          .run(r);
      }
    }

    const shots = state.prepare('SELECT * FROM screenshots').all();
    for (const s of shots) {
      data
        .prepare(
          'INSERT OR REPLACE INTO screenshots (id, entry_id, file_path, public_id, updated_at) VALUES (@id, @entry_id, @file_path, @public_id, @updated_at)'
        )
        .run(s);
    }

    const ops = state.prepare('SELECT * FROM deleted_ops').all();
    for (const o of ops) {
      data
        .prepare(
          'INSERT OR REPLACE INTO deleted_ops (collection, id, deleted_at, pushed) VALUES (@collection, @id, @deleted_at, @pushed)'
        )
        .run(o);
    }

    // Quelques indicateurs de synchro de l'ancienne base (best effort).
    for (const key of ['sync_online', 'sync_last_at']) {
      const row = state.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      if (row) {
        data.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, row.value);
      }
    }
  });
  move();

  const now = nowIso();
  state.prepare(
    "INSERT INTO meta (key, value) VALUES ('legacy_migrated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(now);

  // Les tables de données ne doivent plus exister dans le fichier global.
  for (const name of [...legacyTables, 'screenshots', 'deleted_ops']) {
    state.exec(`DROP TABLE IF EXISTS ${name}`);
  }
  return 1;
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

module.exports = {
  open,
  openUserData,
  createDataStore,
  migrateLegacy,
  rowJson,
  parseJson,
  list,
  compareIso,
  localWins,
};