// =============================================================================
// Moteur de synchronisation hors-ligne (offline-first).
//
// Principe "dernière écriture gagne" (par `updatedAt`) :
//   - PUSH  : chaque modification locale est rejouée vers le cloud (CRUD des
//     trades, journal avec upload des captures vers Cloudinary, marchés
//     personnalisés, préférences) et marquée propre une fois acceptée. Les
//     identifiants créés localement en hors-ligne (UUID) sont réécrits vers
//     ceux renvoyés par le serveur (références mises à jour en cascade).
//   - PULL  : on récupère les données distantes et on les fusionne en local
//     sans écraser une modification locale plus récente ni une suppression.
//   - Les images déjà sur le cloud sont rapatriées dans le dossier local pour
//     rester consultables sans connexion.
//
// Le moteur tourne dans le processus du serveur local (un seul "tenant" :
// le compte courant de la machine).
// =============================================================================

const path = require('path');
const config = require('../config');
const dbm = require('./db');
const remote = require('./remote');
const images = require('./images');

// URL locale d'un fichier d'image à partir de son chemin absolu.
function localUrl(filePath) {
  if (!filePath) return null;
  const rel = path.relative(config.IMAGES_DIR, filePath).split(path.sep).join('/');
  return `/images/${rel}`;
}

// Réécrit un identifiant de trade local vers son identifiant distant, en
// propageant le changement aux entrées de journal liées (celles-ci redeviennent
// sales pour être repoussées avec la référence corrigée).
function remapTradeId(db, oldId, newId) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT data, updated_at, dirty FROM trades WHERE id = ?').get(oldId);
    if (row) {
      const t = JSON.parse(row.data);
      t.id = newId;
      db.prepare('INSERT OR REPLACE INTO trades (id, data, updated_at, dirty) VALUES (?, ?, ?, ?)').run(newId, JSON.stringify(t), row.updated_at, row.dirty);
      db.prepare('DELETE FROM trades WHERE id = ?').run(oldId);
    }
    const entries = db.prepare('SELECT id, data FROM journal_entries').all();
    for (const e of entries) {
      const entry = JSON.parse(e.data);
      if (entry.linkedTradeIds && entry.linkedTradeIds.includes(oldId)) {
        entry.linkedTradeIds = entry.linkedTradeIds.map((id) => (id === oldId ? newId : id));
        db.prepare('UPDATE journal_entries SET data = ?, dirty = 1 WHERE id = ?').run(JSON.stringify(entry), e.id);
      }
    }
    db.prepare("UPDATE deleted_ops SET id = ? WHERE collection = 'trades' AND id = ?").run(newId, oldId);
  });
  tx();
}

// Réécrit l'identifiant local d'une entrée de journal vers l'identifiant distant.
function remapEntryId(db, oldId, newId) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT data, updated_at, dirty FROM journal_entries WHERE id = ?').get(oldId);
    if (row) {
      const e = JSON.parse(row.data);
      e.id = newId;
      db.prepare('INSERT OR REPLACE INTO journal_entries (id, data, updated_at, dirty) VALUES (?, ?, ?, ?)').run(newId, JSON.stringify(e), row.updated_at, row.dirty);
      db.prepare('DELETE FROM journal_entries WHERE id = ?').run(oldId);
    }
    db.prepare('UPDATE screenshots SET entry_id = ? WHERE entry_id = ?').run(newId, oldId);
    db.prepare("UPDATE deleted_ops SET id = ? WHERE collection = 'journal_entries' AND id = ?").run(newId, oldId);
  });
  tx();
}

