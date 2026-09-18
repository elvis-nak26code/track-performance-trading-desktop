// =============================================================================
// Processus principal Electron.
//
// Rôle volontairement limité :
//   1. lancer le serveur local (Node classique) qui héberge la base SQLite et
//      le moteur de synchro — voir src/server/index.js,
//   2. attendre qu'il réponde, puis ouvrir la fenêtre sur
//      http://127.0.0.1:<port>/app/ (le build Vite du frontend en mode desktop),
//   3. tuer le serveur si on quitte.
//
// Toute l'intelligence (données, images, sync) vit dans ce serveur enfant ;
// le rendu React ne fait que de simples appels fetch vers lui, comme en web.
// =============================================================================

const net = require('net');
const path = require('path');
const fs = require('fs');
const { app, Menu, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const config = require('./config');

let serverProc = null;
let mainWindow = null;

// Icône de la fenêtre : la même image que la favicon de la version web.
function resolveIcon() {
  const candidates = [
    path.resolve(config.DESKTOP_ROOT, '..', 'frontend', 'favicon.png'),
    path.resolve(config.DESKTOP_ROOT, '..', 'frontend', 'public', 'favicon.png'),
  ];
  const direct = candidates.find((p) => fs.existsSync(p));
  if (direct) return direct;
  // Repli : favicon hachée produite par le build desktop (dist-desktop/assets).
  try {
    const assets = path.resolve(config.FRONTEND_DIST, 'assets');
    const found = fs.readdirSync(assets).find((f) => f.startsWith('favicon'));
    if (found) return path.join(assets, found);
  } catch {
    // pas de build disponible
  }
  return null;
}

// Vérifie (ouverture de socket) que le serveur local répond déjà.
function checkHealth(port) {
  return new Promise((resolve) => {
    const req = net.connect({ port, host: '127.0.0.1' });
    req.once('connect', () => {
      req.destroy();
      resolve(true);
    });
    req.once('error', () => resolve(false));
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(config.PORT)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function startServer() {
  serverProc = spawn(config.NODE_BIN, [path.join(config.DESKTOP_ROOT, 'src', 'server', 'index.js')], {
    env: {
      ...process.env,
      BT_DESKTOP_PORT: String(config.PORT),
      // En version packagée, le build du frontend est livré dans les ressources
      // (electron-builder extraResources) : on le pointe ici, sinon le serveur
      // chercherait ../frontend/dist-desktop qui n'existe pas dans le package.
      ...(app.isPackaged ? { BT_FRONTEND_DIST: path.join(process.resourcesPath, 'frontend-dist') } : {}),
    },
    stdio: 'inherit',
  });
  serverProc.on('exit', (code) => {
    // eslint-disable-next-line no-console
    console.log(`Le serveur local s'est arrêté (code ${code}).`);
    if (app.isReady()) app.quit();
  });
}

function createWindow() {
  const icon = resolveIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    title: 'BlackTracker',
    icon,
    backgroundColor: '#0b1220',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Les liens externes (paiement Genius Pay, etc.) s'ouvrent dans le navigateur.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Filet de sécurité : toute navigation qui sortirait de l'app locale (ex.
  // window.location.href = payUrl) est bloquée dans la fenêtre Electron et
  // renvoyée vers le navigateur système — le checkout ne s'affiche JAMAIS dans
  // la fenêtre du logiciel.
  const appOrigin = `http://127.0.0.1:${config.PORT}`;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(appOrigin)) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${config.PORT}/app/`);
}

app.whenReady().then(async () => {
  // Pas de barre de menus (Fichier / Édition / Affichage / Fenêtre) : la
  // navigation se fait avec la flèche retour et le bouton actualiser intégrés
  // à l'interface, situés en haut du menu latéral.
  Menu.setApplicationMenu(null);
  startServer();
  const ready = await waitForServer();
  if (!ready) {
    dialog.showErrorBox(
      'BlackTracker',
      `Le serveur local n'a pas démarré sur le port ${config.PORT}. Vérifiez que Node.js est bien installé.`
    );
    app.quit();
    return;
  }
  createWindow();

  // macOS : recrée une fenêtre quand on re-clique sur l'icône du dock.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProc && !serverProc.killed) serverProc.kill();
});