/* ═══════════════════════════════════════════════════════════════
ATLAS RENDERER v2.7 (Bugfix: Focus & Inbox UI)
Hanterar: Chatt, Mallar (SQLite), Inkorg (SQLite) & Inställningar
═══════════════════════════════════════════════════════════════ */

const isElectron = (typeof window.electronAPI !== 'undefined');

// === SMART URL (FIXAR BÅDE MOBIL & ELECTRON) ===
// Om Electron: Kör mot localhost. 
// Om Webb/Mobil: Lämna tomt ('' ) så använder den automatiskt Ngrok-adressen.
const SERVER_URL = isElectron ? 'http://localhost:3001' : '';

// === AUTH UI INJECTION (Login Modal) ===
const loginModalHTML = `
<div id="login-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; justify-content:center; align-items:center;">
<div style="background:var(--bg-secondary); padding:40px; border-radius:12px; width:350px; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,0.5);">
<h2 style="margin-bottom:20px; color:var(--text-primary);">Atlas Login</h2>
<form id="login-form" style="display:flex; flex-direction:column; gap:15px;">
<input type="text" id="login-user" placeholder="Användarnamn" required style="padding:12px; border-radius:6px; border:1px solid #444; background:var(--bg-primary); color:white;">
<input type="password" id="login-pass" placeholder="Lösenord" required style="padding:12px; border-radius:6px; border:1px solid #444; background:var(--bg-primary); color:white;">
<button type="submit" style="padding:12px; border-radius:6px; border:none; background:var(--accent-color); color:white; font-weight:bold; cursor:pointer;">Logga in</button>
</form>
<p id="login-error" style="color:#ff6b6b; margin-top:15px; font-size:13px; min-height:18px;"></p>
</div>
</div>
`;
// Injicera modalen när DOM laddas (hanteras nedan i event listener)

// === AUTH STATE ===
let authToken = localStorage.getItem('atlas_token');
let currentUser = JSON.parse(localStorage.getItem('atlas_user') || 'null');

function checkAuth() {
// Om vi kör Electron slipper vi logga in (valfritt, men säkrast att kräva det även där för SaaS-konsistens)
// För nu kräver vi login överallt för att Team-features ska funka.
if (!authToken) {
const modal = document.getElementById('login-modal');
if(modal) modal.style.display = 'flex';
return false;
}
return true;
}

function handleLogout() {
localStorage.removeItem('atlas_token');
localStorage.removeItem('atlas_user');
location.reload();
}

// === SOCKET SETUP (MED AUTH & AUTO-LOADER) ===
let socket = null;

// 1. Definiera en säker standard (Dummy) FÖRST
// Detta gör att anrop till window.socketAPI inte kraschar appen innan anslutning
window.socketAPI = {
isConnected: () => false,
emit: () => console.warn("Socket not ready yet"),
on: () => {}
};

// 2. Funktion för att starta socketen (körs när biblioteket är laddat)
function initializeSocket() {
if (typeof io === 'undefined' || !authToken) return;

console.log("🔌 Initializing Socket.io connection...");

// Skapa socket
socket = io(SERVER_URL || undefined, {
auth: { token: authToken }
});

// VIKTIGT: Uppdatera det globala API:et NU när socketen finns
window.socketAPI = {
isConnected: () => socket && socket.connected,
emit: (event, data) => socket && socket.emit(event, data),
on: (event, cb) => socket && socket.on(event, cb)
};

socket.on('connect', () => {
console.log("🟢 Socket connected!");
updateServerStatusUI(true);
});

socket.on('disconnect', () => {
console.log("🔴 Socket disconnected");
updateServerStatusUI(false);
});

socket.on('connect_error', (err) => {
console.error("Socket Connect Error:", err.message);
if (err.message.includes("Authentication error")) {
handleLogout(); 
}
});

// Aktivera alla lyssnare (Nu när socketAPI pekar rätt)
setupSocketListeners();
}

// Hjälpfunktion för att uppdatera status-texten (Om-sidan)
function updateServerStatusUI(connected) {
const statusEl = document.getElementById('server-status');
if (statusEl) {
statusEl.textContent = connected ? "🟢 LIVE" : "🔴 Frånkopplad";
statusEl.style.color = connected ? "#4cd137" : "#ff6b6b";
}
}

// 3. FIX: Ladda Socket.io-scriptet dynamiskt om det saknas (för Electron)
if (typeof io === 'undefined' && isElectron) {
const script = document.createElement('script');
script.src = `${SERVER_URL}/socket.io/socket.io.js`;
script.onload = () => initializeSocket();
script.onerror = () => console.error("❌ Kunde inte ladda socket.io.js från servern!");
document.head.appendChild(script);
} else {
// Om vi är på webben (där scriptet redan finns i index.html) kör vi direkt
initializeSocket();
}

// 4. Lyssnar-logik
function setupSocketListeners() {
if (!window.socketAPI) return;

// Svar från Atlas
window.socketAPI.on('server:answer', (data) => {
console.log("📥 Mottog svar:", data);
if (State.currentSession) {
State.currentSession.add('atlas', data.answer);
State.currentSession.isFirstMsg = false;
if (data.locked_context) {
State.currentSession.context = data.locked_context;
}
}
addBubble(data.answer, 'atlas');
if (window.electronAPI) window.electronAPI.copyToClipboard(data.answer);
});

// Version info
window.socketAPI.on('server:info', (data) => {
if (DOM.serverVersion) DOM.serverVersion.textContent = data.version;
});

// Errors
window.socketAPI.on('server:error', (err) => {
addBubble(`⚠️ Serverfel: ${err.message}`, 'atlas');
});

// Team Updates
window.socketAPI.on('team:update', (evt) => {
console.log("🔄 Team update:", evt);
updateInboxBadge();

// Uppdatera listan om vi tittar på den
if (DOM.views.inbox && DOM.views.inbox.style.display === 'flex' && State.inboxMode === 'team') {
renderInbox();
}
});
}

