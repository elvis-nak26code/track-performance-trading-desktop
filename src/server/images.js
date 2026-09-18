// =============================================================================
// Stockage local des captures d'écran (mode hors-ligne).
//
// Une image ajoutée dans un journal est copiée immédiatement sur disque
// (DATA_DIR/images/<entryId>/<shotId>.<ext>) et sertie sous l'URL locale
// /images/... par le serveur local. Au retour en ligne, le moteur de synchro
// monte le fichier vers Cloudinary via l'API distante puis met à jour les
// métadonnées (public_id + URL) localement. Les images déjà sur Cloudinary
// (poussées auparavant) sont rapatriées dans ce même dossier local lors du
// pull, afin de rester visibles hors connexion.
// =============================================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Chemin absolu du répertoire des images d'une entrée.
function entryDir(entryId) {
  const dir = path.join(config.IMAGES_DIR, String(entryId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Écrit un buffer (nouvelle capture) et renvoie le chemin relatif + l'extension.
function saveBuffer(entryId, shotId, buffer, mime) {
  const ext = MIME_EXT[mime || ''] || 'png';
  const filePath = path.join(entryDir(entryId), `${shotId}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, url: `/images/${entryId}/${shotId}.${ext}` };
}

// Supprime un fichier d'image local (ignoré si le fichier n'existe plus).
function removeFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // fichier déjà absent : rien à faire
  }
}

// Télécharge une image distante (Cloudinary) dans le stockage local.
// Renvoie l'URL locale (ou null si le téléchargement a échoué).
async function downloadToLocal(entryId, shotId, remoteUrl) {
  try {
    const res = await fetch(remoteUrl);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await res.arrayBuffer());
    const { filePath, url } = saveBuffer(entryId, shotId, buffer, mime);
    return { filePath, url };
  } catch {
    return null;
  }
}

module.exports = { saveBuffer, removeFile, downloadToLocal, entryDir };