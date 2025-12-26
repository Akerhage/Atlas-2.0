/* ═══════════════════════════════════════════════════════════════
ATLAS MAIN v2.4
Hanterar: App, Loader, Node-server, IPC, Team Auth & Mallar (SQLite)
═══════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain, globalShortcut, clipboard, session } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const dotenv = require('dotenv');

// === 1. DATABAS-KOPPLING (NYTT) ===
// Vi hämtar funktionerna från din db.js
let dbFuncs = {};
try {
dbFuncs = require('./db');
} catch (e) {
console.error("CRITICAL: Kunde inte ladda db.js", e);
}

// === VARIABLER FÖR READINESS / SERVER_VERSION ===
let serverVersion = 'Väntar...';
let serverReady = false;

// === 2. SINGLE INSTANCE & SERVER DETECTION ===
const isServerProcess = process.argv.includes(path.join(__dirname, 'server.js'));

if (!isServerProcess) {
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
console.log('[SINGLE INSTANCE] En instans körs redan, avslutar...');
app.quit();
} else {
app.on('second-instance', () => {
if (mainWindow) {
if (mainWindow.isMinimized()) mainWindow.restore();
mainWindow.focus();
}
});
}
}

// === 3. VARIABLER & PATHS ===
let loaderWindow = null;
let mainWindow = null;
let serverProcess = null;
let config = {};
const SERVER_PORT = 3001;

function getRendererPath(filename) {
return app.isPackaged 
? path.join(process.resourcesPath, 'Renderer', filename)
: path.join(__dirname, 'Renderer', filename);
}

// Fallback om filerna ligger i roten under utveckling
function getLocalPath(filename) {
return path.join(__dirname, filename);
}

function getResourcePath(filename) {
return app.isPackaged 
? path.join(process.resourcesPath, filename)
: path.join(__dirname, filename);
}

// Miljöinställningar
process.env.LANG = 'sv_SE.UTF-8';
process.env.NODE_NO_WARNINGS = '1';

// Ladda Config & Env
const configPath = getResourcePath('config.json');
if (fs.existsSync(configPath)) {
try {
config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (e) { console.error("Config error", e); }
}

const envPath = getResourcePath('.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

// === 4. SERVER MANAGEMENT ===
function killPort3001() {
return new Promise(resolve => {
const cmd = process.platform === 'win32' 
? `netstat -ano | findstr :${SERVER_PORT}` 
: `lsof -i tcp:${SERVER_PORT} -t`;
exec(cmd, (err, stdout) => {
if (stdout) {
const pid = process.platform === 'win32' ? stdout.match(/LISTENING\s+(\d+)/)?.[1] : stdout.trim();
if (pid) exec(process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`, () => resolve());
else resolve();
} else resolve();
});
});
}

function getAuthHeaders() {
const headers = { 'Content-Type': 'application/json' };
if (process.env.TEAM_USER && process.env.TEAM_PASS) {
const authString = Buffer.from(`${process.env.TEAM_USER}:${process.env.TEAM_PASS}`).toString('base64');
headers['Authorization'] = `Basic ${authString}`;
} else if (config.CLIENT_API_KEY) {
headers['x-api-key'] = config.CLIENT_API_KEY;
}
return headers;
}

// === 5. WINDOW CREATION ===
function createLoaderWindow() {
// Försök hitta loader.html antingen via Renderer-mapp eller rot
let loaderPath = getRendererPath('loader.html');
if (!fs.existsSync(loaderPath)) loaderPath = getLocalPath('loader.html');

loaderWindow = new BrowserWindow({
width: 300, height: 500, frame: false, transparent: true,
alwaysOnTop: true, resizable: false, backgroundColor: '#00000000',
icon: getRendererPath('assets/icons/app/icon.ico'),
webPreferences: { 
preload: fs.existsSync(path.join(__dirname, 'preload-loader.js')) 
? path.join(__dirname, 'preload-loader.js') 
: path.join(__dirname, 'preload.js'),
contextIsolation: true, 
nodeIntegration: false,
sandbox: false
}
});
loaderWindow.loadURL(`file://${loaderPath}`);
}

function createMainWindow() {
if (mainWindow) return;

// Försök hitta index.html
let indexPath = getRendererPath('index.html');
if (!fs.existsSync(indexPath)) indexPath = getLocalPath('index.html');

mainWindow = new BrowserWindow({
width: 1400, height: 1000, show: false,
icon: getRendererPath('assets/icons/app/icon.ico'),
autoHideMenuBar: true,
webPreferences: { 
preload: path.join(__dirname, 'preload.js'), 
contextIsolation: true, 
nodeIntegration: false,
sandbox: false
}
});

// 🟢 NYTT: Hantera CSP Headers från Main Process (Säkerhetsnät)
// Detta tvingar Electron att tillåta script från localhost:3001 (Socket.io)
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
callback({
responseHeaders: {
...details.responseHeaders,
'Content-Security-Policy': [
	"default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:3001; connect-src 'self' http://localhost:* ws://localhost:* https://*.ngrok-free.dev wss://*.ngrok-free.dev;"
]
}
});
});

mainWindow.loadURL(`file://${indexPath}`);

mainWindow.once('ready-to-show', () => {
if (loaderWindow) { 
loaderWindow.close(); 
loaderWindow = null; 
}
mainWindow.show();
mainWindow.focus();
});

// Stängnings-hanterare som krävs för din .bat-fil
mainWindow.on('closed', () => {
mainWindow = null;
app.quit(); 
});
}

// =========================================================================
// 🎹 6. APP LIFECYCLE & SERVER MANAGEMENT
// =========================================================================

app.whenReady().then(async () => {
if (isServerProcess) return;

createLoaderWindow();
await killPort3001();

const serverPath = path.join(__dirname, 'server.js');
const serverEnv = {
...process.env,
NODE_ENV: 'production',
IS_PACKAGED: app.isPackaged ? 'true' : 'false',
PORT: String(SERVER_PORT),
ATLAS_ROOT_PATH: app.isPackaged ? process.resourcesPath : __dirname,
ELECTRON_RUN_AS_NODE: '1'
};

serverProcess = spawn(process.execPath, [serverPath], {
cwd: app.isPackaged ? process.resourcesPath : __dirname,
env: serverEnv,
stdio: ['pipe', 'pipe', 'pipe'],
windowsHide: true
});

// --- SERVER LOG LISTENER (Version Detection) ---
serverProcess.stdout.on('data', d => {
const out = d.toString().trim();
console.log(`[Server]: ${out}`);

// FIX: Matcha den nya loggsträngen och extrahera versionen dynamiskt
if (out.match(/Atlas V2\.0 Server running on port/)) {
const versionMatch = out.match(/\(v(.*?)\)/);

// Om motorn hittar (vX.X.X), använd den, annars fallback till config
serverVersion = versionMatch ? versionMatch[1] : (config.VERSION || '2.5.0');
serverReady = true;

console.log(`[MAIN] Server identifierad som version: ${serverVersion}`);
}
});

serverProcess.stderr.on('data', d => {
console.error(`[Server Error]: ${d.toString().trim()}`);
});

// --- GLOBAL HOTKEYS ---
globalShortcut.register('Control+P', () => {
if (mainWindow) mainWindow.webContents.send('process-clipboard-text', clipboard.readText().trim(), true);
});
globalShortcut.register('Control+Alt+P', () => {
if (mainWindow) mainWindow.webContents.send('process-clipboard-text', clipboard.readText().trim(), false);
});
});

/**
* Stänger ner backend-processen och rensar genvägar
*/
function terminateServerProcess() {
if (serverProcess) {
console.log('[MAIN] Dödar serverProcess...');
serverProcess.kill('SIGTERM');
serverProcess = null;
}
globalShortcut.unregisterAll();
}