const fetchHeaders = {
'Authorization': `Bearer ${authToken}`,
'Content-Type': 'application/json',
'ngrok-skip-browser-warning': 'true'
};

// === 1. GLOBALA INSTÄLLNINGAR & STATE ===
let API_KEY = null;
const API_URL = `${SERVER_URL}/search_all`;

// State Containers
const State = {
    currentSession: null,
    inboxMode: 'local', 
    templates: [],
    localQA: [],
    teamTickets: [] // NY: Sparar alla team-tickets för enkel filtrering
};

// Quill Editor Instance
let quill = null;
let isLoadingTemplate = false;

// === 2. DOM ELEMENT CACHE (För prestanda) ===
const DOM = {
views: {
    chat: document.getElementById('view-chat'),
    templates: document.getElementById('view-templates'),
    inbox: document.getElementById('view-inbox'),
    'my-tickets': document.getElementById('view-my-tickets'), // NY!
    archive: document.getElementById('view-archive'),
    settings: document.getElementById('view-settings')
},
menuItems: document.querySelectorAll('.menu-item'),

// Chatt
chatMessages: document.getElementById('chat-messages'),
messageInput: document.getElementById('message-input'),
chatForm: document.getElementById('chat-form'),
appName: document.getElementById('app-name-display'),

// Mallar
templateList: document.getElementById('template-list'),
templateSearch: document.getElementById('template-search'),
editorForm: document.getElementById('template-editor-form'),
editorPlaceholder: document.getElementById('editor-placeholder'),
inputs: {
id: document.getElementById('template-id-input'),
title: document.getElementById('template-title-input'),
group: document.getElementById('template-group-input'),
content: document.getElementById('template-content-input')
},

// Inkorg
inboxList: document.getElementById('inbox-list'),
inboxDetail: document.getElementById('inbox-detail'),
inboxPlaceholder: document.getElementById('inbox-placeholder'),
inboxQuestion: document.getElementById('inbox-question'),
inboxAnswer: document.getElementById('inbox-answer'),

// Inställningar
themeSelect: document.getElementById('theme-select'),
themeStylesheet: document.getElementById('theme-stylesheet'),
appVersion: document.getElementById('app-version-display'),
serverVersion: document.getElementById('server-version-display'),
serverStatus: document.getElementById('server-status')
};

// ==========================================================
// 3. CHATT MOTOR (Session & Logic)
// ==========================================================

class ChatSession {
constructor() {
this.id = `session_${Date.now()}`;
this.messages = [];
this.startTime = new Date();

// ✅ FIX: Använd server.js-kompatibel struktur
this.context = { 
locked_context: { 
city: null, 
area: null, 
vehicle: null 
},
linksSentByVehicle: {
AM: false,
MC: false,
CAR: false,
INTRO: false,
RISK1: false,
RISK2: false
}
};

this.isFirstMsg = true;
}

add(role, text) {
this.messages.push({ role, text, timestamp: new Date() });
}

getContextHistory() {
return this.messages.map(m => ({ 
role: m.role, 
content: m.text 
})).slice(-10); // Skicka bara sista 10 för context window
}

getFullText() {
return this.messages.map(m => 
`${m.role === 'user' ? 'Användare' : 'Atlas'}: ${m.text}`
).join('\n\n');
}
}

function initChat() {
// Spara gammal session om den finns
if (State.currentSession && State.currentSession.messages.length > 0) {
saveLocalQA(State.currentSession);
}

// --- Skapa ny session ---
State.currentSession = new ChatSession(); // Genererar unikt id i konstruktorn
DOM.chatMessages.innerHTML = '';

// Lägg till startmeddelande
addBubble('Hej! Jag är Atlas, din körkortsguide 🚗✨<br>Vad funderar du på idag?', 'atlas');

// Logga session
console.log('[CHAT] Ny session startad:', State.currentSession.id);
}

async function handleUserMessage(text) {
if (!text.trim()) return;

// 1. UI Update (Visa användarens meddelande direkt)
State.currentSession.add('user', text);
addBubble(text, 'user');
DOM.messageInput.value = '';

// 2. Skicka via Socket.IO
if (window.socketAPI && window.socketAPI.isConnected()) {
try {
const payload = {
query: text,
sessionId: State.currentSession.id,
isFirstMessage: State.currentSession.isFirstMsg,
// Skicka context (viktigt för RAG)
context: State.currentSession.context 
};

// Om detta är första meddelandet och vi är inloggade, tagga som "mitt"
if (State.currentSession.isFirstMsg && currentUser) {
    window.socketAPI.emit('team:assign_self', { 
        sessionId: State.currentSession.id, 
        agentName: currentUser.username 
    });
}

// Skicka iväg - svaret hanteras asynkront i 'server:answer'-lyssnaren
window.socketAPI.emit('client:message', payload);

} catch (err) {
console.error(err);
addBubble(`⚠️ Kunde inte skicka via socket: ${err.message}`, 'atlas');
}
} else {
addBubble("⚠️ Ingen anslutning till servern.", 'atlas');
console.error("Socket not connected.");
}
}

