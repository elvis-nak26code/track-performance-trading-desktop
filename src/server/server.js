// =============================================================================
// Serveur HTTP local (127.0.0.1:<port>) pour l'application de bureau.
//
// Il expose EXACTEMENT le même contrat REST que le backend Express distant
// (routes, formats { success, data }, codes d'erreur) mais adossé à la base
// SQLite locale. Le frontend React — celui de la version web aussi — s'y
// connecte sans aucune modification, ce qui garantit que desktop et web
// restent sur le même code.
//
// Les données lues depuis le serveur local sont celles du compte courant
// (session) ; toute écriture est marquée `dirty` et poussée vers le cloud par
// le moteur de synchro (voir sync.js) dès que la connexion revient.
// =============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const config = require('../config');
const dbm = require('./db');
const images = require('./images');
const remote = require('./remote');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MOODS = ['calme', 'confiant', 'frustre', 'avide', 'craintif', 'tilte'];
const MARKET_CATEGORIES = ['action', 'indice', 'forex', 'matiere-premiere', 'crypto', 'synthetique'];
const MARKET_TAGS = ['risk-on', 'risk-off', 'actif-saisonnier', 'sensible-evenements'];

const PLAN_DURATIONS = { essai: 7, mensuel: 30, annuel: 365, lifetime: Infinity };

// -- Petits utilitaires -------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// Décode une ligne de table (JSON) ; renvoie null si le texte est corrompu.
function obj(text) {
  return dbm.parseJson(text);
}

// Erreur JSON uniforme côté local, au même format que l'API distante.
function fail(res, status, message, code) {
  const payload = { success: false, message };
  if (code) payload.code = code;
  res.status(status).json(payload);
}

// Jours restants sur un forfait, identique au frontend (epoch UTC → jour).
function daysRemaining(plan, planStartedAt) {
  const duration = PLAN_DURATIONS[plan] ?? PLAN_DURATIONS.essai;
  if (duration === Infinity) return Infinity;
  if (!planStartedAt) return duration;
  const date = new Date(String(planStartedAt).includes('T') ? planStartedAt : `${planStartedAt}T00:00:00`);
  if (Number.isNaN(date.getTime())) return duration;
  const elapsed = Math.floor((Date.now() - date.getTime()) / 86400000);
  return Math.max(0, duration - elapsed);
}

function planPayload(user) {
  const plan = user.plan || 'essai';
  const planStartedAt = user.planStartedAt || nowIso();
  const remaining = daysRemaining(plan, planStartedAt);
  return {
    plan,
    planStartedAt,
    daysRemaining: remaining,
    isExpired: remaining === 0,
    isLifetime: plan === 'lifetime',
  };
}

// -- Multer : captures d'écran (mêmes règles que le backend distant) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter(_req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Seules les images sont acceptées.'));
    }
    cb(null, true);
  },
});

// -- Fabrique de l'application --------------------------------------------------

