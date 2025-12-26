console.log("🚀 server.js bootar");
const SERVER_VERSION = "2.6.0"; // Definiera versionen här
const express = require('express');
const crypto = require('crypto');
const http = require('http');
const { Server } = require("socket.io");

// === AUTH DEPS ===
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_change_in_prod';

// 1. KONSTANTER OCH TRIGGERS (Måste ligga högst upp)
const HUMAN_TRIGGERS = [
"prata med människa",
"kundtjänst",
"jag vill ha personal",
"människa"
];
const HUMAN_RESPONSE_TEXT = "Jag kopplar dig till en mänsklig kollega.";

// 2. IMPORTER OCH LOGIK
const { 
getUserByUsername, 
createUser,
getAllTemplates, 
getContextRow, 
upsertContextRow,
getV2State,    
setHumanMode,  
claimTicket,
getTeamInbox
} = require('./db');

const { runLegacyFlow } = require('./legacy_engine');

// -------------------------------------------------------------------------
// STATE HELPERS – IDIOTSÄKRA (26/12)
// -------------------------------------------------------------------------
function mergeContext(prev, next) {
if (!next || typeof next !== 'object') return prev;

return {
messages: Array.isArray(next.messages) ? next.messages : prev.messages,
locked_context: next.locked_context ?? prev.locked_context,
linksSentByVehicle: next.linksSentByVehicle ?? prev.linksSentByVehicle
};
}

function assertValidContext(ctx, source = 'unknown') {
if (!ctx) {
console.warn(`⚠️ [STATE] Tom context från ${source}`);
return;
}

if (!Array.isArray(ctx.messages)) {
console.warn(`⚠️ [STATE] messages saknas eller är fel typ (${source})`);
}

if (!ctx.locked_context) {
console.warn(`⚠️ [STATE] locked_context saknas (${source})`);
}

if (!ctx.linksSentByVehicle) {
console.warn(`⚠️ [STATE] linksSentByVehicle saknas (${source})`);
}
}

// 3. CACHE-HANTERING
let cachedTemplates = null;
let templatesLoadedAt = 0;
const TEMPLATE_TTL = 60 * 1000;

async function getTemplatesCached() {
const now = Date.now();
if (!cachedTemplates || now - templatesLoadedAt > TEMPLATE_TTL) {
cachedTemplates = await getAllTemplates();
templatesLoadedAt = now;
}
return cachedTemplates;
}

// 4. SERVER OCH SOCKET SETUP
const app = express();

// -------------------------------------------------------------------------
// MIDDLEWARE: RAW BODY FÖR HMAC
// -------------------------------------------------------------------------
app.use(express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
}
}));