function addBubble(text, role) {
const wrapper = document.createElement('div');
wrapper.className = `message ${role}`;

const bubble = document.createElement('div');
bubble.className = 'bubble';

// Markdown-lite parsing
let html = text
.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
.replace(/\n/g, '<br>')
.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="atlas-link">$1</a>');

bubble.innerHTML = html;
wrapper.appendChild(bubble);
DOM.chatMessages.appendChild(wrapper);
DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight;
}

// ==========================================================
// 4. UNIFIED INBOX (Local + Team) - KORRIGERAD VERSION
// ==========================================================

function renderInbox() {
DOM.inboxList.innerHTML = '';

// 1. Skapa Flik-kontroller
const controls = document.createElement('div');
controls.className = 'inbox-mode-controls';
controls.innerHTML = `
<button id="tab-local" class="inbox-mode-btn ${State.inboxMode === 'local' ? 'active' : ''}">Meddelanden</button>
<button id="tab-team" class="inbox-mode-btn ${State.inboxMode === 'team' ? 'active' : ''}">Team Kö (Live)</button>
`;
DOM.inboxList.appendChild(controls);

document.getElementById('tab-local').onclick = () => { State.inboxMode = 'local'; renderInbox(); };
document.getElementById('tab-team').onclick = () => { State.inboxMode = 'team'; renderInbox(); };

// 2. Innehållscontainer
const listContainer = document.createElement('div');
listContainer.className = 'inbox-content-list';
DOM.inboxList.appendChild(listContainer);

// 3. Rendera vald vy
if (State.inboxMode === 'local') {
renderLocalHistory(listContainer);
} else {
renderTeamQueue(listContainer);
}
}

async function renderMyTickets() {
    const container = document.getElementById('my-tickets-list');
    container.innerHTML = '';

    try {
        // Hämta färska ärenden
        const res = await fetch(`${SERVER_URL}/team/inbox`, { headers: fetchHeaders });
        const data = await res.json();
        State.teamTickets = data.tickets || [];

        // Filtrera fram bara mina (där owner matchar inloggad användare)
        const myOwn = State.teamTickets.filter(t => t.owner === currentUser.username);

        if (myOwn.length === 0) {
            container.innerHTML = '<div class="template-item-empty">Du har inte plockat några ärenden än.</div>';
            return;
        }

        myOwn.forEach(t => {
            const displayId = t.conversation_id.replace('session_', '').substring(0, 6);
            const el = document.createElement('div');
            el.className = 'template-item active-mine'; // Vi kan styla denna i CSS sen
            
            el.innerHTML = `
                <div style="display:flex; justify-content:space-between; width:100%;">
                    <span class="ticket-tag" style="background:var(--accent-primary); color:white;">DIN</span>
                    <span style="font-size:11px; opacity:0.7;">#${displayId}</span>
                </div>
                <span class="template-title">${t.last_message?.substring(0, 30)}...</span>
            `;

            el.onclick = () => openMyTicketDetail(t);
            container.appendChild(el);
        });
    } catch (err) {
        console.error("Mina ärenden fel:", err);
    }
}

// Renderar konversationen snyggt med bubblor i "Mina ärenden"-vyn
function openMyTicketDetail(ticket) {
    const detail = document.getElementById('my-ticket-detail');
    const chatArea = document.getElementById('my-ticket-chat-area');
    const placeholder = document.getElementById('my-detail-placeholder');

    if (!detail || !chatArea || !placeholder) return;

    // 1. Dölj placeholder och visa detaljvyn
    placeholder.style.display = 'none';
    detail.style.display = 'flex';
    
    // 2. Sätt ID:t på containern så att arkiveringsknappen vet vilket ärende som hanteras
    detail.setAttribute('data-current-id', ticket.conversation_id);

    // 3. Rensa gammal chatt och rendera nya bubblor
    chatArea.innerHTML = '';

    if (ticket.messages && ticket.messages.length > 0) {
        ticket.messages.forEach(m => {
            const role = m.role === 'user' ? 'user' : 'atlas';
            const wrapper = document.createElement('div');
            wrapper.className = `message ${role}`;
            
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            // formatAtlasMessage ser till att länkar och fetstil visas korrekt
            bubble.innerHTML = formatAtlasMessage(m.content);
            
            wrapper.appendChild(bubble);
            chatArea.appendChild(wrapper);
        });
    } else if (ticket.last_message) {
        // Fallback om bara sista meddelandet finns
        chatArea.innerHTML = `<div class="message user"><div class="bubble">${formatAtlasMessage(ticket.last_message)}</div></div>`;
    }

    // 4. Skrolla ner till senaste meddelandet
    chatArea.scrollTop = chatArea.scrollHeight;
}

// --- Local History Logic (SQLite Integration) ---
async function saveLocalQA(session) {
const q = session.messages.find(m => m.role === 'user');
const a = [...session.messages].reverse().find(m => m.role === 'atlas'); 

if (q && a) {
const item = {
id: State.currentSession.id || Date.now(), // Använd sessionens riktiga ID
question: q.text,
answer: session.getFullText(), 
timestamp: Date.now(),
is_archived: 0
};

if (window.electronAPI) {
try {
await window.electronAPI.saveQA(item);
console.log('[QA] Sparat till databas:', item.id);
} catch (err) {
console.error('[QA] Kunde inte spara:', err);
}
}

State.localQA.unshift(item); 
if (State.localQA.length > 50) State.localQA.pop(); 
}
}