function createApp(db, deps = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // ----- Accès session + utilisateur -----------------------------------------

  function getSessionRow() {
    return db.prepare('SELECT token, user_json FROM session WHERE id = 1').get() || null;
  }

  // Retourne l'utilisateur courant depuis la table users (plus fraîche que la
  // session) ; sinon depuis la session elle-même.
  function currentUser() {
    const session = getSessionRow();
    if (!session) return null;
    const row = db.prepare('SELECT data FROM users WHERE id = ?').get(JSON.parse(session.user_json).id);
    if (row) return obj(row.data);
    return obj(session.user_json);
  }

  function saveUser(user) {
    const userJson = JSON.stringify(user);
    db.prepare(
      'INSERT OR IGNORE INTO users (id, data, updated_at, dirty, op) VALUES (?, ?, ?, 0, ?)'
    ).run(user.id, userJson, nowIso(), 'profile');
    db.prepare('UPDATE users SET data = ?, updated_at = ? WHERE id = ?').run(
      userJson,
      nowIso(),
      user.id
    );
    db.prepare(
      'INSERT INTO session (id, token, user_json, updated_at) VALUES (1, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET token = excluded.token, user_json = excluded.user_json, updated_at = excluded.updated_at'
    ).run(getSessionRow()?.token || '', userJson, nowIso());
  }

  function markUserDirty(op) {
    const user = currentUser();
    if (!user) return;
    db.prepare('UPDATE users SET dirty = 1, op = ?, updated_at = ? WHERE id = ?').run(op, nowIso(), user.id);
  }

  // Middleware : valide le bearer token contre la session locale.
  function protect(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    const session = getSessionRow();
    if (scheme !== 'Bearer' || !token || !session || session.token !== token) {
      return fail(res, 401, 'Authentification requise. Jeton manquant ou invalide.');
    }
    req.user = obj(session.user_json);
    next();
  }

  // Middleware : forfait actif (équivalent local de requireActivePlan).
  function requireActivePlan(req, res, next) {
    const user = req.user;
    if (daysRemaining(user.plan, user.planStartedAt) === 0) {
      return fail(res, 403, 'Votre forfait a expiré. Réactivez un forfait pour continuer.', 'PLAN_EXPIRED');
    }
    next();
  }

  // ----- Auth (proxy vers le cloud : nécessite la connexion) ------------------

  async function proxyAuth(req, res, path) {
    const r = await remote.request(path, { method: 'POST', body: req.body });
    if (!r.ok) {
      return res.status(r.status || 503).json(
        r.json || { success: false, message: r.status === 0 ? 'Hors ligne : connexion requise.' : 'Le service distant a répondu avec une erreur.' }
      );
    }
    const { user, token } = r.json?.data || {};
    if (user && token) {
      db.prepare(
        'INSERT INTO session (id, token, user_json, updated_at) VALUES (1, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET token = excluded.token, user_json = excluded.user_json, updated_at = excluded.updated_at'
      ).run(token, JSON.stringify(user), nowIso());
      saveUser(user);
    }
    res.status(r.status).json(r.json);
  }

  app.post('/api/auth/register', async (req, res) => proxyAuth(req, res, '/auth/register'));
  app.post('/api/auth/login', async (req, res) => proxyAuth(req, res, '/auth/login'));
  app.post('/api/auth/google', async (req, res) => proxyAuth(req, res, '/auth/google'));

  // ----- Profil / préférences --------------------------------------------------

  app.get('/api/users/me', protect, (_req, res) => {
    const user = currentUser() || req.user;
    res.json({ success: true, data: user });
  });

  app.put('/api/users/me', protect, (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return fail(res, 400, 'Le nom ne peut pas être vide.');
    const user = { ...currentUser(), name: name.trim() };
    saveUser(user);
    markUserDirty('profile');
    res.json({ success: true, data: user });
  });

  app.put('/api/users/me/settings', protect, (req, res) => {
    const user = currentUser();
    const { rValueDollars, defaultRiskPercent } = req.body;
    const settings = { ...(user.settings || {}), rValueDollars: user.settings?.rValueDollars ?? 500, defaultRiskPercent: user.settings?.defaultRiskPercent ?? 1 };
    if (rValueDollars !== undefined) {
      if (Number(rValueDollars) < 0) return fail(res, 400, 'La valeur de 1R doit être positive.');
      settings.rValueDollars = Number(rValueDollars);
    }
    if (defaultRiskPercent !== undefined) {
      if (Number(defaultRiskPercent) < 0) return fail(res, 400, 'Le risque par défaut doit être positif.');
      settings.defaultRiskPercent = Number(defaultRiskPercent);
    }
    const updated = { ...user, settings };
    saveUser(updated);
    markUserDirty('settings');
    res.json({ success: true, data: updated });
  });

  // ----- Subscriptions ---------------------------------------------------------

  app.get('/api/subscriptions/me', protect, (_req, res) => {
    res.json({ success: true, data: planPayload(currentUser() || _req.user) });
  });

  app.post('/api/subscriptions/choose', protect, async (req, res) => {
    const r = await remote.request('/subscriptions/choose', { method: 'POST', body: { planId: req.body.planId }, token: req.headers.authorization?.split(' ')[1] });
    if (r.ok && r.json?.data) {
      saveUser(r.json.data);
      return res.status(r.status).json(r.json);
    }
    if (!r.ok && r.status === 0) {
      // Hors ligne : on applique localement, le cloud sera mis à jour plus tard.
      const planId = req.body.planId;
      const user = { ...currentUser(), plan: planId, planStartedAt: nowIso().slice(0, 10) };
      saveUser(user);
      markUserDirty('choose');
      return res.json({ success: true, data: user });
    }
    res.status(r.status || 502).json(r.json || { success: false, message: 'Impossible de changer de forfait.' });
  });

  app.post('/api/subscriptions/checkout', protect, async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const r = await remote.request('/subscriptions/checkout', { method: 'POST', body: req.body, token });
    if (r.ok) return res.status(r.status).json(r.json);
    if (r.status === 0) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENT_NOT_CONFIGURED',
        message: 'Le paiement nécessite une connexion Internet. Réessayez une fois connecté.',
      });
    }
    res.status(r.status).json(r.json || { success: false, message: 'Le service de paiement a répondu avec une erreur.' });
  });

  app.post('/api/subscriptions/redeem', protect, async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const r = await remote.request('/subscriptions/redeem', { method: 'POST', body: { code: req.body.code }, token });
    if (r.ok) return res.status(r.status).json(r.json);
    if (r.status === 0) {
      return res.status(400).json({ success: false, code: 'OFFLINE', message: 'Les codes promo nécessitent une connexion Internet.' });
    }
    res.status(r.status).json(r.json || { success: false, message: 'Service distant injoignable.' });
  });

  // ----- Trades -----------------------------------------------------------------

  const TRADE_FIELDS = ['date', 'symbol', 'strategies', 'direction', 'entryPrice', 'exitPrice', 'quantity', 'r', 'pnl'];

  function pickTrade(body) {
    const data = {};
    TRADE_FIELDS.forEach((f) => {
      if (body[f] !== undefined) data[f] = body[f];
    });
    return data;
  }

  function validateTrade(data) {
    if (!data.date || !DATE_REGEX.test(data.date)) return 'La date est requise (format yyyy-MM-dd).';
    if (!data.symbol || !String(data.symbol).trim()) return 'Le symbole est requis.';
    if (!['long', 'short'].includes(data.direction)) return 'La direction doit être long ou short.';
    if (data.entryPrice !== undefined && Number(data.entryPrice) < 0) return "Le prix d'entrée ne peut pas être négatif.";
    if (data.exitPrice !== undefined && Number(data.exitPrice) < 0) return 'Le prix de sortie ne peut pas être négatif.';
    if (data.quantity !== undefined && Number(data.quantity) < 1) return 'La quantité doit être au moins 1.';
    return null;
  }

  function createTradeRow(data) {
    const now = nowIso();
    const trade = {
      id: crypto.randomUUID(),
      ...data,
      symbols: undefined,
      createdAt: now,
      updatedAt: now,
    };
    delete trade.symbols;
    db.prepare('INSERT INTO trades (id, data, updated_at, dirty) VALUES (?, ?, ?, 1)').run(
      trade.id,
      dbm.rowJson(trade),
      now
    );
    return trade;
  }

  app.get('/api/trades', protect, (_req, res) => {
    const deleted = new Set(db.prepare("SELECT id FROM deleted_ops WHERE collection = 'trades'").all().map((r) => r.id));
    const trades = dbm
      .list(db, 'trades')
      .filter((t) => !deleted.has(t.id))
      .sort((a, b) => (a.date === b.date ? String(b.updatedAt).localeCompare(String(a.updatedAt)) : String(b.date).localeCompare(String(a.date))));
    res.json({ success: true, data: trades });
  });

  app.get('/api/trades/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM trades WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Trade introuvable.');
    res.json({ success: true, data: obj(row.data) });
  });

  app.post('/api/trades', protect, (req, res) => {
    const data = pickTrade(req.body);
    const error = validateTrade(data);
    if (error) return fail(res, 400, error);
    res.status(201).json({ success: true, data: createTradeRow(data) });
  });

  app.post('/api/trades/bulk', protect, (req, res) => {
    const { trades } = req.body;
    if (!Array.isArray(trades) || trades.length === 0) {
      return fail(res, 400, "Le champ 'trades' doit être un tableau non vide.");
    }
    const created = trades.map((t) => {
      const data = pickTrade(t);
      const error = validateTrade(data);
      if (error) throw Object.assign(new Error(error), { status: 400 });
      return createTradeRow(data);
    });
    res.status(201).json({ success: true, data: created });
  });

  app.put('/api/trades/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM trades WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Trade introuvable.');
    const data = pickTrade(req.body);
    const error = validateTrade({ ...obj(row.data), ...data });
    if (error) return fail(res, 400, error);
    const now = nowIso();
    const updated = { ...obj(row.data), ...data, updatedAt: now };
    db.prepare('UPDATE trades SET data = ?, updated_at = ?, dirty = 1 WHERE id = ?').run(dbm.rowJson(updated), now, req.params.id);
    res.json({ success: true, data: updated });
  });

  app.delete('/api/trades/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM trades WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Trade introuvable.');
    const now = nowIso();
    db.prepare("INSERT OR REPLACE INTO deleted_ops (collection, id, deleted_at, pushed) VALUES ('trades', ?, ?, 0)").run(req.params.id, now);
    db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
    res.json({ success: true, data: { id: req.params.id } });
  });

  // ----- Journal (multipart, mêmes règles que le cloud) ------------------------

  function parseJsonField(value, fallback = []) {
    if (!value || typeof value !== 'string' || value.trim() === '') return fallback;
    try {
      return JSON.parse(value);
    } catch {
      throw Object.assign(new Error('Données JSON invalides reçues par le serveur.'), { status: 400 });
    }
  }

  function buildBlocks(value, screenshotIds) {
    const parsed = parseJsonField(value, []);
    if (!Array.isArray(parsed)) {
      throw Object.assign(new Error('Le champ "blocks" doit être un tableau.'), { status: 400 });
    }
    const idSet = new Set(screenshotIds);
    return parsed.map((block) => {
      const type = block && block.type === 'image' ? 'image' : 'text';
      if (type === 'image') {
        const screenshotId = String(block.screenshotId || '');
        if (!idSet.has(screenshotId)) {
          throw Object.assign(
            new Error("Le bloc image référence une capture d'écran qui n'existe pas dans cette entrée."),
            { status: 400 }
          );
        }
        const rawWidth = Number(block.width);
        const meta = { type: 'image', screenshotId };
        if (Number.isFinite(rawWidth) && rawWidth > 0) meta.width = rawWidth;
        return meta;
      }
      return { type: 'text', content: String(block.content || '') };
    });
  }

  // Ne garde que les trades liés qui existent vraiment en local.
  function resolveLinkedTrades(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = db.prepare('SELECT id FROM trades WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
    return rows.map((r) => r.id);
  }

  function validateEntry(data) {
    if (!data.date || !DATE_REGEX.test(data.date)) return 'La date est requise (format yyyy-MM-dd).';
    if (!data.instrument || !String(data.instrument).trim()) return "L'instrument concerné est requis.";
    if (!MOODS.includes(data.mood)) return "L'humeur doit être l'une des valeurs attendues.";
    return null;
  }

  // Enregistre une capture envoyée en multipart dans le stockage local.
  function storeScreenshotLocal(entryId, item, file) {
    const id = item?.id || crypto.randomUUID();
    const buf = file ? file.buffer : null;
    const { filePath, url } = images.saveBuffer(entryId, id, buf, file?.mimetype);
    db.prepare('INSERT INTO screenshots (id, entry_id, file_path, public_id, updated_at) VALUES (?, ?, ?, NULL, ?)').run(
      id,
      entryId,
      filePath,
      nowIso()
    );
    return { id, public_id: null, url, name: item?.name || file?.originalname || '', caption: item?.caption || '' };
  }

  app.get('/api/journal-entries', protect, (_req, res) => {
    const deleted = new Set(db.prepare("SELECT id FROM deleted_ops WHERE collection = 'journal_entries'").all().map((r) => r.id));
    const entries = dbm
      .list(db, 'journal_entries')
      .filter((e) => !deleted.has(e.id))
      .sort((a, b) => (a.date === b.date ? String(b.createdAt).localeCompare(String(a.createdAt)) : String(b.date).localeCompare(String(a.date))));
    res.json({ success: true, data: entries });
  });

  app.get('/api/journal-entries/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM journal_entries WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Entrée de journal introuvable.');
    res.json({ success: true, data: obj(row.data) });
  });

  app.post('/api/journal-entries', protect, requireActivePlan, upload.array('screenshots', 6), (req, res) => {
    try {
      const error = validateEntry(req.body);
      if (error) return fail(res, 400, error);

      const entryId = crypto.randomUUID();
      const now = nowIso();
      const metadata = parseJsonField(req.body.screenshotMetadata, []);
      const files = req.files || [];

      const screenshots = [];
      for (let i = 0; i < files.length; i++) {
        screenshots.push(storeScreenshotLocal(entryId, metadata[i], files[i]));
      }

      const blocks = buildBlocks(req.body.blocks, screenshots.map((s) => s.id));
      const linkedTradeIds = resolveLinkedTrades(parseJsonField(req.body.linkedTradeIds, []));

      const entry = {
        id: entryId,
        date: req.body.date,
        instrument: String(req.body.instrument || '').trim(),
        mood: req.body.mood,
        text: req.body.text || '',
        screenshots,
        blocks,
        linkedTradeIds,
        createdAt: now,
        updatedAt: now,
      };
      db.prepare('INSERT INTO journal_entries (id, data, updated_at, dirty) VALUES (?, ?, ?, 1)').run(entryId, dbm.rowJson(entry), now);
      res.status(201).json({ success: true, data: entry });
    } catch (err) {
      return fail(res, err.status || 400, err.message);
    }
  });

  app.put('/api/journal-entries/:id', protect, upload.array('screenshots', 6), (req, res) => {
    try {
      const row = db.prepare('SELECT data FROM journal_entries WHERE id = ?').get(req.params.id);
      if (!row) return fail(res, 404, 'Entrée de journal introuvable.');

      const existing = obj(row.data);
      const metadata = parseJsonField(req.body.screenshotMetadata, []);
      const existingScreenshots = existing.screenshots || [];

      // Anciennes captures non conservées → suppression locale des fichiers.
      const keptIds = metadata.filter((m) => !m.isNew).map((m) => String(m.id)).filter(Boolean);
      for (const shot of existingScreenshots) {
        if (!keptIds.includes(shot.id)) {
          const sr = db.prepare('SELECT file_path FROM screenshots WHERE id = ?').get(shot.id);
          images.removeFile(sr?.file_path);
          db.prepare('DELETE FROM screenshots WHERE id = ?').run(shot.id);
        }
      }

      const screenshots = existingScreenshots
        .filter((s) => keptIds.includes(s.id))
        .map((s) => {
          const item = metadata.find((m) => m.id === s.id);
          return {
            id: s.id,
            public_id: s.public_id,
            url: s.url,
            name: item?.name || s.name || '',
            caption: item?.caption || '',
          };
        });

      // Nouvelles captures : fichiers ↔ métadonnées isNew, dans l'ordre.
      const newMetadata = metadata.filter((m) => m.isNew);
      const files = req.files || [];
      for (let i = 0; i < files.length; i++) {
        screenshots.push(storeScreenshotLocal(existing.id, newMetadata[i], files[i]));
      }

      if (screenshots.length > 6) {
        return fail(res, 400, 'Une entrée ne peut pas contenir plus de 6 captures.');
      }

      const updated = {
        ...existing,
        date: req.body.date !== undefined ? req.body.date : existing.date,
        instrument: req.body.instrument !== undefined ? String(req.body.instrument).trim() : existing.instrument,
        mood: req.body.mood !== undefined ? req.body.mood : existing.mood,
        text: req.body.text !== undefined ? req.body.text : existing.text,
        screenshots,
        blocks: req.body.blocks !== undefined ? buildBlocks(req.body.blocks, screenshots.map((s) => s.id)) : existing.blocks,
        linkedTradeIds:
          req.body.linkedTradeIds !== undefined ? resolveLinkedTrades(parseJsonField(req.body.linkedTradeIds, [])) : existing.linkedTradeIds,
        updatedAt: nowIso(),
      };

      const error = validateEntry(updated);
      if (error) return fail(res, 400, error);

      db.prepare('UPDATE journal_entries SET data = ?, updated_at = ?, dirty = 1 WHERE id = ?').run(dbm.rowJson(updated), updated.updatedAt, existing.id);
      res.json({ success: true, data: updated });
    } catch (err) {
      return fail(res, err.status || 400, err.message);
    }
  });

  app.delete('/api/journal-entries/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM journal_entries WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Entrée de journal introuvable.');
    const entry = obj(row.data);
    const now = nowIso();
    db.prepare("INSERT OR REPLACE INTO deleted_ops (collection, id, deleted_at, pushed) VALUES ('journal_entries', ?, ?, 0)").run(req.params.id, now);
    db.prepare('DELETE FROM journal_entries WHERE id = ?').run(req.params.id);
    // Supprime aussi les fichiers images locaux attachés.
    for (const s of entry.screenshots || []) {
      const sr = db.prepare('SELECT file_path FROM screenshots WHERE id = ?').get(s.id);
      images.removeFile(sr?.file_path);
      db.prepare('DELETE FROM screenshots WHERE id = ?').run(s.id);
    }
    res.json({ success: true, data: { id: req.params.id } });
  });

  // ----- Marchés ----------------------------------------------------------------

  const MARKET_FIELDS = ['symbol', 'name', 'category', 'tags', 'description'];

  function pickMarket(body) {
    const data = {};
    MARKET_FIELDS.forEach((f) => {
      if (body[f] !== undefined) data[f] = body[f];
    });
    return data;
  }

  function validateMarket(data) {
    if (!data.symbol || !data.name || !data.category || !data.description) {
      return 'Symbole, nom, catégorie et description sont requis.';
    }
    if (!MARKET_CATEGORIES.includes(data.category)) return 'Catégorie de marché invalide.';
    if (data.tags && !Array.isArray(data.tags)) return 'Les tags doivent être un tableau.';
    return null;
  }

  app.get('/api/markets', protect, (_req, res) => {
    const rows = db.prepare('SELECT data FROM markets WHERE hidden = 0').all().map((r) => obj(r.data)).filter(Boolean);
    rows.sort((a, b) => (a.category === b.category ? String(a.symbol).localeCompare(String(b.symbol)) : String(a.category).localeCompare(String(b.category))));
    res.json({ success: true, data: rows });
  });

  app.post('/api/markets', protect, (req, res) => {
    const data = pickMarket(req.body);
    const error = validateMarket(data);
    if (error) return fail(res, 400, error);
    const symbol = String(data.symbol).trim().toUpperCase();
    if (db.prepare("SELECT 1 FROM markets WHERE json_extract(data, '$.symbol') = ?").get(symbol)) {
      return fail(res, 409, `Un marché avec le symbole "${symbol}" existe déjà.`);
    }
    const now = nowIso();
    const market = {
      id: crypto.randomUUID(),
      symbol,
      name: String(data.name).trim(),
      category: data.category,
      tags: Array.isArray(data.tags) ? data.tags : [],
      description: String(data.description).trim(),
      isCustom: true,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare('INSERT INTO markets (id, data, updated_at, dirty, is_custom, hidden) VALUES (?, ?, ?, 1, 1, 0)').run(market.id, dbm.rowJson(market), now);
    res.status(201).json({ success: true, data: market });
  });

  app.delete('/api/markets/:id', protect, (req, res) => {
    const row = db.prepare('SELECT data FROM markets WHERE id = ?').get(req.params.id);
    if (!row) return fail(res, 404, 'Marché introuvable.');
    const market = obj(row.data);
    if (market.isCustom) {
      db.prepare("INSERT OR REPLACE INTO deleted_ops (collection, id, deleted_at, pushed) VALUES ('markets', ?, ?, 0)").run(req.params.id, nowIso());
      db.prepare('DELETE FROM markets WHERE id = ?').run(req.params.id);
    } else {
      // Marché de base du catalogue : la suppression reste une préférence locale.
      db.prepare('UPDATE markets SET hidden = 1 WHERE id = ?').run(req.params.id);
    }
    res.json({ success: true, data: market });
  });

  // ----- Synchro (statut visible par la sidebar de l'application) --------------

  app.get('/api/sync/status', protect, (_req, res) => {
    const syncStatus = deps.sync?.status ? deps.sync.status() : { online: null, lastSyncAt: null, pending: 0 };
    res.json({ success: true, data: syncStatus });
  });

  // Déclenche une passe de synchro immédiate (bouton "Synchroniser").
  app.post('/api/sync/now', protect, async (_req, res) => {
    if (!deps.sync) return fail(res, 503, 'Moteur de synchronisation indisponible.');
    try {
      await deps.sync.tick();
      res.json({ success: true, data: deps.sync.status() });
    } catch (err) {
      fail(res, 500, err.message || 'Erreur pendant la synchronisation.');
    }
  });

  // ----- Statique ----------------------------------------------------------------

  app.use('/images', express.static(config.IMAGES_DIR, { maxAge: '365d' }));

  const indexHtml = path.join(config.FRONTEND_DIST, 'index.html');
  if (fs.existsSync(path.join(config.FRONTEND_DIST, 'assets'))) {
    app.use('/app', express.static(config.FRONTEND_DIST));
    app.get('/app/*splat', (_req, res) => {
      if (!fs.existsSync(indexHtml)) return res.status(404).send('Frontend introuvable.');
      res.sendFile(indexHtml);
    });
  }

  app.get('/', (_req, res) => {
    if (fs.existsSync(indexHtml)) return res.redirect('/app/');
    res.json({ success: true, message: 'Serveur local BlackTracker opérationnel.' });
  });

  // Réponses 404 + gestionnaire d'erreurs uniformes pour les routes API.
  app.use('/api', (_req, res) => fail(res, 404, 'Ressource introuvable sur le serveur local.'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : err.code === 'LIMIT_FILE_COUNT' ? 400 : 500);
    fail(res, status, err.message || 'Erreur interne du serveur local.');
  });

  return app;
}

module.exports = { createApp, multerUpload: upload };