// App Events för avslutning
app.on('will-quit', terminateServerProcess);
app.on('window-all-closed', () => {
terminateServerProcess();
if (process.platform !== 'darwin') app.quit();
});
process.on('exit', terminateServerProcess);
process.on('SIGINT', () => {
terminateServerProcess();
process.exit();
});


// =========================================================================
// 📡 7. IPC HANDLERS (BRIDGE & DATA)
// =========================================================================

/**
* Returnerar system- och versionsinformation till Renderer
*/
ipcMain.handle('get-app-info', async () => {
// Vänta på att serverReady blir true (max 2 sekunder)
let attempts = 0;
while (!serverReady && attempts < 20) { 
await new Promise(r => setTimeout(r, 100)); 
attempts++;
}

return {
CLIENT_API_KEY: config.CLIENT_API_KEY,
APP_NAME: config.APP_NAME,
ATLAS_VERSION: config.VERSION || '2.5.0', // Klientens version
SERVER_VERSION: serverVersion             // Dynamiskt fångad från servern
};
});

// --- MALLAR (NU VIA DB) ---
ipcMain.handle('load-templates', async () => {
try { 
// Anropa DB-funktionen direkt
if (dbFuncs.getAllTemplates) {
return await dbFuncs.getAllTemplates();
}
return [];
} catch (err) {
console.error('[IPC] load-templates misslyckades:', err);
return [];
}
});