async function renderLocalHistory(container) {
container.innerHTML = '';

if (window.electronAPI) {
try {
const allHistory = await window.electronAPI.loadQAHistory();
State.localQA = allHistory.filter(item => !item.is_archived || item.is_archived === 0);
} catch (err) {
console.error('[QA] Kunde inte ladda historik:', err);
State.localQA = [];
}
}

if (!State.localQA || State.localQA.length === 0) {
container.innerHTML = '<div class="template-item-empty">Inga nya meddelanden.</div>';
return;
}

State.localQA.forEach(qa => {
const el = document.createElement('div');
el.className = 'template-item';

const isChat = qa.answer && qa.answer.includes('Användare:');
const typeLabel = isChat ? 'CHATT' : 'MAIL';
const typeClass = isChat ? 'tag-chatt' : 'tag-form';

el.innerHTML = `
<div style="display:flex; justify-content:space-between; width:100%; margin-bottom:5px;">
<span class="ticket-tag ${typeClass}">${typeLabel}</span>
<span style="font-size:11px; opacity:0.7;">${new Date(qa.timestamp).toLocaleDateString()}</span>
</div>
<div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
<span class="template-title" style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${qa.question}</span>
<button class="delete-qa-btn" data-id="${qa.id}" style="background:none; border:none; color:#ff6b6b; cursor:pointer; font-size:16px; padding:5px;">✕</button>
</div>
`;

// FIX: Skicka med ID (qa.id) så Radera-knappen vet vad den ska ta bort
el.addEventListener('click', (e) => {
if (!e.target.classList.contains('delete-qa-btn')) {
openInboxDetail(qa.question, qa.answer, qa.id);
}
});

const delBtn = el.querySelector('.delete-qa-btn');
delBtn.addEventListener('click', async (e) => {
e.stopPropagation();

const confirmed = await atlasConfirm('Radera', 'Vill du ta bort detta objekt permanent?');
if (confirmed) {
try {
if (isElectron) {
await window.electronAPI.deleteQA(qa.id);
} else {
const res = await fetch(`${SERVER_URL}/api/inbox/delete`, {
method: 'POST',
headers: fetchHeaders,
body: JSON.stringify({ conversationId: qa.id })
});
if (!res.ok) throw new Error("Kunde inte radera via webben");
}

// Rensa detaljvyn om det var detta objektet som var öppet
if (DOM.inboxQuestion.getAttribute('data-current-id') === String(qa.id)) {
DOM.inboxDetail.style.display = 'none';
DOM.inboxPlaceholder.style.display = 'flex';
}
renderInbox();
} catch (err) {
console.error('[QA] Kunde inte ta bort:', err);
alert("Fel: " + err.message);
}
}
});
container.appendChild(el);
});
}

async function renderTeamQueue(container) {
    container.innerHTML = '<div class="template-item-empty">Laddar ärenden...</div>';

    try {
        const res = await fetch(`${SERVER_URL}/team/inbox`, { headers: fetchHeaders });
        if (!res.ok) throw new Error("Kunde inte ladda kön (Inloggning saknas)");

        const data = await res.json();
        container.innerHTML = '';

        if (!data.tickets || data.tickets.length === 0) {
            container.innerHTML = '<div class="template-item-empty">Kön är tom! 🎉</div>';
            return;
        }

        data.tickets.forEach(t => {
            // Logik för att se vem som äger ärendet
            const isMine = t.owner === currentUser.username;
            const isTaken = t.owner && t.owner.length > 0;
            
            const displayId = t.conversation_id.replace('session_', '').substring(0, 6);
            const timeStr = new Date(t.updated_at * 1000).toLocaleTimeString('sv-SE', {
                hour: '2-digit', minute: '2-digit'
            });

            const card = document.createElement('div');
            // Om det är mitt blir kanten grön (.mine), annars standard
            card.className = `team-ticket-card ${isMine ? 'mine' : ''}`;
            card.style.cursor = 'pointer'; 

            // Här skapar vi den snygga taggen med agentens namn (t.ex. LISA)
            const ownerTag = t.owner 
                ? `<span class="ticket-tag" style="background:var(--accent-primary); color:white; border:none;">${t.owner.toUpperCase()}</span>` 
                : `<span class="ticket-tag tag-chatt">CHATT</span>`;

            card.innerHTML = `
                <div class="team-ticket-header">
                    ${ownerTag}
                    <span>${timeStr}</span>
                </div>
                <div class="team-ticket-meta">
                    <span class="ticket-customer-info">#${displayId}</span>
                    <span class="ticket-preview-text">${t.last_message?.substring(0, 40) || 'Nytt ärende'}...</span>
                </div>
                ${!isTaken ? `<button class="team-claim-btn" data-id="${t.conversation_id}" style="margin-top:8px;">PLOCKA ÄRENDE</button>` : ''}
            `;

            card.onclick = () => {
                let chatHistory = "";
                if (t.messages && t.messages.length > 0) {
                    chatHistory = t.messages.map(m => {
                        const sender = m.role === 'user' ? 'ANVÄNDARE' : 'ATLAS';
                        return `${sender}: ${m.content}`;
                    }).join('\n\n');
                } else {
                    chatHistory = t.last_message || "Ingen meddelandehistorik tillgänglig.";
                }
                openInboxDetail(`Ärende #${displayId}`, chatHistory, t.conversation_id);
            };

            const btn = card.querySelector('.team-claim-btn');
            if (btn) {
                btn.onclick = async (e) => {
                    e.stopPropagation();
                    const confirmed = await atlasConfirm('Plocka ärende', `Vill du ta över ärende #${displayId}?`);
                    if (confirmed) {
                        try {
                            if (isElectron) {
                                await window.atlasTeam.claimTicket(t.conversation_id, currentUser.username);
                            } else {
                                await fetch(`${SERVER_URL}/team/claim`, {
                                    method: 'POST',
                                    headers: fetchHeaders,
                                    body: JSON.stringify({ conversationId: t.conversation_id, agentName: currentUser.username })
                                });
                            }
                            renderInbox();
                        } catch (err) { console.error("Claim error:", err); }
                    }
                };
            }
            container.appendChild(card);
        });
    } catch (e) {
        container.innerHTML = `<div class="template-item-empty" style="color:#ff6b6b">Fel: ${e.message}</div>`;
    }
}