app.use((req, res, next) => {
// Logga inte hela body av säkerhetsskäl, bara metod/url
console.log("🔥 INCOMING:", req.method, req.url);
next();
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- KLISTRA IN DETTA HÄR FÖR ATT TA BORT NGROK-VARNINGEN ---
app.use((req, res, next) => {
res.setHeader('ngrok-skip-browser-warning', 'true');
next();
});

// --- LÄGG TILL DETTA HÄR ---
app.use(express.static('Renderer'));

app.get('/', (req, res) => {
res.sendFile(__dirname + '/Renderer/index.html');
});

// =========================================================================
// AUTH ROUTES (LOGIN)
// =========================================================================
app.post('/api/auth/login', async (req, res) => {
const { username, password } = req.body;

try {
const user = await getUserByUsername(username);
if (!user) {
return res.status(401).json({ error: "Ogiltigt användarnamn eller lösenord" });
}

const validPass = await bcrypt.compare(password, user.password_hash);
if (!validPass) {
return res.status(401).json({ error: "Ogiltigt användarnamn eller lösenord" });
}

// Skapa Token (Giltig 24h)
const token = jwt.sign(
{ id: user.id, username: user.username, role: user.role }, 
JWT_SECRET, 
{ expiresIn: '24h' }
);

res.json({ 
token, 
user: { id: user.id, username: user.username, role: user.role } 
});

} catch (err) {
console.error("Login error:", err);
res.status(500).json({ error: "Serverfel vid inloggning" });
}
});

// TEMPORÄR SEED (Kör en gång för att skapa admin, sen kan du kommentera bort den)
app.post('/api/auth/seed', async (req, res) => {
try {
const { username, password } = req.body;
// Endast tillåtet om inga användare finns (säkerhetsspärr kan läggas till)
const hash = await bcrypt.hash(password, 10);
await createUser(username, hash);
res.json({ message: "User created" });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// 5. SOCKET.IO HANTERARE
// === SOCKET AUTH MIDDLEWARE ===
io.use((socket, next) => {
const token = socket.handshake.auth.token;

if (!token) {
return next(new Error("Authentication error: No token provided"));
}

jwt.verify(token, JWT_SECRET, (err, decoded) => {
if (err) {
return next(new Error("Authentication error: Invalid token"));
}
// VIKTIGT: Vi sparar user på socketen för loggning/access, 
// men vi skickar ALDRIG in detta i legacy_engine.
socket.user = decoded; 
next();
});
});


io.on('connection', (socket) => {

// Ny lyssnare för att själv-tilldela ärenden från Hem-vyn
socket.on('team:assign_self', async (data) => {
try {
const { sessionId, agentName } = data;
// Vi använder dina funktioner från db.js för att sätta human_mode och claima ärendet
await setHumanMode(sessionId); 
await claimTicket(sessionId, agentName);

console.log(`[TEAM] ${agentName} tog ärende ${sessionId} (startat från Hem-vyn)`);
io.emit('team:update', { type: 'ticket_claimed', sessionId, owner: agentName });
} catch (err) {
console.error("Själv-tilldelning misslyckades:", err);
}
});

console.log(`🔌 Client connected: ${socket.id} (User: ${socket.user.username})`);
socket.emit('server:info', { version: SERVER_VERSION });

socket.on('test:echo', (data) => {
socket.emit('test:echo_response', { received: data, serverTime: Date.now() });
});

socket.on('client:message', async (payload) => {
console.log(`[SOCKET] Message from ${socket.id}:`, payload.query);

try {
const { query, sessionId, isFirstMessage } = payload;
if (!query || !sessionId) return;

// --- HUMAN MODE INTERCEPTOR (Helt orörd) ---
const lowerQuery = query.toLowerCase();
const isTrigger = HUMAN_TRIGGERS.some(phrase => lowerQuery.includes(phrase));

if (isTrigger) {
console.log(`[HUMAN-MODE] Trigger detected for ${sessionId}`);
let storedContext = await getContextRow(sessionId);
let contextData = (storedContext && storedContext.context_data) 
? storedContext.context_data 
: { variables: {}, messages: [] };

contextData.messages.push({ role: 'user', content: query });

await upsertContextRow({
conversation_id: sessionId,
last_message_id: (storedContext?.last_message_id || 0) + 1,
context_data: contextData,
updated_at: Math.floor(Date.now() / 1000)
});

await setHumanMode(sessionId);
socket.emit('server:answer', { answer: HUMAN_RESPONSE_TEXT, sessionId: sessionId });
io.emit('team:update', { type: 'human_mode_triggered', sessionId });
return; 
}

const v2State = await getV2State(sessionId);
if (v2State && v2State.human_mode === 1) {
console.log(`[HUMAN-MODE] Bot tyst för ${sessionId}`);
io.emit('team:update', { type: 'client_typing', sessionId });
return; 
}

/* --- FIX: Hämta fullständig kontext (inkl. variabler för RAG) --- */
const now = Math.floor(Date.now() / 1000);
let storedContext = await getContextRow(sessionId);

// ✅ NY STRUKTUR 26/12: Tre toppnivå-nycklar istället för variables-wrapper
let contextData = { 
messages: [], 
locked_context: { city: null, area: null, vehicle: null },
linksSentByVehicle: { AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false }
};

if (storedContext && storedContext.context_data) {
contextData = storedContext.context_data;
// Säkerställ att alla nycklar finns
if (!contextData.messages) contextData.messages = [];
if (!contextData.locked_context) contextData.locked_context = { city: null, area: null, vehicle: null };
if (!contextData.linksSentByVehicle) contextData.linksSentByVehicle = { AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false };
}

/* --- RAG-ÅTERSTÄLLNING: FÖRENKLAD & KORREKT (Gemini Fix) --- */

// ✅ 26/12 Skicka hela contextData direkt (den har redan rätt struktur)
const ragContext = contextData;

console.log("------------------------------------------");
console.log("RAG INPUT (Ska innehålla locked_context + linksSentByVehicle):", JSON.stringify(ragContext));
console.log("------------------------------------------");

contextData.messages.push({ role: 'user', content: query });
const templates = await getTemplatesCached();

// 3. Kör motorn
const result = await runLegacyFlow(
{ query, sessionId, isFirstMessage, sessionContext: contextData.messages },
ragContext,
templates
);

/* --- SÄKERHETSKONTROLL --- */
if (result.new_context?.locked_context) {
console.log("✅ MOTORN RETURNERADE STATE:", JSON.stringify(result.new_context.locked_context));
} else {
console.log("⚠️ VARNING: Motorn returnerade inget locked_context!");
}

/* --- UPPDATERA VARIABLER 1/2: SÄKRAD RAG-ÅTERFÖRING --- */
// ✅ 26/12 Synka ALLA fält från motorn OBS SKALL FINNAS ÄVEN LÄNGRE NER, TA INTE BORT!
assertValidContext(result.new_context, 'ragSync');
contextData = mergeContext(contextData, result.new_context);


console.log("------------------------------------------");
console.log("📥 EFTER SYNK:", JSON.stringify({
locked_context: contextData.locked_context,
messages_count: contextData.messages.length
}));
console.log("------------------------------------------");

// Extrahera svaret säkert
let responseText = (typeof result.response_payload === 'string')
? result.response_payload
: (result.response_payload?.answer || "Inget svar tillgängligt");

contextData.messages.push({ role: 'atlas', content: responseText });

// 4. SPARA TILL DATABAS (V2-struktur)
await upsertContextRow({
conversation_id: sessionId,
last_message_id: (storedContext?.last_message_id || 0) + 1,
context_data: contextData,
updated_at: Math.floor(Date.now() / 1000)
});

// 5. 26/12 SKICKA TILL KLIENT
socket.emit('server:answer', {
answer: responseText,
sessionId: sessionId,
locked_context: contextData.locked_context 
});

io.emit('team:update', { type: 'new_message', sessionId });

} catch (err) {
console.error("❌ Socket Error:", err);
}
});

socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id));
});

// 6. HJÄLPFUNKTION: SKICKA TILL LHC
async function sendToLHC(chatId, message, retries = 3) {
if (!message) return;
const messageText = typeof message === 'string' ? message : (message?.answer || 'Inget svar');
const url = `${process.env.LHC_API_URL}/restapi/v2/chat/sendmessage/${chatId}`;
const auth = Buffer.from(`${process.env.LHC_API_USER}:${process.env.LHC_API_KEY}`).toString('base64');

for (let attempt = 1; attempt <= retries; attempt++) {
try {
const response = await fetch(url, {
method: 'POST',
headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
body: JSON.stringify({ msg: messageText })
});
if (response.ok) return;
} catch (err) {
if (attempt === retries) console.error(`[LHC API] Failed for ${chatId}`);
else await new Promise(r => setTimeout(r, 1000 * attempt));
}
}
}

// -------------------------------------------------------------------------
// AUTH MIDDLEWARE (TEAM) - HÅRDAD
// -------------------------------------------------------------------------
function authenticateToken(req, res, next) {
const authHeader = req.headers['authorization'];
const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer TOKEN"

if (token == null) return res.status(401).json({ error: 'Auth required' });

jwt.verify(token, JWT_SECRET, (err, user) => {
if (err) return res.status(403).json({ error: 'Invalid token' });
req.user = user; // Nu vet vi vem som anropar!
next();
});
}

// -------------------------------------------------------------------------
// HMAC VALIDERING
// -------------------------------------------------------------------------
const SIGNATURE_HEADER = 'x-signature';

function verifyHmac(req) {
const signature = req.headers[SIGNATURE_HEADER];
if (!signature) return false;

const secret = process.env.LHC_WEBHOOK_SECRET;
if (!secret) return false;

const computed = crypto
.createHmac('sha256', secret)
.update(req.rawBody)
.digest('hex');

try {
return crypto.timingSafeEqual(
Buffer.from(signature, 'hex'),
Buffer.from(computed, 'hex')
);
} catch {
return false;
}
}

// -------------------------------------------------------------------------
// ENDPOINT: /search_all (RENDERER CLIENT ONLY) - FIXED STRING HANDLING
// -------------------------------------------------------------------------
app.post('/search_all', async (req, res) => {
console.log("🧪 /search_all HIT", req.body);
const clientKey = req.headers['x-api-key'];
if (clientKey !== process.env.CLIENT_API_KEY) {
return res.status(401).json({ error: 'Ogiltig API-nyckel' });
}
try {
const { query, sessionId, isFirstMessage } = req.body;
if (!query || !query.trim()) return res.status(400).json({ error: 'Tom fråga' });
if (!sessionId) return res.status(400).json({ error: 'sessionId saknas' });

const now = Math.floor(Date.now() / 1000);
const TTL_SECONDS = 60 * 60 * 24 * 30;

let storedContext = await getContextRow(sessionId);

// V2 STATE STRUKTUR 26/12

let contextData = { 
messages: [], 
locked_context: { city: null, area: null, vehicle: null },
linksSentByVehicle: { AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false }
};

let lastMessageId = 0;

if (!storedContext || storedContext.updated_at < now - TTL_SECONDS) {
console.log(`[SESSION] Ny/Reset: ${sessionId}`);
} else {
if (storedContext.context_data) {
contextData = storedContext.context_data;
// Säkerställ att alla nycklar finns
if (!contextData.messages) contextData.messages = [];
if (!contextData.locked_context) contextData.locked_context = { city: null, area: null, vehicle: null };
if (!contextData.linksSentByVehicle) contextData.linksSentByVehicle = { AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false };
}
lastMessageId = storedContext.last_message_id || 0;
}

// 1. Lägg till USER query i historiken
contextData.messages.push({ role: 'user', content: query });

const templates = await getTemplatesCached();

// 2. Kör legacy flow 26/12
const result = await runLegacyFlow(
{ query, sessionId, isFirstMessage, sessionContext: contextData.messages }, 
contextData,  // ✅ HELA OBJEKTET
templates
);

// 3. EXTRAHERA SVARET TILL TEXT (Kritisk fix för "text.replace error")
let responseText = "";
if (typeof result.response_payload === 'string') {
responseText = result.response_payload;
} else if (result.response_payload && result.response_payload.answer) {
responseText = result.response_payload.answer;
} else {
responseText = JSON.stringify(result.response_payload);
}

// 4. Lägg till ATLAS svar i historiken
contextData.messages.push({ role: 'atlas', content: responseText });

/* --- UPPDATERA VARIABLER: 2/2 SÄKRAD RAG-ÅTERFÖRING --- */
assertValidContext(result.new_context, 'ragSync');
contextData = mergeContext(contextData, result.new_context);


// 5. Spara state
await upsertContextRow({
conversation_id: sessionId,
last_message_id: lastMessageId + 1,
context_data: contextData,
updated_at: now
});

// 6. Skicka rent svar till frontend
res.json({
answer: responseText,
sessionId: sessionId,
locked_context: contextData.locked_context,  // ✅ RÄTT!
context: result.response_payload?.context || []
});

} catch (err) {
console.error("❌ /search_all ERROR", err);
res.status(500).json({ error: "Internal Server Error" });
}
});

// -------------------------------------------------------------------------
// ENDPOINT: /team/inbox (FIXAD FÖR ATT INKLUDERA MEDDELANDEN)
// -------------------------------------------------------------------------
app.get('/team/inbox', authenticateToken, async (req, res) => {
try {
// 1. Hämta grundlistan (de som väntar på support)
const tickets = await getTeamInbox(); 

// 2. Koppla på meddelandehistoriken för varje biljett
const ticketsWithMessages = await Promise.all(tickets.map(async (t) => {
// Vi använder den befintliga getContextRow-funktionen från db.js
const stored = await getContextRow(t.conversation_id);

// Extrahera meddelanden om de finns i context_data.messages
const messages = (stored && stored.context_data && stored.context_data.messages) 
? stored.context_data.messages 
: [];

// Returnera biljetten med det nya messages-fältet
return {
...t,
messages: messages,
// Skicka även med sista meddelandet som en preview-sträng
last_message: messages.length > 0 ? messages[messages.length - 1].content : "Ingen text"
};
}));

res.json({ tickets: ticketsWithMessages });
} catch (err) {
console.error("[TEAM] Inbox error:", err);
res.status(500).json({ error: "Database error" });
}
});

// -------------------------------------------------------------------------
// ENDPOINT: /team/claim
// -------------------------------------------------------------------------
app.post('/team/claim', authenticateToken, async (req, res) => {
const { conversationId } = req.body;
if (!conversationId) return res.status(400).json({ error: "Missing conversationId" });

// NYTT: Säkra att vi har ett namn oavsett om man kommer via Basic Auth eller JWT
const agentName = req.teamUser || (req.user ? req.user.username : 'Agent');

try {
// ÄNDRAT: Använder agentName istället för req.teamUser
const success = await claimTicket(conversationId, agentName);

if (success) {
console.log(`[TEAM] ${agentName} claimed ${conversationId}`);

// ÄNDRAT: Skickar agentName till frontend
io.emit('team:update', { type: 'ticket_claimed', sessionId: conversationId, owner: agentName });

res.json({ status: "success", owner: agentName });
} else {
const currentState = await getV2State(conversationId);
res.status(409).json({ 
error: "Ticket already claimed", 
current_owner: currentState ? currentState.owner : 'unknown'
});
}
} catch (err) {
console.error("Claim error:", err);
res.status(500).json({ error: "Database error" });
}
});

// -------------------------------------------------------------------------
// ENDPOINT: /api/templates (FÖR MAIN.JS IPC HANDLER)
// -------------------------------------------------------------------------
app.get('/api/templates', async (req, res) => {
try {
const templates = await getTemplatesCached();
res.json(templates);
} catch (err) {
console.error("[TEMPLATES] Load error:", err);
res.status(500).json({ error: "Database error" });
}
});

// -------------------------------------------------------------------------
// ENDPOINT: /api/templates/save (SPARA/UPPDATERA MALL VIA WEBB)
// -------------------------------------------------------------------------
app.post('/api/templates/save', authenticateToken, (req, res) => {
const { id, title, content, group_name } = req.body;
const { db } = require('./db'); 

const sql = `
INSERT INTO templates (id, title, content, group_name) 
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET 
title = excluded.title, 
content = excluded.content, 
group_name = excluded.group_name
`;

// Använd id från body eller skapa nytt om det saknas
const finalId = id || Date.now();

db.run(sql, [finalId, title, content, group_name], function(err) {
if (err) {
console.error("Template Save Error:", err);
return res.status(500).json({ error: "Kunde inte spara mallen" });
}

cachedTemplates = null; // Rensa cachen (om variabeln finns globalt)
res.json({ status: 'success' });
});
});

// -------------------------------------------------------------------------
// ENDPOINT: /api/inbox/delete (RADERA FRÅGA VIA WEBB)
// -------------------------------------------------------------------------
app.post('/api/inbox/delete', authenticateToken, (req, res) => {
const { conversationId } = req.body;
const { db } = require('./db');

db.serialize(() => {
// 1. Ta bort från context_store
db.run(`DELETE FROM context_store WHERE conversation_id = ?`, [conversationId]);

// 2. Ta bort från chat_v2_state (och skicka svar när detta är klart)
db.run(`DELETE FROM chat_v2_state WHERE conversation_id = ?`, [conversationId], function(err) {
if (err) {
console.error("Delete Error:", err);
return res.status(500).json({ error: "Kunde inte radera ärendet" });
}

// Skicka socket-event om io är definierat
if (typeof io !== 'undefined') {
io.emit('team:update', { type: 'inbox_cleared', sessionId: conversationId });
}

res.json({ status: 'success' });
});
});
});

// -------------------------------------------------------------------------
// ENDPOINT: /api/archive (KORRIGERAD: CALLBACK ISTÄLLET FÖR AWAIT)
// -------------------------------------------------------------------------
app.get('/api/archive', authenticateToken, (req, res) => {
// Vi importerar db-objektet inuti routen för säkerhets skull, eller använd global om den finns.
const { db } = require('./db'); 

const sql = `SELECT * FROM local_qa_history WHERE is_archived = 1 ORDER BY timestamp DESC LIMIT 100`;

// OBS: db.all stöder INTE await. Vi måste använda en callback-funktion.
db.all(sql, [], (err, rows) => {
if (err) {
console.error("Archive DB Error:", err);
return res.status(500).json({ error: "Kunde inte ladda arkivet" });
}
// Här har vi datan (rows)
res.json({ archive: rows });
});
});

// -------------------------------------------------------------------------
// ENDPOINT: WEBHOOK (LHC) – KORRIGERAD ENLIGT TCD
// -------------------------------------------------------------------------
app.post('/webhook/lhc-chat', async (req, res) => {
try {
// 1. HMAC
if (!verifyHmac(req)) {
console.warn("⛔ HMAC verification failed");
return res.status(403).send("Forbidden");
}

const { chat_id, id: incomingId, msg, type: ingestType } = req.body;

// 2. TCD Modul 3: Explicit Ingest Check (MJUKARE VALIDERING)
if (!ingestType || (ingestType !== 'chat' && ingestType !== 'mail')) {
console.error(`[WEBHOOK] Okänd eller saknad ingest-typ: "${ingestType}". Avbryter enligt TCD Sektion 3.`);
return res.status(400).json({ 
error: 'Invalid or missing ingest type',
received: ingestType 
});
}

// Validering
if (!chat_id || !incomingId || !msg) {
return res.json({});
}

// 3. Idempotens
const stored = await getContextRow(chat_id);
const lastMessageId = stored?.last_message_id ?? 0;
if (incomingId <= lastMessageId) {
return res.json({});
}

// 4. Human-Mode Interceptor
const v2State = await getV2State(chat_id);

// A) Redan i Human Mode?
if (v2State && v2State.human_mode === 1) {
console.log(`[HUMAN-MODE] ${chat_id} aktiv. Tyst passivitet från bot.`);
return res.json({}); // Boten gör inget, människa har kontrollen
}

// B) Triggas Human Mode nu?
const lowerMsg = msg.toLowerCase();
const isTrigger = HUMAN_TRIGGERS.some(phrase => lowerMsg.includes(phrase));

if (isTrigger) {
console.log(`[HUMAN-MODE] Aktiveras för ${chat_id}`);

// 1. Spara meddelandet i historiken så att det syns i din Team-kö
let storedContext = await getContextRow(chat_id);
let contextData = (storedContext && storedContext.context_data) 
? storedContext.context_data 
: { variables: {}, messages: [] };

contextData.messages.push({ role: 'user', content: msg });

await upsertContextRow({
conversation_id: chat_id,
last_message_id: incomingId,
context_data: contextData,
updated_at: Math.floor(Date.now() / 1000)
});

// 2. Aktivera mänskligt läge
await setHumanMode(chat_id);

// 3. Skicka bekräftelse till kunden i LHC
await sendToLHC(chat_id, HUMAN_RESPONSE_TEXT);

// 4. Meddela din Electron-app i realtid
io.emit('team:update', { type: 'human_mode_triggered', sessionId: chat_id });

return res.json({}); 
}

// 5. RAG Engine
const now = Math.floor(Date.now() / 1000);
const TTL_SECONDS = 60 * 60 * 24 * 30;

// Extrahera ENBART variablerna (RAG-minnet) från den lagrade kontexten
let ragVariables = {};

// ✅ Använd hela context_data
if (stored && stored.context_data && (now - stored.updated_at) <= TTL_SECONDS) {
ragVariables = stored.context_data;
}

const templates = await getTemplatesCached();

const result = await runLegacyFlow(
{ query: msg, sessionId: chat_id, isFirstMessage: false },
ragVariables, // <--- NU skickas rätt objekt in (city, vehicle etc.)
templates
);

// 6. Hantera Svar
if (result.response_payload === "ESKALERA") {
// Tystnad vid eskalering
return res.json({});
}

// Skapa ett objekt som håller både minne (variables) och historik (messages)
// ✅ 26/12 Bygg från motorn + gamla meddelanden
const updatedContextData = {
messages: (stored && stored.context_data && stored.context_data.messages) ? stored.context_data.messages : [],
locked_context: result.new_context?.locked_context || ragVariables?.locked_context || { city: null, area: null, vehicle: null },
linksSentByVehicle: result.new_context?.linksSentByVehicle || ragVariables?.linksSentByVehicle || { AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false }
};

// Lägg till det aktuella meddelandet från kunden och Atlas svar i historiken
updatedContextData.messages.push({ role: 'user', content: msg });
updatedContextData.messages.push({ role: 'atlas', content: result.response_payload });

// Spara ALLT till databasen
await upsertContextRow({
conversation_id: chat_id,
last_message_id: incomingId,
context_data: updatedContextData, 
updated_at: now
});

// TCD Modul 2: Skicka svar via REST API (MED SÄKER TEXTEXTRAKTION)
await sendToLHC(chat_id, result.response_payload);

// NYTT: Meddela teamet om webhook-trafik
io.emit('team:update', { type: 'webhook_event', sessionId: chat_id });

// Kvittera webhook
res.json({});

} catch (err) {
console.error("Webhook error:", err);
res.status(500).send("Server Error");
}
});

// START
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
// Denna sträng läses av main.js för att extrahera versionsnumret
console.log(`✅ Atlas V2.0 Server running on port ${PORT} (v${SERVER_VERSION})`);
});