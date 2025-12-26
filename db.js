//db.js - Version 1.2

const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./atlas.db');

// KRITISK FIX 1: AKTIVERA WAL-MODE FÖR KONKURRENSHANTERING
// Detta minskar risken för SQLITE_BUSY under samtidiga skrivningar från Express och Electron.
db.configure("busyTimeout", 5000); // Sätt timeout till 5 sekunder

db.run("PRAGMA journal_mode = WAL", (err) => {
if (err) {
console.error('❌ FATAL: Could not enable WAL mode:', err);
process.exit(1);
} else {
console.log('✅ SQLite WAL mode enabled');
}
});

// Räknare för att verifiera att alla tables skapades
let tablesCreated = 0;
const REQUIRED_TABLES = 4; // templates, settings, context_store, chat_v2_state

function checkAllTablesCreated() {
tablesCreated++;
if (tablesCreated === REQUIRED_TABLES) {
console.log('✅ All database tables initialized successfully');
}
}

db.serialize(() => {
// -----------------------------------------------------------------------
// EXISTERANDE TABELLER (RAG / V1) - READ ONLY / NO TOUCH
// -----------------------------------------------------------------------
db.run(`CREATE TABLE IF NOT EXISTS templates (
id INTEGER PRIMARY KEY,
title TEXT,
content TEXT,
group_name TEXT
)`, (err) => {
if (err) {
console.error('❌ FATAL: Could not create templates table:', err);
process.exit(1);
}
console.log('✅ Table "templates" ready');
checkAllTablesCreated();
});

db.run(`CREATE TABLE IF NOT EXISTS settings (
key TEXT PRIMARY KEY,
value TEXT
)`, (err) => {
if (err) {
console.error('❌ FATAL: Could not create settings table:', err);
process.exit(1);
}
console.log('✅ Table "settings" ready');
checkAllTablesCreated();
});

db.run(`CREATE TABLE IF NOT EXISTS context_store (
conversation_id TEXT PRIMARY KEY,
last_message_id INTEGER,
context_data TEXT,
updated_at INTEGER
)`, (err) => {
if (err) {
console.error('❌ FATAL: Could not create context_store table:', err);
process.exit(1);
}
console.log('✅ Table "context_store" ready');
checkAllTablesCreated();
});

// -----------------------------------------------------------------------
// NY V2 TABELL (ISOLERAD STATE)
// -----------------------------------------------------------------------
db.run(`CREATE TABLE IF NOT EXISTS chat_v2_state (
conversation_id TEXT PRIMARY KEY,
human_mode INTEGER DEFAULT 0,
owner TEXT DEFAULT NULL,
updated_at INTEGER
)`, (err) => {
if (err) {
console.error('❌ FATAL: Could not create chat_v2_state table:', err);
process.exit(1);
}
console.log('✅ Table "chat_v2_state" ready');
checkAllTablesCreated();
});

// === TABELL FÖR INKORG/HISTORIK (UPPDATERAD) ===
db.run(`CREATE TABLE IF NOT EXISTS local_qa_history (
id INTEGER PRIMARY KEY,
question TEXT NOT NULL,
answer TEXT NOT NULL,
timestamp INTEGER NOT NULL,
is_archived INTEGER DEFAULT 0  -- 0 = Inkorg, 1 = Arkiv
)`, (err) => {
if (err) console.error('⚠️ Could not create local_qa_history table:', err);
else console.log('✅ Table "local_qa_history" ready with archive support');
});

// -----------------------------------------------------------------------
// ✅ INDEX FÖR TEAM INBOX (PRESTANDA, SÄKER)
// -----------------------------------------------------------------------
db.run(`
CREATE INDEX IF NOT EXISTS idx_inbox_queue
ON chat_v2_state (human_mode, owner, updated_at)
`, (err) => {
if (err) {
console.error('⚠️  WARNING: Could not create inbox index:', err);
console.error('   Team inbox queries will be slower but functional');
} else {
console.log('✅ Index "idx_inbox_queue" ready');
}
});

// =========================================================================
// NY SAAS-LOGIK: AUTH & TEAM (TILLAGT 2024-12-22)
// =========================================================================

// 1. SKAPA USERS TABELL (För inloggning)
db.run(`CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY,
username TEXT UNIQUE,
password_hash TEXT NOT NULL,
role TEXT DEFAULT 'agent',
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
if (err) {
console.error('❌ FATAL: Could not create users table:', err);
process.exit(1);
}
console.log('✅ Table "users" ready');
});

// 2. UPPDATERA INKORG (För Team-funktioner)
// Vi lägger till kolumner säkert (en i taget) för att stödja "Plocka Ärende" och "Arkiv"
const alterColumns = [
"ALTER TABLE local_qa_history ADD COLUMN handled_by INTEGER",
"ALTER TABLE local_qa_history ADD COLUMN handled_at DATETIME",
"ALTER TABLE local_qa_history ADD COLUMN solution_text TEXT",
"ALTER TABLE local_qa_history ADD COLUMN original_question TEXT",
"ALTER TABLE local_qa_history ADD COLUMN is_archived INTEGER DEFAULT 0" // <--- NY RAD HÄR
];

alterColumns.forEach(sql => {
db.run(sql, err => {
// Ignorera fel om kolumnen redan finns (normalt vid omstart)
if (err && !err.message.includes('duplicate column')) {
console.warn('[DB] Column migration warning:', err.message);
}
});
});

});

/**
* Läser ALLA mallar från SQLite.
* Returnerar: Promise<Array<{id, title, content, group_name}>>
*/
db.getAllTemplates = () => {
return new Promise((resolve, reject) => {
// Använder db.all
db.all("SELECT * FROM templates", [], (err, rows) => {
if (err) reject(err);
else resolve(rows);
});
});
};

/**
* Hämtar en session-rad från context_store (RAG)
*/
function getContextRow(conversationId) {
return new Promise((resolve, reject) => {
// Använder db.get
db.get(
`SELECT conversation_id, last_message_id, context_data, updated_at
FROM context_store
WHERE conversation_id = ?`,
[conversationId],
(err, row) => {
if (err) {
reject(err);
} else {
if (row?.context_data) {
try {
row.context_data = JSON.parse(row.context_data);
} catch (e) {
console.error(`[DB] Invalid JSON in context_store[${conversationId}]:`, e);
row.context_data = null;
}
}
resolve(row);
}
}
);
});
}

/**
* Skapar eller uppdaterar en session-rad (RAG)
*/
function upsertContextRow({ conversation_id, last_message_id, context_data, updated_at }) {
return new Promise((resolve, reject) => {
const contextString = context_data ? JSON.stringify(context_data) : null;

// Använder db.run (UPSERT)
db.run(
`INSERT INTO context_store (conversation_id, last_message_id, context_data, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(conversation_id) DO UPDATE SET
last_message_id = excluded.last_message_id,
context_data    = excluded.context_data,
updated_at      = excluded.updated_at`,
[conversation_id, last_message_id, contextString, updated_at],
(err) => {
if (err) reject(err);
else resolve();
}
);
});
}

// -------------------------------------------------------------------------
// V2 ACCESSORS (NYA FUNKTIONER)
// -------------------------------------------------------------------------

/**
* Hämtar V2-state (Human Mode / Owner) för en konversation.
*/
function getV2State(conversationId) {
return new Promise((resolve, reject) => {
// Använder db.get
db.get(
`SELECT conversation_id, human_mode, owner, updated_at
FROM chat_v2_state
WHERE conversation_id = ?`,
[conversationId],
(err, row) => {
if (err) return reject(err);
// Robust default state
if (!row) {
resolve({ conversation_id: conversationId, human_mode: 0, owner: null });
} else {
resolve(row);
}
}
);
});
}

/**
* Aktiverar Human Mode irreversibelt.
* Använder Atomic Upsert.
*/
function setHumanMode(conversationId) {
const now = Math.floor(Date.now() / 1000);
return new Promise((resolve, reject) => {
// Använder db.run (UPSERT)
db.run(
`INSERT INTO chat_v2_state (conversation_id, human_mode, owner, updated_at)
VALUES (?, 1, NULL, ?)
ON CONFLICT(conversation_id) DO UPDATE SET
human_mode = 1,
updated_at = excluded.updated_at`,
[conversationId, now],
(err) => {
if (err) reject(err);
else resolve();
}
);
});
}

/**
* Försöker ta ägarskap för en biljett (Concurrency Safe).
* 
* RACE CONDITION FIX:
* Använder två-stegs process för att garantera atomicitet:
* 1. Säkerställ att raden finns (INSERT OR IGNORE)
* 2. Uppdatera endast om owner är NULL (atomic UPDATE)
* 
* @param {string} conversationId - Chat ID
* @param {string} ownerUser - Agent som försöker claima
* @returns {Promise<boolean>} - True om claim lyckades, false om redan tagen
*/
function claimTicket(conversationId, ownerUser) {
const now = Math.floor(Date.now() / 1000);

return new Promise((resolve, reject) => {
// Steg 1: Säkerställ att raden finns med human_mode = 1
// INSERT OR IGNORE är atomisk - endast EN transaktion kan skapa raden
db.run(
`INSERT OR IGNORE INTO chat_v2_state (conversation_id, human_mode, owner, updated_at)
VALUES (?, 1, NULL, ?)`,
[conversationId, now],
(err) => {
if (err) {
console.error(`[DB] claimTicket step 1 failed for ${conversationId}:`, err);
return reject(err);
}

// Steg 2: Försök uppdatera ENDAST om owner är NULL
// WHERE-klausulen gör detta atomiskt med WAL mode
db.run(
`UPDATE chat_v2_state
SET owner = ?, updated_at = ?
WHERE conversation_id = ? AND owner IS NULL`,
[ownerUser, now, conversationId],
function (err) {
if (err) {
console.error(`[DB] claimTicket step 2 failed for ${conversationId}:`, err);
return reject(err);
}

// this.changes = 1 om vi lyckades uppdatera
// this.changes = 0 om raden redan var claimad av någon annan
const success = this.changes > 0;

if (success) {
console.log(`✅ [DB] ${ownerUser} successfully claimed ${conversationId}`);
} else {
console.log(`⚠️  [DB] ${ownerUser} failed to claim ${conversationId} (already taken)`);
}

resolve(success);
}
);
}
);
});
}


// KRITISK FIX 2: Implementerar den saknade Team Inbox-funktionen.
/**
* Hämtar alla ärenden där Human Mode är aktiverat och ägaren är NULL (olåsta).
* Returnerar: Promise<Array<{conversation_id, human_mode, owner, updated_at}>>
*/
function getTeamInbox() {
return new Promise((resolve, reject) => {
// Använder db.all
db.all(
`SELECT conversation_id, human_mode, owner, updated_at
FROM chat_v2_state
WHERE human_mode = 1 AND owner IS NULL
ORDER BY updated_at ASC`,
[],
(err, rows) => {
if (err) reject(err);
else resolve(rows);
}
);
});
}
// FIX 2 SLUT

// === TEMPLATES (NYA FUNKTIONER) ===
function saveTemplate(template) {
return new Promise((resolve, reject) => {
db.run(
`INSERT OR REPLACE INTO templates (id, title, group_name, content) 
VALUES (?, ?, ?, ?)`,
[template.id, template.title, template.group_name || 'Övrigt', template.content],
(err) => {
if (err) reject(err);
else resolve();
}
);
});
}

function deleteTemplate(templateId) {
return new Promise((resolve, reject) => {
db.run('DELETE FROM templates WHERE id = ?', [templateId], (err) => {
if (err) reject(err);
else resolve();
});
});
}

// === QA HISTORY (INKORG) ===
function saveLocalQA(qaItem) {
return new Promise((resolve, reject) => {
db.run(
`INSERT OR REPLACE INTO local_qa_history (id, question, answer, timestamp, is_archived) 
VALUES (?, ?, ?, ?, ?)`,
[qaItem.id, qaItem.question, qaItem.answer, qaItem.timestamp, qaItem.is_archived || 0],
(err) => {
if (err) reject(err);
else resolve();
}
);
});
}

function getLocalQAHistory(limit = 50) {
return new Promise((resolve, reject) => {
db.all(
'SELECT * FROM local_qa_history ORDER BY timestamp DESC LIMIT ?',
[limit],
(err, rows) => {
if (err) reject(err);
else resolve(rows || []);
}
);
});
}

function deleteLocalQA(qaId) {
return new Promise((resolve, reject) => {
db.run('DELETE FROM local_qa_history WHERE id = ?', [qaId], (err) => {
if (err) reject(err);
else resolve();
});
});
}

function updateQAArchivedStatus(id, status) {
return new Promise((resolve, reject) => {
db.run(
'UPDATE local_qa_history SET is_archived = ? WHERE id = ?',
[status ? 1 : 0, id],
(err) => {
if (err) reject(err);
else resolve();
}
);
});
}

// =========================================================================
// AUTH HELPERS (NYA)
// =========================================================================

/**
* Hämtar användare för inloggning.
* Returnerar: Promise<{id, username, password_hash, role}>
*/
function getUserByUsername(username) {
return new Promise((resolve, reject) => {
db.get("SELECT id, username, password_hash, role FROM users WHERE username = ?",
[username], (err, row) => {
if (err) reject(err);
else resolve(row);
}
);
});
}

/**
* Skapar en ny support-agent.
*/
function createUser(username, passwordHash, role = 'agent') {
return new Promise((resolve, reject) => {
db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
[username, passwordHash, role], function (err) {
if (err) reject(err);
else resolve(this.lastID);
}
);
});
}

module.exports = {
db,
getAllTemplates: db.getAllTemplates,
getContextRow,
upsertContextRow,
getV2State,
setHumanMode,
claimTicket,
getTeamInbox,
saveTemplate,
deleteTemplate,
saveLocalQA,
getLocalQAHistory,
deleteLocalQA,
updateQAArchivedStatus,
// NYA AUTH-FUNKTIONER:
getUserByUsername,
createUser
};