// FIX: Uppdaterad med data-current-id och innerHTML-stöd
function openInboxDetail(q, a, id = null) {
DOM.inboxQuestion.textContent = q;
// Formatera svaret om funktionen finns, annars textContent
if (typeof formatAtlasMessage === 'function') {
DOM.inboxAnswer.innerHTML = formatAtlasMessage(a);
} else {
DOM.inboxAnswer.textContent = a;
}

DOM.inboxPlaceholder.style.display = 'none';
DOM.inboxDetail.style.display = 'flex';

if (id) {
DOM.inboxQuestion.setAttribute('data-current-id', id);
} else {
DOM.inboxQuestion.removeAttribute('data-current-id');
}
}

async function renderArchive() {
const container = document.getElementById('archive-list');
if (!container) return;

container.innerHTML = '<div class="template-item-empty">Laddar arkiv...</div>';

try {
const res = await fetch(`${SERVER_URL}/api/archive`, { headers: fetchHeaders });
if (!res.ok) throw new Error("Kunde inte hämta arkivet");

const data = await res.json();
const history = data.archive || []; 

container.innerHTML = '';

if (history.length === 0) {
container.innerHTML = '<div class="template-item-empty">Arkivet är tomt.</div>';
return;
}

history.forEach(item => {
const el = document.createElement('div');
el.className = 'template-item archive-item';

const isChat = item.answer && item.answer.includes('Användare:');
const typeLabel = isChat ? 'CHATT' : 'MAIL';
const typeClass = isChat ? 'tag-chatt' : 'tag-form';

el.innerHTML = `
<div style="display:flex; flex-direction:column; gap:4px; width:100%;">
<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
<span class="ticket-tag ${typeClass}">${typeLabel}</span>
<span style="font-size:10px; opacity:0.5;">${new Date(item.timestamp).toLocaleDateString()}</span>
</div>
<span class="template-title">${item.question}</span>
</div>
`;

el.onclick = () => {
document.getElementById('archive-placeholder').style.display = 'none';
const detail = document.getElementById('archive-detail');
const content = document.getElementById('archive-content');
detail.style.display = 'flex';
// Enkel formatering för arkivet
content.innerHTML = item.answer.replace(/\n/g, '<br>');
};

container.appendChild(el);
});
} catch (err) {
console.error("Arkivfel:", err);
container.innerHTML = '<div class="template-item-empty" style="color:#ff6b6b">Kunde inte ladda arkivet.</div>';
}
}

async function loadTemplates() {
try {
if (isElectron) {
State.templates = await window.electronAPI.loadTemplates() || [];
} else {
const res = await fetch(`${SERVER_URL}/api/templates`, { headers: fetchHeaders });
if (!res.ok) throw new Error("Kunde inte hämta mallar");
State.templates = await res.json();
}
renderTemplates(State.templates);
} catch (err) {
console.error("Mall-fel:", err);
}
}

// ==========================================================
// 5. MALL-HANTERARE (KORRIGERAD)
// ==========================================================
function renderTemplates(list) {
DOM.templateList.innerHTML = '';
if (list.length === 0) {
DOM.templateList.innerHTML = '<div class="template-item-empty">Inga mallar hittades.</div>';
return;
}
const groups = {};
list.forEach(t => {
const g = t.group_name || 'Övrigt';
if (!groups[g]) groups[g] = [];
groups[g].push(t);
});
Object.keys(groups).sort().forEach(gName => {
const header = document.createElement('div');
header.className = 'template-group-header';
header.innerHTML = `<div class="group-header-content"><span class="group-arrow">▶</span><span class="group-name">${gName}</span></div><span class="group-count">${groups[gName].length}</span>`;
const content = document.createElement('div');
content.className = 'template-group-content';
groups[gName].forEach(t => {
const item = document.createElement('div');
item.className = 'template-item';
item.innerHTML = `<span class="template-title">${t.title}</span>`;

// Vi använder en explicit funktionsreferens här
item.onclick = () => {
if (typeof openTemplateEditor === 'function') {
openTemplateEditor(t);
} else {
console.error("Kritiskt fel: openTemplateEditor saknas fortfarande i scope!");
}
};

content.appendChild(item);
});
header.onclick = () => {
content.classList.toggle('expanded');
header.querySelector('.group-arrow').classList.toggle('expanded');
};
DOM.templateList.appendChild(header);
DOM.templateList.appendChild(content);
});
}

function openTemplateEditor(t) {
console.log("📂 Öppnar mall:", t.title);
isLoadingTemplate = true;

DOM.editorPlaceholder.style.display = 'none';
DOM.editorForm.style.display = 'flex';

DOM.inputs.id.value = t.id;
DOM.inputs.title.value = t.title;
DOM.inputs.group.value = t.group_name || ''; 

if (quill) {
quill.root.innerHTML = t.content; 
}

const deleteBtn = document.getElementById('delete-template-btn');
if(deleteBtn) deleteBtn.style.display = 'block';

const saveBtn = DOM.editorForm.querySelector('button[type="submit"]');
if (saveBtn) {
saveBtn.disabled = true; 
saveBtn.innerText = "Spara mall";
}

setTimeout(() => {
isLoadingTemplate = false;
}, 50);
}

