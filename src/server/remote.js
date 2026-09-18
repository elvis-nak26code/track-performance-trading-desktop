// =============================================================================
// Client HTTP vers l'API distante (le "cloud") : utilisé pour
//   - le proxy des routes sensibles de la machine locale (auth, paiement,
//     codes promo) qui exigent impérativement la connexion,
//   - le moteur de synchronisation (push + pull).
// Toutes les fonctions renvoient { ok, status, json } ; `ok` est faux en cas
// d'erreur réseau (hors ligne) comme en cas de réponse HTTP en erreur.
// =============================================================================

const config = require('../config');

async function request(path, { method = 'GET', body = null, token = null, rawJson = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ONLINE_TIMEOUT_MS);

  try {
    // FormData (multipart du journal avec captures) : on le transmet tel quel
    // (sans forcer Content-Type application/json) pour que fetch pose
    // lui-même la boundary multipart, comme le fait le frontend web.
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = {};
    if (body !== null && !rawJson && !isFormData) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(config.REMOTE_API + path, {
      method,
      headers,
      body: rawJson ? body : isFormData ? body : body !== null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
}

function isOnline() {
  return request('/health');
}

module.exports = { request, isOnline };