ipcMain.handle('save-templates', async (_, templates) => {
try { 
// Spara till DB
if (dbFuncs.saveTemplate) {
for (const t of templates) {
await dbFuncs.saveTemplate(t);
}
return { success: true };
}
return { success: false, error: "DB func missing" };
} catch (err) {
return { success: false, error: err.message };
}
});

ipcMain.handle('delete-template', async (_, templateId) => {
try {
if (dbFuncs.deleteTemplate) {
await dbFuncs.deleteTemplate(templateId);
return { success: true };
}
return { success: false, error: "DB func missing" };
} catch (err) {
return { success: false, error: err.message };
}
});

// ==========================================================
// 7.1 INKORG & LOKAL HISTORIK (SQLite)
// ==========================================================

// Spara ett nytt meddelande/chatt i den lokala inkorgen
ipcMain.handle('save-qa', async (_, qaItem) => {
try {
if (dbFuncs.saveLocalQA) {
await dbFuncs.saveLocalQA(qaItem);
return { success: true };
}
return { success: false };
} catch (err) { return { success: false, error: err.message }; }
});

// Ladda alla meddelanden (används för både Inkorg och Arkiv-vyn)
ipcMain.handle('load-qa-history', async () => {
try {
if (dbFuncs.getLocalQAHistory) {
return await dbFuncs.getLocalQAHistory();
}
return [];
} catch (err) { return []; }
});

// Radera ett meddelande permanent från databasen
ipcMain.handle('delete-qa', async (_, qaId) => {
try {
if (dbFuncs.deleteLocalQA) {
await dbFuncs.deleteLocalQA(qaId);
return { success: true };
}
return { success: false };
} catch (err) { return { success: false, error: err.message }; }
});

// NY: Flytta meddelande mellan Inkorg (0) och Arkiv (1)
ipcMain.handle('update-qa-archived-status', async (_, { id, status }) => {
try {
if (dbFuncs.updateQAArchivedStatus) {
await dbFuncs.updateQAArchivedStatus(id, status);
return { success: true };
}
return { success: false, error: "DB function missing" };
} catch (err) { 
return { success: false, error: err.message }; 
}
});

// ==========================================================
// 7.2 TEAM-FUNKTIONER (Live-kö mot Server)
// ==========================================================

// Hämta väntande kunder från servern (port 3001)
ipcMain.handle('team:fetch-inbox', async () => {
try {
const res = await fetch(`http://localhost:${SERVER_PORT}/team/inbox`, { 
method: 'GET', 
headers: getAuthHeaders() 
});
if(!res.ok) throw new Error('Kunde inte hämta inkorg');
return await res.json();
} catch (err) { 
console.error('[Team Inbox] Error:', err); 
return { tickets: [] }; 
}
});

// Ta över ett ärende från kön
ipcMain.handle('team:claim-ticket', async (_, ticketId, agentName) => {
try {
const body = JSON.stringify({ 
conversationId: ticketId,
agentName: agentName 
});

const res = await fetch(`http://localhost:${SERVER_PORT}/team/claim`, { 
method: 'POST', 
headers: getAuthHeaders(), 
body 
});

if(!res.ok) throw new Error('Failed to claim ticket');
return await res.json();
} catch (err) { 
console.error('[Team Claim] Error:', err); 
throw err; 
}
});

// ==========================================================
// 7.3 ÖVRIGA VERKTYG
// ==========================================================

// Skriv text till datorns urklipp
ipcMain.handle('clipboard:write', (_, text) => { 
clipboard.writeText(text); 
return true; 
});

// --- SYSTEM INFO (NYTT) ---
const os = require('os'); // Denna rad kan även ligga högst upp i filen

ipcMain.handle('get-system-username', () => {
// Hämtar inloggat användarnamn från Windows/OS
return os.userInfo().username || 'Agent';
});

// LOADER SIGNAL (VIKTIGT!)
ipcMain.on('loader:done', () => {
console.log('[LOADER] Klar signal mottagen.');
createMainWindow();
});