// --- NAVIGATION OCH VYER ---
function switchView(viewId) {
// 1. Dölj alla vyer
Object.values(DOM.views).forEach(v => {
if (v) v.style.display = 'none';
});

// 2. Visa den valda vyn
if (DOM.views[viewId]) {
DOM.views[viewId].style.display = 'flex';
}

// 3. Uppdatera menyn
DOM.menuItems.forEach(item => {
item.classList.toggle('active', item.dataset.view === viewId);
});

// 4. Ladda data beroende på vy
if (viewId === 'inbox') {
    const badge = document.getElementById('badge-inbox');
    if (badge) badge.style.display = 'none';
    renderInbox();
} 
else if (viewId === 'my-tickets') {
    const badge = document.getElementById('badge-my-tickets');
    if (badge) badge.style.display = 'none';
    renderMyTickets(); // Denna anropar den nya filtrerade vyn
}
else if (viewId === 'archive') {
    renderArchive();
}
}


// Universell funktion för Atlas-modalen
function atlasConfirm(title, message) {
return new Promise((resolve) => {
const modal = document.getElementById('atlas-modal');
const titleEl = document.getElementById('modal-title');
const messageEl = document.getElementById('modal-message');
const confirmBtn = document.getElementById('modal-confirm');
const cancelBtn = document.getElementById('modal-cancel');

titleEl.innerText = title;
messageEl.innerText = message;
modal.style.display = 'flex';

confirmBtn.onclick = () => {
modal.style.display = 'none';
resolve(true);
};

cancelBtn.onclick = () => {
modal.style.display = 'none';
resolve(false);
};
});
}

function changeTheme(themeName) {
DOM.themeStylesheet.href = `./assets/themes/${themeName}/${themeName}.css`;
localStorage.setItem('atlas-theme', themeName);
}