function createSync(db) {
  let running = false;
  let timer = null;

  function log(message) {
    // eslint-disable-next-line no-console
    console.log(`[sync] ${new Date().toISOString()} ${message}`);
  }

  function getMeta(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  function setMeta(key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  function session() {
    const row = db.prepare('SELECT token, user_json FROM session WHERE id = 1').get();
    if (!row) return null;
    return { token: row.token, user: JSON.parse(row.user_json) };
  }

  // Supprime localement une ligne "créée puis supprimée hors ligne" : elle n'a
  // jamais existé côté serveur, la pierre tombale n'a pas besoin du réseau.
  function dropLocalOnly(table, id) {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    db.prepare('UPDATE deleted_ops SET pushed = 1 WHERE collection = ? AND id = ?').run(table, id);
  }

  // ============================== PUSH =========================================

  async function pushUsers(session) {
    const row = db.prepare("SELECT data, op FROM users WHERE dirty = 1 LIMIT 1").get();
    if (!row) return;
    const user = JSON.parse(row.data);
    const push = {
      settings: () => remote.request('/users/me/settings', { method: 'PUT', body: { rValueDollars: user.settings?.rValueDollars, defaultRiskPercent: user.settings?.defaultRiskPercent }, token: session.token }),
      profile: () => remote.request('/users/me', { method: 'PUT', body: { name: user.name }, token: session.token }),
      choose: () => remote.request('/subscriptions/choose', { method: 'POST', body: { planId: user.plan }, token: session.token }),
    }[row.op || 'profile'];

    const r = await push();
    if (!r.ok) {
      if (r.status !== 0) log(`pousser utilisateur (${row.op}) refusé (${r.status})`);
      return;
    }
    const fresh = r.json?.data;
    if (fresh) {
      db.prepare("UPDATE users SET data = ?, updated_at = ?, dirty = 0 WHERE id = ?").run(JSON.stringify(fresh), new Date().toISOString(), user.id);
      db.prepare('UPDATE session SET user_json = ? WHERE id = 1').run(JSON.stringify(fresh));
    }
  }

  async function pushTrades(session) {
    const rows = db.prepare("SELECT id, data FROM trades WHERE dirty = 1").all();
    for (const row of rows) {
      let id = row.id;
      const data = row.data;
      const tomb = db.prepare("SELECT 1 FROM deleted_ops WHERE collection = 'trades' AND id = ?").get(id);
      if (tomb) {
        dropLocalOnly('trades', id);
        continue;
      }
      const trade = JSON.parse(data);
      let r = await remote.request(`/trades/${id}`, { method: 'PUT', body: trade, token: session.token });
      if (!r.ok && r.status === 0) return; // hors ligne en cours de route
      if (r.status === 404) {
        r = await remote.request('/trades', { method: 'POST', body: trade, token: session.token });
        if (!r.ok) {
          if (r.status !== 0 && r.status !== 201 && r.status !== 200) log(`création trade refusée (${r.status})`);
          return;
        }
        const fresh = r.json?.data;
        if (fresh && fresh.id !== id) remapTradeId(db, id, fresh.id);
        id = fresh ? fresh.id : id;
      } else if (!r.ok) {
        if (r.status !== 0) log(`mise à jour trade refusée (${r.status}) — ${r.json?.message || ''}`.trim());
        continue;
      }
      const fresh = r.json?.data;
      if (fresh) {
        db.prepare("UPDATE trades SET data = ?, updated_at = ?, dirty = 0 WHERE id = ?").run(JSON.stringify(fresh), new Date().toISOString(), fresh.id || id);
      }
    }
  }

  // Construit le multipart équivalent à buildJournalFormData du frontend.
  function buildEntryFormData(entry) {
    const fd = new FormData();
    fd.append('date', entry.date || '');
    fd.append('instrument', entry.instrument || '');
    fd.append('mood', entry.mood || '');
    fd.append('text', entry.text || '');

    const blocks = (entry.blocks || []).map((b) =>
      b.type === 'image' ? { type: 'image', screenshotId: b.screenshotId || '' } : { type: 'text', content: b.content || '' }
    );
    fd.append('blocks', JSON.stringify(blocks));

    const meta = [];
    for (const s of entry.screenshots || []) {
      const sr = db.prepare('SELECT file_path, public_id FROM screenshots WHERE id = ?').get(s.id);
      const isNew = !!(sr?.file_path && !sr.public_id);
      meta.push({ id: s.id, name: s.name || '', caption: s.caption || '', isNew });
      if (isNew && sr?.file_path) {
        fd.append('screenshots', new Blob([require('fs').readFileSync(sr.file_path)], { type: 'image/png' }), `${s.id}.png`);
      }
    }
    fd.append('screenshotMetadata', JSON.stringify(meta));
    fd.append('linkedTradeIds', JSON.stringify(entry.linkedTradeIds || []));
    return fd;
  }

  async function pushJournal(session) {
    const rows = db.prepare("SELECT id, data FROM journal_entries WHERE dirty = 1").all();
    for (let { id } of rows) {
      const tomb = db.prepare("SELECT 1 FROM deleted_ops WHERE collection = 'journal_entries' AND id = ?").get(id);
      if (tomb) {
        dropLocalOnly('journal_entries', id);
        continue;
      }
      const entry = JSON.parse(db.prepare('SELECT data FROM journal_entries WHERE id = ?').get(id).data);
      const fd = buildEntryFormData(entry);
      let r = await remote.request(`/journal-entries/${id}`, { method: 'PUT', body: fd, token: session.token });
      if (!r.ok && r.status === 0) return;
      if (r.status === 404) {
        r = await remote.request('/journal-entries', { method: 'POST', body: fd, token: session.token });
        if (r.ok) {
          const fresh = r.json?.data;
          if (fresh && fresh.id !== id) remapEntryId(db, id, fresh.id);
          if (fresh) id = fresh.id;
        }
      }
      if (!r.ok) {
        if (r.status !== 0) log(`pousser entrée de journal refusé (${r.status})`);
        return;
      }
      const fresh = r.json?.data;
      if (fresh) {
        // On réconcilie les captures locales avec celles renvoyées par le cloud
        // (public_id + URL Cloudinary) tout en conservant le fichier local pour
        // l'affichage hors-ligne.
        for (const remoteShot of fresh.screenshots || []) {
          const local = db.prepare('SELECT file_path, public_id FROM screenshots WHERE id = ?').get(remoteShot.id);
          db.prepare('INSERT OR REPLACE INTO screenshots (id, entry_id, file_path, public_id, updated_at) VALUES (?, ?, ?, ?, ?)').run(
            remoteShot.id,
            fresh.id,
            local?.file_path || null,
            remoteShot.public_id || null,
            new Date().toISOString()
          );
          if (local?.file_path && remoteShot.url) {
            remoteShot.url = localUrl(local.file_path);
          }
        }
        db.prepare("UPDATE journal_entries SET data = ?, updated_at = ?, dirty = 0 WHERE id = ?").run(JSON.stringify(fresh), new Date().toISOString(), fresh.id);
      }
    }
  }

  async function pushMarkets(session) {
    const rows = db.prepare("SELECT id, data FROM markets WHERE dirty = 1 AND is_custom = 1").all();
    for (const { data } of rows) {
      const market = JSON.parse(data);
      const r = await remote.request('/markets', { method: 'POST', body: market, token: session.token });
      if (!r.ok) {
        if (r.status !== 0) log(`création marché refusée (${r.status})`);
        return;
      }
      const fresh = r.json?.data;
      if (fresh) {
        if (fresh.id !== market.id) {
          db.prepare('DELETE FROM markets WHERE id = ?').run(market.id);
        }
        db.prepare('INSERT OR REPLACE INTO markets (id, data, updated_at, dirty, is_custom, hidden) VALUES (?, ?, ?, 0, 1, 0)').run(
          fresh.id,
          JSON.stringify(fresh),
          new Date().toISOString()
        );
      }
    }
  }

  async function pushDeletes(session) {
    const tombRows = db.prepare('SELECT collection, id FROM deleted_ops WHERE pushed = 0').all();
    for (const { collection, id } of tombRows) {
      const map = {
        trades: `/trades/${id}`,
        journal_entries: `/journal-entries/${id}`,
        markets: `/markets/${id}`,
      }[collection];
      if (!map) continue;
      const r = await remote.request(map, { method: 'DELETE', token: session.token });
      if (!r.ok && r.status === 0) return;
      // 404 = l'élément n'existe plus côté cloud (déjà supprimé ou jamais
      // poussé) : la tombstone est acquittée. Toute autre erreur (5xx, 4xx)
      // laisse la pierre tombale en attente pour une prochaine passe.
      if (r.ok || r.status === 404) {
        db.prepare('UPDATE deleted_ops SET pushed = 1 WHERE collection = ? AND id = ?').run(collection, id);
      }
    }
  }

  async function pushAll(session) {
    await pushUsers(session);
    await pushTrades(session);
    await pushJournal(session);
    await pushMarkets(session);
    await pushDeletes(session);
  }

  // ============================== PULL =========================================

  function upsertIfNotLocalNewer(table, id, data, updatedAt, extra = {}) {
    const row = db.prepare(`SELECT data, updated_at, dirty FROM ${table} WHERE id = ?`).get(id);
    if (row && dbm.localWins({ updated_at: row.updated_at, dirty: row.dirty }, updatedAt)) return false;
    db.prepare(
      `INSERT INTO ${table} (id, data, updated_at${Object.keys(extra).length ? ', ' + Object.keys(extra).join(', ') : ''}) VALUES (@id, @data, @updatedAt${Object.keys(extra).length ? ', @' + Object.keys(extra).join(', @') : ''}) ` +
      `ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at${Object.keys(extra).length ? ', ' + Object.keys(extra).map((k) => `${k} = excluded.${k}`).join(', ') : ''}`
    ).run({ id, data, updatedAt, ...extra });
    return true;
  }

  async function pullTrades(session) {
    const r = await remote.request('/trades', { token: session.token });
    if (!r.ok) return;
    for (const t of r.json?.data || []) {
      const tomb = db.prepare("SELECT 1 FROM deleted_ops WHERE collection = 'trades' AND id = ?").get(t.id);
      if (tomb) continue; // supprimé localement, on ne le réimporte pas
      upsertIfNotLocalNewer('trades', t.id, JSON.stringify(t), t.updatedAt);
    }
  }

  async function pullJournal(session) {
    const r = await remote.request('/journal-entries', { token: session.token });
    if (!r.ok) return;
    for (const remoteEntry of r.json?.data || []) {
      const tomb = db.prepare("SELECT 1 FROM deleted_ops WHERE collection = 'journal_entries' AND id = ?").get(remoteEntry.id);
      if (tomb) continue;
      const row = db.prepare('SELECT data, updated_at, dirty FROM journal_entries WHERE id = ?').get(remoteEntry.id);
      if (row && dbm.localWins({ updated_at: row.updated_at, dirty: row.dirty }, remoteEntry.updatedAt)) {
        continue;
      }
      const entry = { ...remoteEntry };
      // Rapatriement des images Cloudinary dans le stockage local.
      for (const shot of entry.screenshots || []) {
        const local = db.prepare('SELECT file_path, public_id FROM screenshots WHERE id = ?').get(shot.id);
        if (!local || !local.file_path) {
          const dl = await images.downloadToLocal(entry.id, shot.id, shot.url);
          const updatedAt = new Date().toISOString();
          if (dl) {
            db.prepare('INSERT OR REPLACE INTO screenshots (id, entry_id, file_path, public_id, updated_at) VALUES (?, ?, ?, ?, ?)').run(
              shot.id,
              entry.id,
              dl.filePath,
              shot.public_id || null,
              updatedAt
            );
            shot.url = localUrl(dl.filePath);
          }
        } else {
          shot.url = localUrl(local.file_path) || shot.url;
        }
      }
      upsertIfNotLocalNewer('journal_entries', entry.id, JSON.stringify(entry), entry.updatedAt);
    }
  }

  async function pullMarkets(session) {
    const r = await remote.request('/markets', { token: session.token });
    if (!r.ok) return;
    for (const m of r.json?.data || []) {
      const local = db.prepare('SELECT data, updated_at, dirty, hidden FROM markets WHERE id = ?').get(m.id);
      if (local?.hidden) continue; // supprimé du catalogue par préférence locale
      if (local && dbm.localWins({ updated_at: local.updated_at, dirty: local.dirty }, m.updatedAt)) continue;
      upsertIfNotLocalNewer('markets', m.id, JSON.stringify(m), m.updatedAt, { is_custom: m.isCustom ? 1 : 0, hidden: 0 });
    }
  }

  async function pullUser(session) {
    const r = await remote.request('/users/me', { token: session.token });
    if (!r.ok || !r.json?.data) return;
    const local = db.prepare('SELECT dirty FROM users WHERE id = ?').get(r.json.data.id);
    if (local?.dirty) return; // modification locale à pousser d'abord
    db.prepare('INSERT OR REPLACE INTO users (id, data, updated_at, dirty, op) VALUES (?, ?, ?, 0, ?)').run(
      r.json.data.id,
      JSON.stringify(r.json.data),
      new Date().toISOString(),
      'profile'
    );
    db.prepare('UPDATE session SET user_json = ? WHERE id = 1').run(JSON.stringify(r.json.data));
  }

  async function pullAll(session) {
    await Promise.all([pullTrades(session), pullJournal(session), pullMarkets(session), pullUser(session)]);
  }

  // ============================== ORCHESTRATION =================================

  async function tick() {
    if (running) return;
    running = true;
    try {
      const s = session();
      if (!s) return;
      const online = await remote.isOnline();
      if (!online.ok) {
        setMeta('sync_online', '0');
        log('hors ligne — la synchronisation sera reprise plus tard');
        return;
      }
      await pushAll(s);
      await pullAll(s);
      setMeta('sync_online', '1');
      setMeta('sync_last_at', new Date().toISOString());
      log('synchronisation terminée');
    } catch (err) {
      log(`erreur de synchro : ${err.message}`);
    } finally {
      running = false;
    }
  }

  // État courant visible par l'interface : en ligne, nombre d'éléments en
  // attente (mutations locales non poussées), dernière synchro réussie.
  function status() {
    const pending =
      (db.prepare('SELECT COUNT(*) AS c FROM trades WHERE dirty = 1').get().c || 0) +
      (db.prepare('SELECT COUNT(*) AS c FROM journal_entries WHERE dirty = 1').get().c || 0) +
      (db.prepare('SELECT COUNT(*) AS c FROM users WHERE dirty = 1').get().c || 0) +
      (db.prepare('SELECT COUNT(*) AS c FROM markets WHERE dirty = 1').get().c || 0) +
      (db.prepare('SELECT COUNT(*) AS c FROM deleted_ops WHERE pushed = 0').get().c || 0);
    return {
      online: getMeta('sync_online') === '1',
      lastSyncAt: getMeta('sync_last_at') || null,
      pending,
    };
  }

  return {
    start() {
      // Première passe un peu après le démarrage, puis à intervalle régulier.
      const delay = config.SYNC_INTERVAL_MS / 6;
      setTimeout(() => tick(), delay);
      timer = setInterval(() => tick(), config.SYNC_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    status,
    _helpers: { remapTradeId, remapEntryId },
  };
}

module.exports = { createSync };