// Uppdatera den röda badgen i menyn
async function updateInboxBadge() {
    const inboxBadge = document.getElementById('badge-inbox');
    const myBadge = document.getElementById('badge-my-tickets');

    try {
        const res = await fetch(`${SERVER_URL}/team/inbox`, { headers: fetchHeaders });
        const data = await res.json();
        const tickets = data.tickets || [];

        // 1. Notiser för Inkorg (Oplockade/Lediga)
        const unassignedCount = tickets.filter(t => !t.owner).length;
        if (inboxBadge) {
            inboxBadge.textContent = unassignedCount;
            inboxBadge.style.display = unassignedCount > 0 ? 'flex' : 'none';
        }

        // 2. Notiser för Mina ärenden (Där kunden har svarat sist)
        const myCount = tickets.filter(t => 
            t.owner === currentUser.username && 
            t.messages && t.messages.length > 0 && 
            t.messages[t.messages.length - 1].role === 'user'
        ).length;

        if (myBadge) {
            myBadge.textContent = myCount;
            myBadge.style.display = myCount > 0 ? 'flex' : 'none';
        }
    } catch (err) {
        console.error("Badge-error:", err);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
console.log("🚀 Atlas Renderer 2.5 Loaded (Final Context Fix)");

// 1. App Info & API Key
if (window.electronAPI) {
const info = await window.electronAPI.getAppInfo();
API_KEY = info.CLIENT_API_KEY;
if (DOM.appName) DOM.appName.textContent = info.APP_NAME;
if (DOM.appVersion) DOM.appVersion.textContent = info.ATLAS_VERSION;

// Uppdaterad rad: Visar versionen direkt om den inte är "Väntar..."
const sVer = (info.SERVER_VERSION && info.SERVER_VERSION !== 'Väntar...') ? info.SERVER_VERSION : 'Väntar...';
if (DOM.serverVersion) DOM.serverVersion.textContent = sVer;
}


// 2. Init Quill & Globala Lyssnare
if (typeof Quill !== 'undefined') {
quill = new Quill('#quill-editor', {
theme: 'snow',
placeholder: 'Skriv mallens innehåll här...'
});

// Global lyssnare för textinnehåll
quill.on('text-change', (delta, oldDelta, source) => {
if (isLoadingTemplate) return;
if (source === 'user') {
const saveBtn = DOM.editorForm.querySelector('button[type="submit"]');
if (saveBtn) saveBtn.disabled = false;
}
});
}

// Globala lyssnare för Titel och Grupp
[DOM.inputs.title, DOM.inputs.group].forEach(input => {
input.addEventListener('input', () => {
if (isLoadingTemplate) return;
const saveBtn = DOM.editorForm.querySelector('button[type="submit"]');
if (saveBtn) saveBtn.disabled = false;
});
});

// 3. Init State
initChat();
await loadTemplates(); // Laddar nu från DB!

// 4. Ladda sparat tema
const savedTheme = localStorage.getItem('atlas-theme');
if (savedTheme) {
DOM.themeSelect.value = savedTheme;
changeTheme(savedTheme);
}

// --- EVENT LISTENERS ---

// Meny-navigering
DOM.menuItems.forEach(item => {
item.addEventListener('click', () => switchView(item.dataset.view));
});

// Skicka meddelande
DOM.chatForm.addEventListener('submit', (e) => {
e.preventDefault();
handleUserMessage(DOM.messageInput.value);
});

// Sök mallar
DOM.templateSearch.addEventListener('input', (e) => {
const term = e.target.value.toLowerCase();
const filtered = State.templates.filter(t =>
t.title.toLowerCase().includes(term) ||
(t.group_name && t.group_name.toLowerCase().includes(term))
);
renderTemplates(filtered);

if (term.length > 0) {
document.querySelectorAll('.template-group-content').forEach(el => el.classList.add('expanded'));
}
});

// Byt tema
DOM.themeSelect.addEventListener('change', (e) => changeTheme(e.target.value));

// "Ny Chatt" knappen
const headerNewChat = document.getElementById('new-chat-btn-header');
if (headerNewChat) {
headerNewChat.addEventListener('click', async () => {
const confirmed = await atlasConfirm('Ny chatt', 'Vill du starta en ny chatt och rensa historiken?');
if (confirmed) initChat();
});
}

// "Skapa ny mall" knappen
document.getElementById('new-template-btn').addEventListener('click', () => {
DOM.editorPlaceholder.style.display = 'none';
DOM.editorForm.style.display = 'flex';
DOM.inputs.id.value = '';
DOM.inputs.title.value = '';
DOM.inputs.group.value = '';
quill.root.innerHTML = '';
document.getElementById('delete-template-btn').style.display = 'none';

const saveBtn = DOM.editorForm.querySelector('button[type="submit"]');
if (saveBtn) {
saveBtn.disabled = true;
saveBtn.innerText = "Spara mall";
}
});

// --- HYBRID: Spara mall ---
DOM.editorForm.addEventListener('submit', async (e) => {
e.preventDefault();

const saveBtn = DOM.editorForm.querySelector('button[type="submit"]');
const originalText = "Spara mall";

saveBtn.innerText = "Sparar...";
saveBtn.disabled = true;

const newTemplate = {
id: DOM.inputs.id.value || `tpl_${Date.now()}`,
title: DOM.inputs.title.value,
group_name: DOM.inputs.group.value || 'Övrigt',
content: quill.root.innerHTML
};

const existingIdx = State.templates.findIndex(t => t.id === newTemplate.id);
if (existingIdx > -1) State.templates[existingIdx] = newTemplate;
else State.templates.push(newTemplate);

try {
if (isElectron) {
await window.electronAPI.saveTemplates([newTemplate]);
} else {
const res = await fetch(`${SERVER_URL}/api/templates/save`, {
method: 'POST',
headers: fetchHeaders,
body: JSON.stringify(newTemplate)
});
if (!res.ok) throw new Error("Servern nekade sparning (Auth?)");
}

await loadTemplates();

saveBtn.innerText = "Sparat! ✅";
setTimeout(() => {
saveBtn.innerText = originalText;
saveBtn.disabled = false;
}, 1500);

if (quill) quill.focus();

} catch (err) {
console.error("Fel vid sparning:", err);
alert("Kunde inte spara mallen: " + err.message);
saveBtn.innerText = originalText;
saveBtn.disabled = false;
}
});

// --- HYBRID: Radera mall ---
const delBtn = document.getElementById('delete-template-btn');
if (delBtn) {
delBtn.addEventListener('click', async () => {
const id = DOM.inputs.id.value;
if (!id) return;

const confirmed = await atlasConfirm('Radera mall', 'Vill du ta bort denna mall permanent?');
if (confirmed) {
try {
if (isElectron) {
await window.electronAPI.deleteTemplate(id);
} else {
const res = await fetch(`${SERVER_URL}/api/templates/delete/${id}`, {
method: 'DELETE',
headers: fetchHeaders
});
if (!res.ok) throw new Error("Kunde inte radera mallen via webben");
}

State.templates = State.templates.filter(t => t.id !== id);
renderTemplates(State.templates);
DOM.editorForm.style.display = 'none';
DOM.editorPlaceholder.style.display = 'flex';
} catch (err) {
console.error("Fel vid borttagning:", err);
alert("Kunde inte ta bort mallen: " + err.message);
}
}
});
}

// ========================================================
// 🎹 NY KOD HÄR: TANGENTBORDSGENVÄGAR (STEG 2)
// ========================================================
document.addEventListener('keydown', (e) => {

// 1. NY CHATT: Ctrl + P
if (e.ctrlKey && !e.altKey && (e.key === 'p' || e.key === 'P')) {
e.preventDefault();
const newChatBtn = document.getElementById('new-chat-btn-header');
if (newChatBtn) newChatBtn.click();
}

// 2. FÖLJDFRÅGA: Ctrl + Alt + P
if (e.ctrlKey && e.altKey && (e.key === 'p' || e.key === 'P')) {
e.preventDefault();
const input = document.getElementById('message-input');
if (input) input.focus();
}

// 3. BYT TEMA: Ctrl + Alt + T
if (e.ctrlKey && e.altKey && (e.key === 't' || e.key === 'T')) {
e.preventDefault();
const select = document.getElementById('theme-select');
if (select) {
let newIndex = select.selectedIndex + 1;
if (newIndex >= select.options.length) newIndex = 0;
select.selectedIndex = newIndex;
changeTheme(select.value);
}
}

// 4. SPARA MALL: Ctrl + S
if (e.ctrlKey && (e.key === 's' || e.key === 'S')) {
const templateView = document.getElementById('view-templates');
if (templateView && templateView.style.display !== 'none') {
e.preventDefault();
const saveBtn = document.querySelector('.save-button');
if (saveBtn && !saveBtn.disabled) saveBtn.click();
}
}
});

// Globala Genvägar (Urklipp)
if (window.electronAPI) {
window.electronAPI.onProcessClipboard((text, shouldClear) => {
console.log("📋 Klistrar in från globalt kommando...");
if (shouldClear) initChat();
switchView('chat');
handleUserMessage(text);
});
}

// --- Arkivera-knapp ---
const archiveQaBtn = document.getElementById('archive-qa-btn');
if (archiveQaBtn) {
archiveQaBtn.onclick = async () => {
	
// HÄMTA DET RIKTIGA ID:T (Fixat!)
const currentId = DOM.inboxQuestion.getAttribute('data-current-id');

if (!currentId) {
alert("Inget ärende valt");
return;
}

const confirmed = await atlasConfirm('Arkivera', 'Vill du flytta detta ärende till arkivet?');
if (confirmed) {
try {
if (isElectron) {
// Vi skickar nu ID:t direkt istället för att söka i listan
await window.electronAPI.updateQAArchivedStatus(currentId, 1);
} else {
// Webb-läge: Vi använder den nya raderings/arkiverings-metoden
await fetch(`${SERVER_URL}/api/inbox/delete`, {
	method: 'POST',
	headers: fetchHeaders,
	body: JSON.stringify({ conversationId: currentId })
});
}
DOM.inboxDetail.style.display = 'none';
DOM.inboxPlaceholder.style.display = 'flex';
renderInbox();
} catch (err) { console.error("Arkivfel:", err); }
}
};
}

// Arkivera-knapp specifikt för vyn "Mina ärenden"
const myArchiveBtn = document.getElementById('my-archive-btn');
if (myArchiveBtn) {
    myArchiveBtn.onclick = async () => {
        // Vi hämtar ID:t från attributet vi satte när vi öppnade detaljvyn
        const currentId = document.getElementById('my-ticket-detail').getAttribute('data-current-id');

        if (!currentId) {
            alert("Inget ärende valt");
            return;
        }

        const confirmed = await atlasConfirm('Arkivera', 'Vill du flytta detta ärende till Garaget?');
        if (confirmed) {
            try {
                if (isElectron) {
                    // Använder din befintliga IPC-brygga
                    await window.electronAPI.updateQAArchivedStatus(currentId, 1);
                } else {
                    // För webb-versionen
                    await fetch(`${SERVER_URL}/api/inbox/delete`, {
                        method: 'POST',
                        headers: fetchHeaders,
                        body: JSON.stringify({ conversationId: currentId })
                    });
                }
                // Uppdatera vyn så ärendet försvinner från "Mina"
                document.getElementById('my-ticket-detail').style.display = 'none';
                document.getElementById('my-detail-placeholder').style.display = 'flex';
                renderMyTickets(); 
                updateInboxBadge();
            } catch (err) {
                console.error("Kunde inte arkivera från Mina ärenden:", err);
            }
        }
    };
}

// --- Återskapa-knapp ---
const unarchiveBtn = document.getElementById('unarchive-qa-btn');
if (unarchiveBtn) {
unarchiveBtn.onclick = async () => {
const currentContent = document.getElementById('archive-content').innerHTML;
if (isElectron) {
const allHistory = await window.electronAPI.loadQAHistory();
const item = allHistory.find(qa => qa.answer.replace(/\n/g, '<br>') === currentContent);
if (item) {
const confirmed = await atlasConfirm('Återskapa', 'Vill du flytta tillbaka till inkorgen?');
if (confirmed) {
item.is_archived = 0;
await window.electronAPI.saveQA(item);
document.getElementById('archive-detail').style.display = 'none';
document.getElementById('archive-placeholder').style.display = 'flex';
renderArchive();
}
}
} else {
alert("Återskapning är endast tillgänglig i Desktop-versionen just nu.");
}
};
}

// === AUTH INITIALIZATION ===
document.body.insertAdjacentHTML('beforeend', loginModalHTML);
checkAuth();

// Hantera Login Submit
const loginForm = document.getElementById('login-form');
if (loginForm) {
loginForm.addEventListener('submit', async (e) => {
e.preventDefault();
const user = document.getElementById('login-user').value;
const pass = document.getElementById('login-pass').value;
const errElem = document.getElementById('login-error');
const btn = loginForm.querySelector('button');

btn.disabled = true;
btn.innerText = "Loggar in...";
errElem.textContent = "";

try {
const res = await fetch(`${SERVER_URL}/api/auth/login`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ username: user, password: pass })
});

const data = await res.json();

if (!res.ok) throw new Error(data.error || 'Inloggning misslyckades');

// Spara Token
localStorage.setItem('atlas_token', data.token);
localStorage.setItem('atlas_user', JSON.stringify(data.user));

// Ladda om för att starta socket med ny token
location.reload();

} catch (err) {
errElem.textContent = err.message;
btn.disabled = false;
btn.innerText = "Logga in";
}
});
}

// Lägg till Logout i menyn
if (!document.getElementById('logout-btn')) {
const menu = document.querySelector('.sidebar-menu'); 
if(menu) {
const logoutBtn = document.createElement('div');
logoutBtn.className = 'menu-item';
logoutBtn.id = 'logout-btn'; // För att undvika dubbletter
logoutBtn.innerHTML = '<span class="icon">🚪</span> Logga ut';
logoutBtn.onclick = handleLogout;
logoutBtn.style.marginTop = "auto"; // Tryck ner till botten
menu.appendChild(logoutBtn);
}
}

});

// Hjälpfunktion för att formatera text (fetstil, radbrytningar, länkar)
function formatAtlasMessage(text) {
    if (!text) return "";
    return text
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="atlas-link">$1</a>');
}

