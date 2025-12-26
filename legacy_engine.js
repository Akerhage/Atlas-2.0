/* ====================================================================
ATLAS LEGACY ENGINE (v1.6.0 Core Wrapped for v2.0)
--------------------------------------------------------------------
Ansvar:   Kör den "gamla" intelligensen (RAG, Intent, NLU) i en stateless miljö.
Arkitektur: Inject State -> Execute Logic -> Extract State -> Purge
==================================================================== */

// ====================================================================
// SECTION 1: CONFIGURATION & ENVIRONMENT
// ====================================================================

// FIX: Säkerställ att SERVER_ROOT finns för legacy-moduler
process.env.ATLAS_ROOT_PATH = process.env.ATLAS_ROOT_PATH || __dirname;

const PORT = 3001;
process.env.LANG = 'sv_SE.UTF-8';

// --- Modul-importer ---
const fs         = require('fs');
const path       = require('path');
const MiniSearch = require('minisearch');
const OpenAI     = require('openai');
const crypto     = require('crypto');

// --- Sökvägs-säkerhet
const SERVER_ROOT = process.env.ATLAS_ROOT_PATH;
if (!SERVER_ROOT) {
console.error("FATAL: ATLAS_ROOT_PATH saknas. Server kan inte hitta uppackade moduler.");
process.exit(1);
}

// --- Legacy Modul-laddning
// Vi använder try-catch för att hantera om patch-mappen saknas i debug
let ForceAddEngine, IntentEngine, contextLock, priceResolver, INTENT_PATTERNS;

try {
const patchPath = path.join(SERVER_ROOT, 'patch');
ForceAddEngine = require(path.join(patchPath, 'forceAddEngine'));
const intentModule = require(path.join(patchPath, 'intentEngine'));
IntentEngine = intentModule.IntentEngine;
INTENT_PATTERNS = intentModule.INTENT_PATTERNS;
contextLock = require(path.join(SERVER_ROOT, 'utils', 'contextLock'));
priceResolver = require(path.join(SERVER_ROOT, 'utils', 'priceResolver'));
} catch (e) {
console.log("⚠️ Kunde inte ladda moduler via standardväg, försöker fallback...");
// Fallback för enkla tester
ForceAddEngine = class { constructor() { this.mustAddChunks = []; } execute() { return { mustAddChunks: [], forceHighConfidence: false }; } };
IntentEngine = class { parseIntent() { return { intent: 'unknown', slots: {} }; } };
}

const IS_PACKAGED = process.env.IS_PACKAGED === 'true';

// Temporär Sessions-lagring (Används endast under requestens livstid i V2)
const sessions = new Map();

// ====================================================================
// SECTION 2: SESSION & STATE MANAGEMENT UTILS
// ====================================================================
function generateSessionId() {
return crypto.randomBytes(16).toString('hex');
}

function createEmptySession(sessionId) {
const newSession = {
id: sessionId,
created: Date.now(),
messages: [],
locked_context: {city: null,area: null,vehicle: null},
linksSentByVehicle: {AM: false, MC: false, CAR: false, INTRO: false, RISK1: false, RISK2: false}, 
isFirstMessage: true
};
sessions.set(sessionId, newSession);
return newSession;
}

function appendToSession(sessionId, role, content) {
const session = sessions.get(sessionId);
if (!session) return;
session.messages.push({ role, content, timestamp: Date.now() });
}

// SMART SÖKVÄG
function getResourcePath(filename) {
if (IS_PACKAGED && process.resourcesPath) {
return path.join(process.resourcesPath, filename);
}
if (process.env.ATLAS_ROOT_PATH) {
return path.join(process.env.ATLAS_ROOT_PATH, filename);
}
return path.join(__dirname, filename);
}

// --- Environment Loading
const dotenvPath = getResourcePath('.env');
require('dotenv').config({ path: dotenvPath });

// --- API Keys
const CLIENT_API_KEY      = process.env.CLIENT_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

if (!OPENAI_API_KEY) {
console.error('FEL: OPENAI_API_KEY saknas i .env (Legacy Engine)');
}

console.log('Legacy Engine: OpenAI-klient initialiserad.');

// --- Knowledge Base Paths (DENNA DEL ÄR NU FIXAD) ---
let KNOWLEDGE_PATH = path.join(__dirname, 'knowledge');
if (!fs.existsSync(KNOWLEDGE_PATH)) {
// Om den inte hittas bredvid filen, testa rooten (vanligt vid debug)
KNOWLEDGE_PATH = path.join(process.cwd(), 'knowledge');
}
console.log("📢 TVINGAD SÖKVÄG (Global):", KNOWLEDGE_PATH);

const SYSTEM_PROMPT_PATH = getResourcePath('systembeskrivning.md');
const CONFIG_PATH = getResourcePath('config.json');

if (!fs.existsSync(KNOWLEDGE_PATH)) {
console.error(`FATAL: Knowledge-mappen saknas på: ${KNOWLEDGE_PATH}`);
}

// --- OpenAI Client
const openai = new OpenAI({apiKey: OPENAI_API_KEY});

// ====================================================================
// SECTION 3: GLOBAL STATE & MEMORY (Read-Only after Init)
// ====================================================================
const VERSION = '1.5.0 - Atlas Legacy';

let miniSearch;
let allChunks = [];
let knownCities = [];
let knownAreas = {};
let cityOffices = {};
let officePrices = {};
let officeContactData = {};
let officeData = {};
let chunkMap = new Map();
let intentEngine;
let criticalAnswers = [];

// === BYGG CHUNKMAP
function rebuildChunkMap() {
if (!Array.isArray(allChunks)) {
chunkMap = new Map();
return;
}
chunkMap = new Map(allChunks.map(c => [c.id, c]));
}

const LOW_CONFIDENCE_THRESHOLD = 0.25;
const LOW_CONFIDENCE_SLICE = 8;
const MAX_CHUNKS = 18;
const DEBUG_MODE = true;

const CITY_ALIASES = {
// --- Stockholm (inkl. Djursholm, Enskededalen, Kungsholmen, Österåker, Östermalm, Södermalm, Solna) ---
'stockholm': 'Stockholm',
'sthlm': 'Stockholm',
'djursholm': 'Stockholm',
'enskededalen': 'Stockholm',
'kungsholmen': 'Stockholm',
'osteraker': 'Stockholm',
'osteråker': 'Stockholm',
'österaker': 'Stockholm',
'österåker': 'Stockholm',
'ostermalm': 'Stockholm',
'ostermälm': 'Stockholm',
'östermalm': 'Stockholm',
'sodermalm': 'Stockholm',
'södermalm': 'Stockholm',
'solna': 'Stockholm',

// --- Göteborg (inkl. Högsbo, Mölndal, Mölnlycke, Stora Holm, Ullevi, Västra Frölunda) ---
'goteborg': 'Göteborg',
'göteborg': 'Göteborg',
'gbg': 'Göteborg',
'gothenburg': 'Göteborg',
'hogsbo': 'Göteborg',
'högsbo': 'Göteborg',
'molndal': 'Göteborg',
'mölndal': 'Göteborg',
'molnlycke': 'Göteborg',
'mölnlycke': 'Göteborg',
'stora holm': 'Göteborg',
'storaholm': 'Göteborg',
'ullevi': 'Göteborg',
'vastra frolunda': 'Göteborg',
'västra frölunda': 'Göteborg',

// --- Malmö (inkl. Bulltofta, Limhamn, Södervärn, Triangeln, Värnhem, Västra Hamnen) ---
'malmo': 'Malmö',
'malmö': 'Malmö',
'bulltofta': 'Malmö',
'limhamn': 'Malmö',
'sodervarn': 'Malmö',
'sodervärn': 'Malmö',
'södervarn': 'Malmö',
'södervärn': 'Malmö',
'triangeln': 'Malmö',
'varnhem': 'Malmö',
'värnhem': 'Malmö',
'vastra hamnen': 'Malmö',
'västra hamnen': 'Malmö',
'vastra_hamnen': 'Malmö',

// --- Helsingborg (inkl. Hälsobacken) ---
'helsingborg': 'Helsingborg',
'halsobacken': 'Helsingborg',
'hälsobacken': 'Helsingborg',

// --- Lund (inkl. Katedral, Södertull) ---
'lund': 'Lund',
'katedral': 'Lund',
'sodertull': 'Lund',
'södertull': 'Lund',

// --- Övriga Orter (Baserat på din fullständiga fil-lista) ---
'angelholm': 'Ängelholm',
'ängelholm': 'Ängelholm',
'eslov': 'Eslöv',
'eslöv': 'Eslöv',
'gavle': 'Gävle',
'gävle': 'Gävle',
'hassleholm': 'Hässleholm',
'hässleholm': 'Hässleholm',
'hollviken': 'Höllviken',
'höllviken': 'Höllviken',
'kalmar': 'Kalmar',
'kristianstad': 'Kristianstad',
'kungsbacka': 'Kungsbacka',
'landskrona': 'Landskrona',
'linkoping': 'Linköping',
'linköping': 'Linköping',
'trelleborg': 'Trelleborg',
'umea': 'Umeå',
'umeå': 'Umeå',
'uppsala': 'Uppsala',
'varberg': 'Varberg',
'vasteras': 'Västerås',
'västeras': 'Västerås',
'vasterås': 'Västerås',
'västerås': 'Västerås',
'vaxjo': 'Växjö',
'växjo': 'Växjö',
'vaxjö': 'Växjö',
'växjö': 'Växjö',
'vellinge': 'Vellinge',
'ystad': 'Ystad'
};

const VEHICLE_MAP = {
'SLÄP': ['be', 'be-kort', 'be körkort', 'be-körkort', 'b96', 'släp', 'tungt släp', 'utökad b'],
'LASTBIL': ['lastbil', 'c', 'c1', 'c1e', 'ce', 'c-körkort', 'tung lastbil', 'medeltung lastbil'],
'AM': ['am', 'moped', 'mopedutbildning', 'moppe', 'klass 1'],
'BIL': ['bil', 'personbil', 'b-körkort', 'b körkort', 'körlektion bil', 'körlektion personbil'],
'MC': ['mc', 'motorcykel', 'a1', 'a2', 'a-körkort', '125cc', '125 cc', 'lätt motorcykel', 'tung motorcykel'],
'INTRO': ['introduktionskurs', 'handledarkurs', 'handledare']
};

const UNIFIED_SYNONYMS = {
// === DINA VIKTIGA BEGREPPS-KOPPLINGAR (BEHÅLLNA) ===
'behöver gå': ['måste gå', 'krävs', 'genomföra', 'obligatorisk', 'behöver genomföra'],
'obligatorisk': ['krav', 'måste', 'krävs', 'obligatoriskt moment'],
'göra om': ['ta om', 'göra om', 'genomföra på nytt', 'underkänd'],
'två elever': ['två elever', '2 elever', 'duo-lektion', 'duo'],
'handledare': ['handledare', 'din handledare', 'handledaren', 'privat handledare', 'handledarskap', 'introduktionskurs'],
'elev': ['du som ska ta körkort', 'du som elev', 'elev', 'student'],
'privat körning': ['privat övningskörning', 'övningsköra privat', 'köra hemma'],
'övningskör': ['övningskör', 'övningsköra', 'träna körning', 'körträning'],
'körkortstillstånd': ['tillstånd', 'krävs', 'giltigt', 'handledarintyg', 'grupp 1'],
'giltighetstid': ['giltighetstid', 'hur länge gäller', 'giltighet', 'förfaller', 'utgår'],
'prövotid': ['prövotid', '2 år', 'förarprov', 'göra om prov', 'körkort indraget', 'återkallat körkort'],
'syntest': ['syntest', 'synundersökning', 'synprov', 'synintyg', 'optiker'],

// === MÅTT & TID (UPPDATERADE & SÄKRADE) ===
'14 år och 9 månader': ['14 år och 9 månader', '14,5 år', '14 år 9 mån', 'övningsköra moped'],
'15 år': ['15 år', '15-åring', 'myndig moped'],
'16 år': ['16 år', '16-åring', 'övningsköra bil'],
'18 år': ['18 år', '18-åring', 'myndig'],
'24 år': ['24 år', '24-åring', 'krav för handledare'],
'2 år': ['2 år', 'två år', 'prövotid'],
'5 år': ['5 år', 'fem år', 'giltighetstid intro'],
'3 månader': ['3 månader', 'tre månader'],
'17 timmar': ['17 timmar', 'minst 17 timmar', 'am kurslängd'], // Specifikt för AM
'320 minuter': ['320 minuter', 'trafikkörning am', '4 x 80 min'], // Specifikt för AM

// === LEKTIONSLÄNGDER (VIKTIGT FÖR PRISER) ===
'80 min': ['80 min', '80 minuter', 'standardlektion', 'körlektion'],
'40 min': ['40 min', '40 minuter', 'halv lektion'], // Om ni har det?
'100 min': ['100 min', '100 minuter', 'dubbel lektion', 'duo'],
'3,5 timmar': ['3,5 timmar', 'tre och en halv timme', 'riskettan tid'],

// === FORDON & KURSER ===
'am': ['am', 'moped', 'moped klass 1', 'eu-moped', 'moppe', 'am-kort'],
'mc': ['mc', 'motorcykel', 'a-behörighet', 'a1', 'a2', 'tung mc', 'lätt mc'],
'motorcykel': ['mc', 'motorcykel', 'motorcyklar', 'vilka mc', 'vilken mc', 'yamaha', 'mt-07', 'motorcykel typ'],
'bil': ['bil', 'personbil', 'b-körkort', 'b-behörighet'],
'automat': ['automat', 'automatväxlad', 'villkor 78', 'kod 78'],
'manuell': ['manuell', 'växlad bil'],
'risk 1': ['risk 1', 'riskettan', 'riskutbildning del 1', 'alkohol och droger'],
'risk 2': ['risk 2', 'risktvåan', 'halkbana', 'halka', 'hal utbildning'],
'halkbanan': ['risk 2', 'risktvåan', 'stora holm', 'gillinge'], // Specifika banor
'intro': ['introduktionskurs', 'handledarkurs', 'handledarutbildning'],

// === PLATSER (KOLLAR MOT DIN LISTA) ===
'stora holm': ['stora holm', 'halkbana göteborg', 'manöverbana göteborg'],
'göteborg': ['göteborg', 'gbg', 'gothenburg'],
'stockholm': ['stockholm', 'sthlm', '08'],

// === BETALNING & KONTAKT ===
'avbokning': ['avbokning', 'avboka', 'omboka', 'återbud', 'sjuk'],
'avboka': ['avbokning', 'avboka', 'omboka'],
'rabatt': ['rabatt', 'studentrabatt', 'kampanj', 'erbjudande', 'billigare'],
'pris': ['pris', 'kostar', 'kostnad', 'avgift', 'prislapp', 'vad tar ni'],
'betalning': ['betalning', 'betala', 'betalningsalternativ', 'hur betalar jag', 'betala med'],
'betala': ['betalning', 'betala', 'betalningsalternativ'],
'delbetalning': ['faktura', 'delbetala', 'delbetalning', 'klarna', 'avbetalning'],
'delbetala': ['delbetalning', 'faktura', 'klarna'],
'faktura': ['faktura', 'klarna', 'delbetala', 'kredit', 'scancloud', 'delbetalning', 'swish', 'kort','fe 7283'],
'boka': ['boka', 'bokning', 'reservera', 'anmäla', 'köpa'],
'bokning': ['boka', 'bokning', 'reservera'],
'bokar': ['boka', 'bokning'],
'kontakt': ['kontakt', 'telefon', 'ring', 'maila', 'e-post', 'support', 'kundtjänst', 'öppettider']
};

// ====================================================================
// SECTION 4: TEXT PROCESSING & TOOLS
// ====================================================================
function expandQuery(query) {
let expanded = query.toLowerCase();
for (const [key, synonyms] of Object.entries(UNIFIED_SYNONYMS)) {
if (expanded.includes(key.toLowerCase())) {
const limited = synonyms.slice(0, 2);
limited.forEach(syn => expanded += ' ' + syn.toLowerCase());
}
}
if (expanded.length > 250) {
expanded = expanded.substring(0, 250);
}
return expanded;
}

// --- Chunk: Kontrollera om typen är Basfakta
function isBasfaktaType(c) {
if (!c) return false;
const t = (c.type || '').toString().toLowerCase();
const s = (c.source || '').toLowerCase();
// Om den har typ basfakta ELLER kommer från en fil som börjar på basfakta_
return t.includes('basfakta') || s.startsWith('basfakta_');
}

function normalizeText(s) {
if (!s) return '';
return s.toString()
.toLowerCase()
.normalize('NFD').replace(/[\u0300-\u036f]/g, "") 
.replace(/\b(\d+)\s?cc\b/g, '$1 cc')
.replace(/\b(\d+)\s?k\s?w\b/g, '$1 kW')
.replace(/[^\w\s\d]/g, ' ')
.replace(/\s+/g, ' ')
.trim();
}

function normalizedExpandQuery(q) {
const normalized = normalizeText(q);
return expandQuery(normalized);
}

// === RAG: Kontrollera Låg Konfidens
function isLowConfidence(results) {
if (!results || results.length === 0) return true;
const best = results[0];
return (typeof best.score === 'number') ? (best.score < LOW_CONFIDENCE_THRESHOLD) : true;
}

// ====================================================================
// SECTION 4.1: EXTERNAL TOOLS (Weather, Jokes, Prices)
// ====================================================================
async function get_joke() {
try {
const jokes = [
"Varför kör MC-förare alltid så snabbt? För att hålla sig varma!",
"Varför välter inte motorcyklar? För att de är tvåhjuliga med balans i blodet!"
];
const joke = jokes[Math.floor(Math.random() * jokes.length)];
return { joke };
} catch (e) {
return { joke: "Jag har inga skämt just nu 😅" };
}
}

async function get_quote() {
try {
const quotes = [
"Den bästa tiden att börja var igår. Den näst bästa är idag.",
"Framgång kommer av små steg tagna varje dag.",
"Gör ditt bästa idag – framtiden tackar dig."
];
const quote = quotes[Math.floor(Math.random() * quotes.length)];
return { quote };
} catch (e) {
return { quote: "Kunde inte hämta ett citat just nu." };
}
}

async function fetchWeather(rawCity) {
const city = (rawCity || 'Stockholm').toString().toLowerCase().trim();
const normalizedCity = CITY_ALIASES[city] || city;
const targetCity = normalizedCity || 'Stockholm';
const apiKey = process.env.OPENWEATHER_API_KEY;
if (!apiKey) {
return { error: "OpenWeather API-nyckel saknas" };
}
const url = `https://api.openweathermap.org/data/2.5/weather?q=${targetCity},SE&appid=${apiKey}&units=metric&lang=sv`;
try {
const res = await fetch(url);
const data = await res.json();
if (data.cod !== 200) {
return { error: `Kunde inte hämta väder för ${targetCity}` };
}

return {
city: data.name,
temperature: Math.round(data.main.temp),
description: data.weather[0].description
};
} catch (e) {
console.error('[WEATHER ERROR]', e.message);
return { error: "Väder-API:t svarar inte" };
}
}

async function calculate_price(amount, unit_price) {
try {
const total = amount * unit_price;
return { total };
} catch (e) {
return { error: "Kunde inte räkna ut priset." };
}
}

async function generate_image(prompt) {
try {
const res = await openai.images.generate({
model: "gpt-image-1",
prompt: prompt,
size: "1024x1024"
});
const imageBase64 = res.data[0].b64_json;
return { image: imageBase64 };
} catch (e) {
console.error("Image generation error:", e);
return { error: "Kunde inte generera bilden." };
}
}

// === GLOBAL AVAILABLE TOOLS
const globalAvailableTools = [
{ type: "function", function: { name: "get_weather", description: "Hämtar väder för en svensk stad.", parameters: { type: "object", properties: { city: { type: "string", description: "Stad i Sverige" } }, required: ["city"] } } },
{ type: "function", function: { name: "get_joke", description: "Returnerar ett slumpmässigt skämt." } },
{ type: "function", function: { name: "get_quote", description: "Returnerar ett inspirerande citat." } },
{ type: "function", function: { name: "calculate_price", description: "Räknar ut totalpris.", parameters: { type: "object", properties: { amount: { type: "number" }, unit_price: { type: "number" } }, required: ["amount", "unit_price"] } } },
{ type: "function", function: { name: "generate_image", description: "Genererar en bild baserat på en prompt.", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } } }
];

// ====================================================================
// SECTION 5: AI & RAG LOGIC
// ====================================================================

// === SYSTEM PROMPT FUNCTION AND RAG ANSWER GENERATOR
async function generate_rag_answer(userQuestion, retrievedContext, detectedCity, detectedArea, isFirstMessage = false, mode = 'knowledge') {

// === HÄLSNINGS-LOGIK
let timeGreeting = "";
if (isFirstMessage) {
const hour = new Date().getHours();
if (hour >= 5 && hour < 10) timeGreeting = "God morgon! ";
else if (hour >= 10 && hour < 17) timeGreeting = "Hej! ";
else if (hour >= 17 && hour < 22) timeGreeting = "God kväll! ";
else timeGreeting = "Hej! ";
}

const greetingInstruction = isFirstMessage
? `Börja alltid svaret med EXAKT: "${timeGreeting}" och fortsätt sedan direkt med svaret.`
: `Hälsa aldrig - gå rakt på sak.`;

const cityInclusionInstruction = detectedCity
? `\n\nOBS: Om frågan är platsberoende, MÅSTE du inkludera staden i svaret. Exempel: "I ${detectedCity} erbjuder vi ..." eller "På vårt kontor i ${detectedCity} ...".`
: '';

// === SYSTEM PROMPT - KNOWLEDGE/RAG-MODE
let systemPrompt = `
Du är Atlas — en varm, hjälpsam och faktasäker kundtjänstassistent för en svensk trafikskola.

// === KRITISKA SVARSREGLER (DESSA GÄLLER ÖVER ALL ANNAN KONTEXT) ===
Du MÅSTE följa dessa regler slaviskt, även om kontexten verkar vag:

1. **MC-LEKTIONER (ID 78):** PRIORITERA ALLTID svaret: "15-20 lektioner behövs vanligtvis, individuellt". (Nämn intensivvecka + 5 lektioner endast som ett tillägg).
2. **KVÄLLSLEKTIONER (ID 160):** INKLUDERA ALLTID: "sista starttid kl 19:20".
3. **AUTOMAT (ID 145):** INKLUDERA ALLTID: "**villkor 78**" (automat) kod.
4. **GILTIGHETSTID (ID 156):** SVARA ALLTID "**24 månader**" för paket. Svara aldrig "ett år" om paket.

// === REGLER FÖR DATAHANTERING & HALLUCINATION ===
- **KONTAKTINFO-TVÅNG:** Om kontexten innehåller siffror (telefon, orgnr, adress), MÅSTE du skriva ut dem.
- **<EXACT_FACT> REGEL:** Om kontexten innehåller text inom <EXACT_FACT>...</EXACT_FACT>: 1. Använd EXAKT den texten. 2. Tolka inte. 3. Lägg inte till "vanligtvis".
- **KOMPLEXA SVAR:** Om frågan har flera delar (t.ex. pris OCH innehåll), MÅSTE du använda en punktlista.

// === TON & FORMAT ===
- Var varm, rådgivande och mänsklig i språket.
- Skriv fullständiga meningar, tydligt och kortfattat.
- Använd fetstil för priser, kursnamn och viktiga fakta: **så här**.
- Om frågan kräver ett artigt inledande (första svar i sessionen) ska hälsningen hanteras av servern.

// === FÖRBUD & RULES ===
- ANVÄND ENDAST information från KONTEXTEN. Skapa aldrig ny fakta.
- ÄNDRA aldrig pris, tider, telefonnummer, eller andra fakta från kontexten.
- Säg aldrig bokningslänkar — servern lägger in dessa automatiskt.

// === KANONFRASER (Använd exakt när ämnet tas upp) ===
- Testlektion: "Testlektion (även kallad provlektion eller prova-på) är ett nivåtest för bil-elever och kan endast bokas en gång per elev."
- Startlektion MC: "Startlektion är nivåbedömning, 80 minuter inför MC intensivvecka."
- Riskutbildning: "Risk 1 är cirka 3,5 timmar och Risk 2 är 4–5 timmar och kan göras i vilken ordning som helst."
- Handledare: "Handledaren måste vara minst 24 år, haft körkort i minst 5 av de senaste 10 åren och både elev och handledare behöver gå introduktionskurs."
- Automat: "Automat ger villkor 78."

// === FALLBACK ===
- Om information saknas helt i kontexten svara exakt:
"Jag hittar ingen information i vår kunskapsbas om det här."

LÄS NEDAN KONTEXT NOGA OCH SVARA UTIFRÅN DEN (MEN FÖLJ DE KRITISKA REGLERNA ÖVERST):
<<KONTEXT_BIFOGAD_AV_SERVERN>>
Svara alltid på svenska.
Använd **text** (dubbelstjärnor) för att fetmarkera priser och andra viktiga fakta.

${greetingInstruction}
${cityInclusionInstruction}
`.trim();

// === SYSTEM PROMPT - CHAT-MODE
if (mode === "chat") {
systemPrompt = `
Du är Atlas — en varm, personlig och lätt humoristisk assistent för en svensk trafikskola.

TON & FORMAT
- Vara varm, mänsklig och lätt skämtsam när det passar.
- Håll det kort, tydligt och hjälpsamt.
- Använd svenska.
- Fetstil behövs inte i fria chat-svar men är ok när det förtydligar något.

TOOLS & NÄR DE FÅR ANVÄNDAS
- Om användaren frågar om VÄDER, SKÄMT, Citat eller BILDER: **ANVÄND ALLTID motsvarande tool OMEDELBART**. Fråga ALDRIG användaren om de vill att du ska göra det - gör det direkt.
• Väderfrågor: Anropa get_weather med rätt stad
• Skämtfrågor: Anropa get_joke
• Citatfrågor: Anropa get_quote
- Servern förväntar sig tool_calls i dessa fall - returnera ALDRIG vanlig text när ett tool finns tillgängligt.

FÖRBUD
- Säg aldrig bokningslänkar — servern lägger in dem när relevant.
- Svara aldrig på faktafrågor om körkort/kurser - dessa hanteras av ett annat system.

FALLBACK
- Om du är osäker: svar kort och vänligt, t.ex. "Jag kan hjälpa med det — ska jag kolla något specifikt åt dig?"

Svara alltid på svenska.
Använd **text** (dubbelstjärnor) för att fetmarkera viktiga fakta när det passar.
${greetingInstruction}
`.trim();
}

// UTOMATISKT VISITKORT
if (detectedCity) {
const cityKey = detectedCity.toLowerCase();
// Fall 1: Vi har data för staden i officeData
if (officeData[cityKey] && officeData[cityKey].length > 0) {
const offices = officeData[cityKey];
// Scenario A: ETT kontor/stad (ex. Eslöv)
if (offices.length === 1) {
const office = offices[0];
const name = office.name || `Kontoret i ${office.city}`;
const phone = (office.contact && office.contact.phone) ? office.contact.phone : (office.phone || "");
const email = (office.contact && office.contact.email) ? office.contact.email : (office.email || "");
const address = (office.contact && office.contact.address) ? office.contact.address : (office.address || "");

let hoursText = "";
if (office.opening_hours && Array.isArray(office.opening_hours)) {
hoursText = office.opening_hours.map(h => `${h.days}: ${h.hours}`).join(", ");
}

const contactCard = `
---------------------------------------------------------------------
🚨 INSTRUKTION FÖR PLATSSPECIFIK KONTAKTINFO (${office.city}) 🚨
Användaren frågar om kontaktuppgifter i: ${office.city}.
Du MÅSTE presentera svaret EXAKT enligt följande mall:

"Här har du kontaktuppgifterna till oss i ${office.city}:

**${name}**
📍 ${address}
📞 ${phone}
📧 ${email}
${hoursText ? `🕒 Öppettider: ${hoursText}` : ''}

Ring oss gärna om du har frågor!"
---------------------------------------------------------------------
`;
systemPrompt += "\n" + contactCard;
} 
// Scenario B: FLERA kontor/stad (ex. Göteborg/Malmö/Stockholm)
else if (offices.length > 1) {
// Har användaren specifierat ett område? (ex. "Ullevi")
if (detectedArea) {
const specificOffice = offices.find(o => o.area && o.area.toLowerCase() === detectedArea.toLowerCase());
if (specificOffice) {
const office = specificOffice;
const name = office.name;
const phone = office.contact?.phone || "";
const email = office.contact?.email || "";
const address = office.contact?.address || "";
const contactCard = `
---------------------------------------------------------------------
🚨 INSTRUKTION FÖR PLATSSPECIFIK KONTAKTINFO (${office.city} - ${office.area}) 🚨
Du MÅSTE presentera svaret EXAKT enligt följande mall:

"Här har du kontaktuppgifterna till ${office.area}:

**${name}**
📍 ${address}
📞 ${phone}
📧 ${email}"
---------------------------------------------------------------------
`;
systemPrompt += "\n" + contactCard;
} else {
const list = offices.map(o => `* **${o.area}**: ${o.contact?.phone || 'Se hemsida'}`).join("\n");
systemPrompt += `\n\nVi har flera kontor i ${detectedCity}. Här är en lista:\n${list}\nBe användaren precisera vilket de vill besöka.`;
}
} else {
// VIKTIG FIX: Istället för att be användaren välja, tvingar vi fram fakta för alla kontor direkt.
const list = offices.map(o => `* **${o.area}**: ${o.contact?.phone || 'Se hemsida'}`).join("\n");
systemPrompt += `\n\nVIKTIGT: Om användaren frågar om priser eller kontakt i ${detectedCity}, prioritera faktan för det specifika fordonet. Nämn kortfattat att vi finns på flera platser (t.ex. City och Hälsobacken) men håll svaret koncist så att de exakta priserna hamnar i fokus. Svara direkt med fakta, fråga INTE vilket kontor de menar.`;
}
}
}
}

// === TRIGGERS
if (mode === "chat") {
const lower = userQuestion.toLowerCase();
// — 1: Tvinga knowledge-mode om användaren frågar om priser/körkort
if (lower.includes("pris") || lower.includes("kostar") || lower.includes("körkort") || lower.includes("paket") || lower.includes("lektion") || lower.includes("riskettan") || lower.includes("risktvåan") || lower.includes("am") || lower.includes("mc") || lower.includes("bil")) {
mode = "knowledge";
}
// — 2: Om användaren ber om väder, skämt, citat, bild → håll kvar chat-mode
if (lower.includes("väder") || lower.includes("skämt") || lower.includes("citat") || lower.includes("bild") || lower.includes("rita") || lower.includes("generera")) {
mode = "chat";
}
}

// === TOOL FORCING FÖR CHAT-MODE
let toolForcingInstruction = "";
if (mode === "chat") {
const lowerQ = userQuestion.toLowerCase();
if (lowerQ.includes("väder")) {
const cityMatch = detectedCity || "Stockholm";
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked about weather. You MUST call get_weather tool with city="${cityMatch}". Do NOT respond with text.]`;
} else if (lowerQ.includes("skämt") || lowerQ.includes("vits")) {
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked for a joke. You MUST call get_joke tool. Do NOT respond with text.]`;
} else if (lowerQ.includes("citat")) {
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked for a quote. You MUST call get_quote tool. Do NOT respond with text.]`;
}
}

// === USER MESSAGE
const userContent = mode === "knowledge" ? `Fråga: ${userQuestion}\n\nKONTEXT:\n${retrievedContext || ""}` : userQuestion + toolForcingInstruction; 

// === TOOLS CHAT-MODE
let tools = [];
if (mode === "chat") {
tools = globalAvailableTools;
}

// === SEND TO OPENAI
const messages = [
{ role: "system", content: systemPrompt },
{ role: "user", content: userContent }
];

const apiParams = {
model: "gpt-4o-mini",
messages,
max_tokens: mode === "chat" ? 600 : 700,
temperature: mode === "chat" ? 0.7 : 0.0,
top_p: 1.0
};

// FORCE TOOL USAGE
if (mode === "chat" && tools && tools.length > 0) {
const lowerQ = userQuestion.toLowerCase();
if (lowerQ.includes("väder")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_weather" } };
} else if (lowerQ.includes("skämt") || lowerQ.includes("vits")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_joke" } };
} else if (lowerQ.includes("citat")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_quote" } };
} else {
apiParams.tools = tools;
}
}

let resp;
try {
resp = await openai.chat.completions.create(apiParams, { timeout: 15000 });
} catch (error) {
console.error("!!! OPENAI ERROR:", error.message);
return { type: 'answer', answer: "OpenAI tog för lång tid på sig eller svarade inte. Försök igen." };
}



const text = resp.choices?.[0]?.message?.content?.trim() || "";

// === CHAT-MODE LOGIC
if (mode === "chat") {
const toolCall = resp.choices?.[0]?.message?.tool_calls;
if (toolCall && toolCall.length > 0) {
return { type: "tool_request", model: "gpt-4o-mini", messages, tools, max_tokens: 600, temperature: 0.7 };
}
if (!text || text.length < 1) {
return { type: "answer", answer: "Jag kan hjälpa dig! Vill du att jag kollar vädret, drar ett skämt eller ska jag söka i vår kunskapsbas åt dig?", messages, model: "gpt-4o-mini" };
}
return { type: "answer", answer: text, messages, model: "gpt-4o-mini" };
}

// === KNOWLEDGE MODE RETURN ANSWER
let finalAnswer = text;
if (isFirstMessage && timeGreeting) {
if (!finalAnswer.toLowerCase().startsWith(timeGreeting.trim().toLowerCase())) {
finalAnswer = `${timeGreeting}${finalAnswer}`;
}
}
if (!finalAnswer || finalAnswer.length < 2) {
finalAnswer = "Jag hittar ingen information i vår kunskapsbas om det här.";
}
finalAnswer = finalAnswer;
return { type: "answer", answer: finalAnswer, messages, model: "gpt-4o-mini" };
}



// ====================================================================
// SECTION 6: KNOWLEDGE BASE INITIALIZATION (Runs Once)
// ====================================================================
const loadKnowledgeBase = () => {
console.log('Laddar kunskapsdatabas...\n');

let files = [];
try {
files = fs.readdirSync(KNOWLEDGE_PATH);
} catch (err) {
console.error(`[FATAL FILE ERROR] Kunde inte läsa: ${KNOWLEDGE_PATH}`);
console.error(`Fel: ${err.message}`);
process.exit(1);
}

let tempChunks = [];
let officeCount = 0;
let basfaktaCount = 0;
let hybridCount = 0;
knownCities = [];
cityOffices = {};
officePrices = {};

files.forEach(file => {
const filePath = path.join(KNOWLEDGE_PATH, file);
try {
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Räknare för denna fil
let fileChunksCreated = 0;
let fileType = '';

// =================================================================
// SPECIAL: Hantera nollutrymme FÖRST
// =================================================================
if (file === 'basfakta_nollutrymme.json') {
if (data.sections && Array.isArray(data.sections)) {
criticalAnswers = data.sections; 
console.log(`✅ Laddade ${criticalAnswers.length} kritiska svar från nollutrymme`);
}
}

// =================================================================
// STEG 1: Kontrollera filtyp
// =================================================================
const hasBasfakta = file.startsWith('basfakta_') || (data.sections && Array.isArray(data.sections) && data.sections.length > 0);
const hasOfficeData = data.city && data.prices && Array.isArray(data.prices);

// =================================================================
// STEG 2A: BASFAKTA-DATA (kan kombineras med kontorsdata)
// =================================================================
if (hasBasfakta) {
const contentData = data.sections || data.content || [];

if (Array.isArray(contentData) && contentData.length > 0) {
contentData.forEach((section, idx) => {
const chunk = {
id: `${file}_${idx}`,
title: section.title || "Info",
text: section.answer || section.content || '',
keywords: section.keywords || [],
type: 'basfakta',
source: file,
// NYTT: Bevara score_boost om den finns
...(section.score_boost && { score_boost: section.score_boost })
};
tempChunks.push(chunk);
fileChunksCreated++;
});

if (!hasOfficeData) {
basfaktaCount++;
fileType = 'basfakta';
}
}
}

// =================================================================
// STEG 2B: STADS/KONTOR-DATA (kan kombineras med basfakta)
// =================================================================
if (hasOfficeData) {
const cityKey = data.city.toLowerCase();

// Initiera officeData struktur
if (!officeData[cityKey]) officeData[cityKey] = [];
officeData[cityKey].push(data);

// Spara kontaktdata
if (!officeContactData[cityKey]) officeContactData[cityKey] = data;
if (data.id) officeContactData[data.id.toLowerCase()] = data;

officeCount++;
const officeName = data.area ? `${data.city} - ${data.area}` : data.city;

// Registrera område och stad
if (data.city && data.area) {
knownAreas[data.area.toLowerCase()] = data.city;
}
if (!knownCities.includes(data.city)) {
knownCities.push(data.city);
}
if (!cityOffices[data.city]) {
cityOffices[data.city] = [];
}
cityOffices[data.city].push(officeName);

const priceData = { AM: null, BIL: null, MC: null, LASTBIL: null, INTRO: null };
const bookingLinks = data.booking_links || null;

// Skapa prischunks från varje pris
let priceChunksCreated = 0;
data.prices.forEach(price => {
let vehicle = extractVehicle(price.service_name);
if (!vehicle && /(mc|motorcykel|a1|a2|a-körkort)/i.test(price.service_name)) {
vehicle = "MC";
}

let linkKey = vehicle;
if (linkKey === 'BIL') linkKey = 'CAR';
const bookingUrl = (bookingLinks && linkKey) ? bookingLinks[linkKey] : null;

if (vehicle) {
if (!priceData[vehicle]) priceData[vehicle] = price.price;

const priceChunk = {
id: `${file}_price_${vehicle}_${price.service_name.replace(/\s+/g, '_')}`,
title: `${price.service_name} i ${officeName}`,
text: `${price.service_name} kostar ${price.price} SEK i ${officeName}.`,
city: data.city,
area: data.area || null,
office: officeName,
vehicle: vehicle,
price: price.price,
service_name: price.service_name,
booking_url: bookingUrl,
booking_links: bookingLinks,
keywords: [
...(price.keywords || []),
data.city,
vehicle,
'pris',
'kostnad',
`${price.price}`,
officeName,
...(data.area ? [data.area] : [])
],
type: 'price',
source: file
};
tempChunks.push(priceChunk);
priceChunksCreated++;
fileChunksCreated++;
}
});

// Skapa kontorchunk
const kontorDoc = {
id: `kontor_${file}`,
title: `Kontor i ${data.city} - ${data.area || 'generellt'}`,
text: `Kontor i ${data.city} ${data.area || ''}.`,
city: data.city,
area: data.area || null,
office: officeName,
booking_links: bookingLinks,
type: 'kontor_info',
source: file
};
tempChunks.push(kontorDoc);
fileChunksCreated++;
officePrices[officeName] = priceData;

// Bestäm filtyp baserat på kombination
if (hasBasfakta) {
fileType = 'hybrid';
hybridCount++;
} else {
fileType = 'kontor';
}
}

// =================================================================
// STEG 3: LOGGA RESULTAT FÖR DENNA FIL
// =================================================================
if (fileChunksCreated > 0) {
let logMessage = `✅ ${file}: `;

if (fileType === 'hybrid') {
const basfaktaChunks = tempChunks.filter(c => c.source === file && c.type === 'basfakta').length;
const priceChunks = tempChunks.filter(c => c.source === file && c.type === 'price').length;
logMessage += `${basfaktaChunks} basfakta + ${priceChunks} pris + 1 kontor (HYBRID 🔀)`;
} else if (fileType === 'basfakta') {
logMessage += `${fileChunksCreated} basfakta-chunks`;
} else if (fileType === 'kontor') {
const priceChunks = tempChunks.filter(c => c.source === file && c.type === 'price').length;
logMessage += `${priceChunks} prischunks + 1 kontorchunk`;
if (data.area) logMessage += ` för ${data.city} - ${data.area}`;
else logMessage += ` för ${data.city}`;
}

console.log(logMessage);
} else if (!hasBasfakta && !hasOfficeData) {
console.log(`⚠️  ${file}: Okänd filstruktur (varken basfakta eller stadsfil)`);
}

} catch (err) {
console.error(`❌ [FEL] Kunde inte läsa eller parsa fil: ${filePath}`, err.message);
}
});

// Tilldela globala chunks
allChunks = [...tempChunks];

// Hjälpfunktion för att extrahera fordonstyp
function extractVehicle(text) {
const lower = (text || "").toLowerCase();
if (/(^|\b)(am|moped|moppe)\b/.test(lower)) return "AM";
if (/(^|\b)(b96|be|släp)\b/.test(lower)) return "SLÄP";
if (/(^|\b)(bil|personbil)\b/.test(lower)) return "BIL";
if (/(^|\b)(mc|a1|a2|motorcykel|motorcyklar)\b/.test(lower)) return "MC";
if (/(^|\b)(lastbil|c1|c|ce|ykb)\b/.test(lower)) return "LASTBIL";
if (/(^|\b)(introduktion|handledarkurs|handledare|handledarutbildning)\b/.test(lower)) return "INTRO";
return null;
}

// =================================================================
// MINISEARCH INITIALISERING
// =================================================================
if (miniSearch) {
try { miniSearch.removeAll(); } catch (e) {}
}

// Detaljerad diagnostik
console.log("\n🕵️ DIAGNOS: LADDADE FILER I MINNET:");
const uniqueSources = [...new Set(allChunks.map(c => c.source))];
uniqueSources.forEach(s => console.log(`   📄 Fil: "${s}"`));
console.log(`   Totalt antal filer: ${uniqueSources.length}`);
console.log(`   Totalt antal chunks: ${allChunks.length}`);
console.log(`   📂 Filtyper: ${basfaktaCount} basfakta, ${officeCount} kontor, ${hybridCount} hybrid`);

// Specifik diagnostik för olika chunk-typer
const cityChunks = allChunks.filter(c => c.type === 'price' || c.type === 'kontor_info');
console.log(`   🏙️  Stads-chunks (pris + kontor): ${cityChunks.length}`);

const basfaktaChunks = allChunks.filter(c => c.type === 'basfakta');
console.log(`   📚 Basfakta-chunks: ${basfaktaChunks.length}`);

// Nollutrymme-specifik kontroll
const nollChunks = allChunks.filter(c => c.source && c.source.includes('nollutrymme'));
console.log(`   🛡️  Nollutrymme chunks: ${nollChunks.length}`);
console.log(`   🎯 Kritiska svar (nollutrymme): ${criticalAnswers.length}`);

miniSearch = new MiniSearch({
fields: ['title', 'text', 'city', 'area', 'office', 'keywords', 'vehicle'],
storeFields: ['title', 'text', 'city', 'area', 'office', 'vehicle', 'type', 'price', 'id', 'booking_url', 'booking_links'],
searchOptions: {
prefix: true,
fuzzy: 0.2,
boost: {
keywords: 6,
office: 5,
city: 4,
area: 3,
vehicle: 2,
title: 3,
text: 1
}
}
});

miniSearch.addAll(allChunks);
rebuildChunkMap();

// Initiera IntentEngine
try {
intentEngine = new IntentEngine(knownCities, CITY_ALIASES, VEHICLE_MAP, knownAreas);
console.log('[IntentEngine] ✅ Motor initierad (Legacy).');
} catch (e) {
console.error('[FATAL] Kunde inte initiera IntentEngine:', e.message);
}
console.log('\n✅ Kunskapsbas fullständigt laddad!\n');
};

// Starta initiering
loadKnowledgeBase();

// ====================================================================
// SECTION 7: THE CORE EXECUTION ENGINE (Stateless Wrapper)
// ====================================================================
async function runLegacyFlow(payload, contextFromDB, templatesFromDB) {
return new Promise(async (resolve, reject) => {

// 1. SETUP: Mock Request/Response & Session Injection
const req = {body: payload,headers: {},id: 'LEGACY_CALL'};
let sessionId = req.body.sessionId || generateSessionId(); 

// 2. Injicera state direkt
injectSessionState(sessionId, contextFromDB);

// 3. Säkra att sessionen finns i minnet
if (!sessions.has(sessionId)) {createEmptySession(sessionId);}

// 4. Mock Response Object som returnerar data till V2-servern
const res = {
json: (data) => resolve({ 
response_payload: data, 
new_context: getSessionState(sessionId) // Skickar alltid med state
}),
status: (code) => {

return {
json: (errData) => resolve({ 
error: errData, 
statusCode: code,
new_context: getSessionState(sessionId) // Skickar alltid med state även vid fel
})
}
},
send: (msg) => resolve({ 
msg,
new_context: getSessionState(sessionId)
})
};

// VARIABLER UTANFÖR TRY (För att scope ska funka i catch)
let nluResult = null;
let session = null;
let queries = [];

try {

// STEP 2: INPUT VALIDATION & PRE-PROCESSING
const isFirstMessage = req.body.isFirstMessage || false;

if (Array.isArray(req.body.queries) && req.body.queries.length > 0) {
queries = req.body.queries;
} else if (req.body.query) {
queries = [req.body.query];
} else if (req.body.question) {
queries = [req.body.question];
} else {
return res.status(400).json({ error: 'Query saknas' });
}

const query = queries[0] || "";

if (!query.trim()) {
return res.status(400).json({ error: 'Tom fråga mottagen' });
}

const queryLower = (query || '').toLowerCase();
let forceHighConfidence = false;

// SESSIONSHANTERING - Hämta sessionen igen (referens för användning nedan)
session = sessions.get(sessionId);

// === SNABB-VAKT FÖR NOLLUTRYMME (Återställer snabbhet & stoppar timeouts) ===
const queryLowerClean = query.toLowerCase().trim().replace(/[?!.]/g, '');

const emergencyMatch = (criticalAnswers || []).find(entry => 
entry.keywords && Array.isArray(entry.keywords) && 
entry.keywords.some(kw => queryLowerClean === kw.toLowerCase())
);

if (emergencyMatch) {
console.log(`🛡️ Snabbmatch Nollutrymme: ${emergencyMatch.id}`);
return res.json({
answer: emergencyMatch.answer,
sessionId: sessionId,
locked_context: session.locked_context || { city: null, area: null, vehicle: null }
});
}

// STEP 3: INTENT & CONTEXT RESOLUTION - Här avgör vi VAD kunden vill och VAR de befinner sig.
const lockedContext = session.locked_context || {};
const contextPayload = lockedContext;
nluResult = intentEngine.parseIntent(query, contextPayload);

const detectedCity = nluResult.slots.city;
const detectedArea = nluResult.slots.area;
const lockedCity = lockedContext.city || detectedCity;
const detectedVehicleType = nluResult.slots.vehicle || lockedContext.vehicle;
const wasFirstMessage = isFirstMessage;

// ====================================================================
// STEP 4: INTELLIGENT MODE SWITCHING (SÄKERHETSPRINCIP: RAG FIRST)
// ====================================================================

// 1. Initiera variabler
let forcedMode = null;
let mode = 'knowledge'; // Vi utgår ALLTID från att det är knowledge (Säkrast)

// 2. Definiera vad som FÅR vara Chat (Småprat & Tools)
const strictChatTriggers = [
"väder", "skämt", "vits", "citat", "bild", "rita", "generera", 
"hej", "tja", "tjena", "hallå", "god morgon", "god kväll", "goddag",
"tack", "tusen tack", "schysst", "vem är du", "vad heter du",
"bot", "människa", "personal", "leva", "mår du"
];

// 3. Definiera "RAG-ord" (Affärsdata) - Dessa tvingar fram RAG
// VIKTIGT: Variabelnamnet är ragBlockers.
const ragBlockers = [
"pris", "kostar", "boka", "betala", "faktura", "pengar", "offert", "rabatt",
"körkort", "paket", "kurser", "utbildning", "bil", "mc", "am", "moped", 
"lastbil", "släp", "risk", "halkbana", "handledare", "intro", "teori",
"intensiv", "lektion", "övningskör", "syn", "tillstånd",
"regler", "ålder", "gäller", "tid", "när", "var", "hitta", "adress", 
"telefon", "kontakt", "öppettider", "support", "hjälp", "info",
"fungerar", "vad är", "skillnad", "krav", "giltig", "ansöka",
"steg", "utbildningskontroll", "prov", "uppkörning", "ykb", "fallback", "förstår inte", "kontor",
"moms", "swish", "klarna", "avgift"
];

// 4. BEHÅLL DIN BEFINTLIGA LOGIK FÖR PRIS-SÖKNINGAR
if (session.locked_context.vehicle && session.locked_context.city && nluResult.slots.area && nluResult.intent === 'unknown') {
const lastUserMsg = session.messages.filter(m => m.role === 'user').slice(-2, -1)[0];
if (lastUserMsg && /pris|kostar|kostnad/i.test(lastUserMsg.content)) {
forcedMode = 'knowledge';
nluResult.intent = 'price_lookup';
}
}

// 5. Analysera innehållet
const queryCheck = queryLower || "";
const containsChatTrigger = strictChatTriggers.some(kw => queryCheck.includes(kw));
const containsRagKeyword = ragBlockers.some(kw => queryCheck.includes(kw));

// 6. BESLUTSLOGIK
if (forcedMode) {
mode = forcedMode; // Om tidigare logik tvingat ett läge
} 
else if (nluResult.intent === 'weather') {
mode = 'chat'; // Specifikt väder-intent från IntentEngine
}
else if (containsChatTrigger) {
// Om användaren säger "Hej" eller "Väder"...
if (containsRagKeyword) {
// ...men också säger ett ord från ragBlockers -> Då är det RAG!
mode = 'knowledge'; 
console.log(`[MODE] Chat-ord hittat ("${queryCheck}"), MEN "ragBlockers" matchade också. Tvingar RAG.`);
} else {
// ...och inga tunga ord finns -> Då är det Chat.
mode = 'chat'; 
}
} 
else {
// STANDARDLÄGE: Om vi inte vet vad det är -> KÖR RAG.
mode = 'knowledge';
}

// Kontaktinfo ska ALLTID vara knowledge (Säkerhetsspärr)
if (nluResult.intent === 'contact_info') mode = 'knowledge';

console.log(`[MODE SWITCH] Valde läge: ${mode} (Intent: ${nluResult.intent})`);

// STEP 5: SEARCH & RETRIEVAL (Här börjar nästa sektion i din fil)

let searchQuery = query;

// Om vi har ett specifikt område (t.ex. "Ullevi" eller "Stora Holm") Lägg till det i söksträngen för att boosta träffar.
if (detectedArea && !query.toLowerCase().includes(detectedArea.toLowerCase())) {
searchQuery = `${query} ${detectedArea}`;
} 

// Om vi vet staden men inget område, lägg till staden för tydlighet
else if (detectedCity && !query.toLowerCase().includes(detectedCity.toLowerCase()) && !detectedArea) {
searchQuery = `${query} ${detectedCity}`;
}

const expandedQuery = normalizedExpandQuery(searchQuery);

// 1. GÖR GRUNDSÖKNINGEN - Hämtar allt som tekniskt matchar orden i din databas.
const allResults = miniSearch.search(expandedQuery, {
fuzzy: 0.2, prefix: true,
boost: { keywords: 6, office: 5, city: 4, area: 3, vehicle: 2, title: 3, text: 1 }
});

// 2. SMART STADSFILTRERING (Hard Filter) Skyddar mot att blanda ihop städer (t.ex. Eslöv vs Göteborg).
let filteredRawResults = allResults;
const targetCity = lockedCity || detectedCity; 

if (targetCity) {
const targetCityLower = targetCity.toLowerCase();

filteredRawResults = allResults.filter(result => {
const chunk = allChunks.find(c => c.id === result.id);
if (!chunk) return false;

// REGEL A: Behåll ALLTID "Basfakta" (som saknar city-property)..
if (!chunk.city) return true;

// REGEL B: Kasta bort fel stad.
if (chunk.city.toLowerCase() !== targetCityLower) {
return false; 
}

// REGEL C: Rätt stad -> Behåll
return true;
});
}

// 3. APPLICERA DIN BOOST-LOGIK - Vi bygger resultaten baserat på den FILTRERADE listan.
let uniqueResults = Array.from(new Map(filteredRawResults.map(item => [item.id, item])).values());

uniqueResults = uniqueResults.map(result => {
const fullChunk = allChunks.find(c => c.id === result.id);
if (fullChunk) {
let finalScore = result.score;

// Boosta område (t.ex. Stora Holm om kunden frågat om det)
if (detectedArea && fullChunk.area && fullChunk.area.toLowerCase() === detectedArea.toLowerCase()) finalScore += 600;
else if (detectedCity && fullChunk.city && fullChunk.city.toLowerCase() === detectedCity.toLowerCase() && !detectedArea) finalScore += 200;

if (detectedVehicleType && fullChunk.vehicle === detectedVehicleType) finalScore += 6000;

// Pris-boost (+2 miljoner) för att säkerställa att vi svarar med pris om det finns
if (detectedCity && detectedVehicleType && fullChunk.city && fullChunk.city.toLowerCase() === detectedCity.toLowerCase() && fullChunk.vehicle === detectedVehicleType && fullChunk.type === 'price') {
finalScore += 2000000;
}

return {...result, score: finalScore, type: fullChunk.type, keywords: fullChunk.keywords ?? [], text: fullChunk.text };
}
return { ...result, keywords: result.keywords ?? [], text: result.text };
});

// 4. SORTERA EFTER POÄNG
uniqueResults.sort((a, b) => b.score - a.score);

// 5. URVAL (Top 25)
let selectedChunks = uniqueResults.slice(0, 25);

// Fyll ut med generell info om vi har för få träffar.
// Vi fyller BARA på med Basfakta (chunks utan stad) för att inte smutsa ner resultatet.
if (selectedChunks.length < 15) {
const extra = allChunks.filter(c => 
!c.city && // Endast generella filer
!selectedChunks.map(s => s.id).includes(c.id)
).slice(0, 15 - selectedChunks.length);

// Mappa om för konsekvens
const extraMapped = extra.map(c => ({
id: c.id, score: 0, type: c.type, keywords: c.keywords || [], text: c.text
}));

selectedChunks = selectedChunks.concat(extraMapped);
}

// Uppdatera uniqueResults
uniqueResults = selectedChunks;

// === FIX: FÖRBÄTTRAD KONTAKTLISTA (Visa alla kontor i staden) ===
if (nluResult.intent === "contact_info" && (lockedCity || detectedArea)) {
uniqueResults = uniqueResults.map(r => {

// SÄKERHET: Garantera att r alltid har en giltig score
const baseScore = (typeof r.score === 'number' && !isNaN(r.score)) ? r.score : 0;

const fullChunk = allChunks.find(c => c.id === r.id);
if (!fullChunk) return { ...r, score: baseScore };

// Straffa fel område lite (om användaren bett om specifikt område)
if (detectedArea && fullChunk.area && fullChunk.area.toLowerCase() !== detectedArea.toLowerCase()) {
return { ...r, score: baseScore - 1000 }; 
}

const isCityMatch = fullChunk.city && lockedCity && fullChunk.city.toLowerCase() === lockedCity.toLowerCase();

// BOOST: Ge ALLA kontor i staden en enorm boost (300 000 poäng)
if ((fullChunk.type === 'office_info' || fullChunk.type === 'kontor_info') && isCityMatch) {
return { ...r, score: 300000 }; 
}

return { ...r, score: baseScore };
});

// Sortera direkt - med extra säkerhet
uniqueResults.sort((a, b) => {
const scoreA = (typeof a.score === 'number' && !isNaN(a.score)) ? a.score : 0;
const scoreB = (typeof b.score === 'number' && !isNaN(b.score)) ? b.score : 0;
return scoreB - scoreA;
});
}

let topResults = uniqueResults;
let mustAddChunks = [];

if (nluResult.intent === "contact_info") {
const officeInfoChunks = topResults.filter(r => { const fullChunk = allChunks.find(c => c.id === r.id); return fullChunk && fullChunk.type === 'office_info'; });
const kontorInfoChunks = topResults.filter(r => { const fullChunk = allChunks.find(c => c.id === r.id); return fullChunk && fullChunk.type === 'kontor_info'; });
const basfaktaChunks = topResults.filter(r => { const fullChunk = allChunks.find(c => c.id === r.id); return fullChunk && fullChunk.type === 'basfakta' && fullChunk.source && fullChunk.source.includes('basfakta_om_foretaget'); });

if (officeInfoChunks.length > 0) {
const otherChunks = topResults.filter(r => { const fullChunk = allChunks.find(c => c.id === r.id); return fullChunk && fullChunk.type !== 'office_info' && fullChunk.type !== 'kontor_info' && fullChunk.type !== 'price'; }).slice(0, 3);
topResults = [...officeInfoChunks, ...kontorInfoChunks, ...basfaktaChunks, ...otherChunks];
} else {
topResults = [...kontorInfoChunks, ...basfaktaChunks];
}
}

// KORREKT KOD: Skicka arrayen direkt. Inga måsvingar, inget "objekt-skräp".
const forceAddEngine = new ForceAddEngine(allChunks);

// KORREKT KOD: Skicka argumenten separat.
const forceAddResult = forceAddEngine.execute(queryLower, nluResult, lockedCity);

mustAddChunks.push(...forceAddResult.mustAddChunks);
if (forceAddResult.forceHighConfidence) forceHighConfidence = true;

if (Array.isArray(criticalAnswers) && forceAddResult.mustAddChunks.length === 0) {
for (const entry of criticalAnswers) {
const matches = entry.keywords && entry.keywords.some(kw => queryLower.includes(kw));
if (matches) {
const timeGreeting = wasFirstMessage ? "God morgon! " : "";
appendToSession(sessionId, 'assistant', timeGreeting + entry.answer);

return res.json({
sessionId: sessionId,
answer: timeGreeting + entry.answer,
emergency_mode: true,
context: [],
locked_context: { city: lockedContext.city, area: lockedContext.area, vehicle: lockedContext.vehicle },
debug: { nlu: nluResult, fallback_id: entry.id }
});
}
}
}

const allBasfakta = mustAddChunks.filter(c => isBasfaktaType(c));
allBasfakta.forEach(c => c.score *= 1.8);
mustAddChunks = [...allBasfakta, ...mustAddChunks.filter(c => !isBasfaktaType(c))];

if (detectedCity || detectedArea) {
const officeChunks = allChunks.filter(c => {
const isOfficeFile = c.source && !c.source.includes('basfakta_');

if (!isOfficeFile) return false;
const matchesCity = c.city && detectedCity && c.city.toLowerCase() === detectedCity.toLowerCase();
const matchesArea = detectedArea ? (c.area && c.area.toLowerCase() === detectedArea.toLowerCase()) : true;

return matchesCity && matchesArea;
});

const withBooking = officeChunks.filter(c => c.text?.toLowerCase().includes('boka här') || c.text?.toLowerCase().includes('boka') || (c.keywords || []).some(k => k.toLowerCase().includes('boka')));
const withoutBooking = officeChunks.filter(c => !withBooking.includes(c));
mustAddChunks.push(...withBooking);
mustAddChunks.push(...withoutBooking.slice(0, 3));
}

if (detectedArea && detectedCity) {
const areaResults = uniqueResults.filter(r => r.area && r.area.toLowerCase() === detectedArea.toLowerCase() && r.city === detectedCity);
const cityResults = uniqueResults.filter(r => r.city === detectedCity && (!r.area || r.area.toLowerCase() !== detectedArea.toLowerCase()));
const otherResults = uniqueResults.filter(r => r.city !== detectedCity);
topResults = [...areaResults, ...cityResults, ...otherResults];
} else if (detectedCity) {
const cityResults = uniqueResults.filter(r => r.city === detectedCity);
const otherResults = uniqueResults.filter(r => r.city !== detectedCity);
topResults = [...cityResults, ...otherResults];
}

const topResultsMap = new Map(topResults.map(r => [r.id, r]));
const requiredVehicle = detectedVehicleType;

mustAddChunks.forEach(chunk => {
let forcedScore = chunk.score || 0;
if (requiredVehicle && chunk.vehicle && chunk.vehicle.toUpperCase() === requiredVehicle.toUpperCase()) forcedScore = 10000;
else if (chunk.score && chunk.score > 0) forcedScore = chunk.score;
else forcedScore = 9999;
const forcedChunk = { ...chunk, score: forcedScore, match: { score: forcedScore } };
topResultsMap.set(chunk.id, forcedChunk);
});

topResults = Array.from(topResultsMap.values());
topResults.sort((a, b) => b.score - a.score);
topResults = topResults.slice(0, 18).filter(r => r.score > 0);

// === NYTT STÄDAT OCH FUNGERANDE BLOCK ===
if (!forceHighConfidence) {
const hasBasfakta = topResults.some(r => isBasfaktaType(r));
const bestScore = topResults[0]?.score || 0;
const isContactQuery = nluResult.intent === 'contact_info';
const threshold = isContactQuery ? 0.05 : LOW_CONFIDENCE_THRESHOLD;

if (!hasBasfakta && bestScore < threshold && nluResult.intent !== 'contact_info') {
const clarification = `För att ge ett korrekt svar behöver jag lite mer info — vilken stad eller vilket kontor menar du?`;
return res.json({ answer: clarification, context: [], debug: { low_confidence: true, best_score: bestScore } });
}
} 
// <--- HÄR STÄNGS DEN NU KORREKT. Koden nedanför körs oavsett om det är High Confidence eller inte.

// 1. Stadssäkring
if (lockedCity) {
topResults = topResults.filter(chunk => {
const chunkCity = (chunk.city || '').toString().toLowerCase();
return chunkCity === '' || chunkCity === lockedCity.toLowerCase();
});
}

// 2. Fordonssäkring & Filtrering
let filteredResults = topResults;
if (detectedVehicleType) {
filteredResults = topResults.filter(chunk => {
const noVehicle = !chunk.vehicle;
const matchesVehicle = chunk.vehicle === detectedVehicleType;
const isGeneral = chunk.type === 'basfakta' || chunk.type === 'office_info';
const isForceAdded = (chunk.score || 0) >= 9000; 
return noVehicle || matchesVehicle || isGeneral || isForceAdded;
});
}

// --- FIX: Rensa dubbletter och förhindra hängning ---
const uniqueMap = new Map();
filteredResults.forEach(r => {
if (!uniqueMap.has(r.id)) uniqueMap.set(r.id, r);
});

const uniqueTopResults = Array.from(uniqueMap.values()).slice(0, 10);
const MAX_CONTEXT_TOKENS = 2500; 
let contextTokens = 0;
const contextParts = [];

for (const r of uniqueTopResults) {
const chunk = allChunks.find(c => c.id === r.id);
if (!chunk) continue;
let text = `${r.title}: ${chunk.text || ''}`;
if (chunk.price) text += ` - ${chunk.price} SEK`;
const estimatedTokens = Math.ceil(text.length / 4);
if (contextTokens + estimatedTokens > MAX_CONTEXT_TOKENS) break;
contextParts.push(text);
contextTokens += estimatedTokens;
}
const retrievedContext = contextParts.join('\n\n');

// VIKTIGT: Deklarera variablerna en gång här
let ragResult;
let finalAnswer; 

console.log("DEBUG: Skickar till OpenAI...");
try {
ragResult = await generate_rag_answer(query, retrievedContext, detectedCity, detectedArea, wasFirstMessage, mode);
console.log("DEBUG: OpenAI svarade!");
} catch (e) {
console.error("!!! OPENAI ERROR:", e.message);
return res.json({ answer: "Tekniskt fel vid AI-anrop.", sessionId: sessionId });
}

if (ragResult.type === 'answer') {
finalAnswer = ragResult.answer;
} else if (ragResult.type === 'tool_request') {
try {
const initial = await openai.chat.completions.create(
{
model: ragResult.model,
messages: ragResult.messages,
tools: ragResult.tools,
max_tokens: ragResult.max_tokens,
temperature: ragResult.temperature
},
{ timeout: 15000 }
);

const msg = initial.choices?.[0]?.message;

if (!msg?.tool_calls || msg.tool_calls.length === 0) {
finalAnswer = msg?.content?.trim() || 'Jag kunde inte formulera ett svar.';
} else {
const toolResults = [];

for (const call of msg.tool_calls) {
// Parsar arguments på ett säkert sätt
let args = {};
try {
args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
} catch (e) {
args = {};
}

// Kör verktyget med try/catch
let result;
try {
switch (call.function?.name) {
case "get_weather":
result = await fetchWeather(args.city);
break;
case "get_joke":
result = await get_joke();
break;
case "get_quote":
result = await get_quote();
break;
case "calculate_price":
result = await calculate_price(args.amount, args.unit_price);
break;
case "generate_image":
result = await generate_image(args.prompt);
break;
default:
result = { error: `Okänt verktyg: ${call.function?.name}` };
}
} catch (toolError) {
result = { error: `Kunde inte köra ${call.function?.name}` };
}

toolResults.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
}

// Skicka resultatet till OpenAI igen för slutgiltigt svar
try {
const final = await openai.chat.completions.create(
{
model: ragResult.model,
messages: [...ragResult.messages, msg, ...toolResults],
max_tokens: 600,
temperature: 0.7
},
{ timeout: 15000 }
);
finalAnswer = final?.choices?.[0]?.message?.content?.trim() || 'Tekniskt fel.';
} catch (finalError) {
console.error("ERROR: Slutgiltigt OpenAI-anrop misslyckades:", finalError);
finalAnswer = 'Ett tekniskt fel uppstod vid generering av svar.';
}
}
} catch (chatError) {
console.error("ERROR: Chat-läget kraschade:", chatError);
finalAnswer = 'Något gick fel i chat-läget. Försök igen.';
}
}

// STEP 7: POST-PROCESSING (Booking Links)


const GENERAL_FALLBACK_LINKS = {
'AM': { type: 'info', text: 'Boka din AM-kurs via vår hemsida här', linkText: 'här', url: 'https://mydrivingacademy.com/two-wheels/ta-am-korkort/' },
'MC': { type: 'info', text: 'För mer MC-information, kolla vår hemsida', linkText: 'hemsida', url: 'https://mydrivingacademy.com/two-wheels/home/' },
'CAR': { type: 'info', text: 'För mer information om bilkörkort, kolla vår hemsida', linkText: 'hemsida', url: 'https://mydrivingacademy.com/kom-igang/' },
'INTRO': { type: 'book', text: 'Boka Handledarkurs/Introduktionskurs här', linkText: 'här', url: 'https://mydrivingacademy.com/handledarutbildning/' },
'RISK1': { type: 'book', text: 'Boka Riskettan (Risk 1) här', linkText: 'här', url: 'https://mydrivingacademy.com/riskettan/' },
'RISK2': { type: 'book', text: 'Boka Risktvåan/Halkbana (Risk 2) här', linkText: 'här', url: 'https://mydrivingacademy.com/halkbana/' },
'TEORI': { type: 'book', text: 'Plugga körkortsteori i appen Mitt Körkort här', linkText: 'här', url: 'https://mydrivingacademy.com/app/' },
'B96/BE': { type: 'book', text: 'Boka Släpvagnsutbildning (B96/BE) här', linkText: 'här', url: 'https://mydrivingacademy.com/slapvagn/' },
'TUNG': { type: 'book', text: 'Boka utbildning för Tung Trafik (C/CE) här', linkText: 'här', url: 'https://mydrivingacademy.com/tungtrafik/' },
'POLICY': { type: 'info', text: 'Läs våra köpvillkor och policy här', linkText: 'här', url: 'https://mydrivingacademy.com/privacy-policy/' }
};

let bookingLinkAdded = false;
let finalBookingLink = null;
let linkVehicleType = null;

const officeChunk = topResults.find(r => r.booking_links && typeof r.booking_links === 'object');
if (officeChunk && officeChunk.booking_links) {
const links = officeChunk.booking_links;
let serviceKey = null;
if (detectedVehicleType) {
serviceKey = detectedVehicleType.toUpperCase();
if (serviceKey === 'BIL') serviceKey = 'CAR';
} else if (/\bam\b/.test(queryLower) || queryLower.includes('moped')) {
serviceKey = 'AM';
} else if (/\bmc\b/.test(queryLower) || queryLower.includes('motorcykel')) {
serviceKey = 'MC';
} else {
const topPriceChunk = topResults.find(r => r.type === 'price' && r.vehicle);
if (topPriceChunk && topPriceChunk.vehicle) serviceKey = topPriceChunk.vehicle === 'BIL' ? 'CAR' : topPriceChunk.vehicle;
}
if (!serviceKey && session.detectedVehicleType) {
const sessionVehicleKey = session.detectedVehicleType.toUpperCase();
if (links[sessionVehicleKey]) serviceKey = sessionVehicleKey;
}
if (!serviceKey) serviceKey = links.AM ? 'AM' : links.MC ? 'MC' : links.CAR ? 'CAR' : null;

if (serviceKey && links[serviceKey]) {
finalBookingLink = links[serviceKey];
linkVehicleType = serviceKey;
bookingLinkAdded = true; 
}
}

if (!bookingLinkAdded) {
let fallbackType = null;
if (queryLower.includes('policy') || queryLower.includes('villkor') || queryLower.includes('orgnr') || queryLower.includes('faktura')) {
const fallbackData = GENERAL_FALLBACK_LINKS['POLICY'];
if (fallbackData) {
const markdownLink = `[${fallbackData.linkText}](${fallbackData.url})`;
finalAnswer += `\n\n---\n\n${fallbackData.text.replace(fallbackData.linkText, markdownLink)}`;
bookingLinkAdded = true;
}
} else if (detectedVehicleType) {
fallbackType = detectedVehicleType.toUpperCase();
if (fallbackType === 'BIL') fallbackType = 'CAR';
} else if (/\bam\b/.test(queryLower) || queryLower.includes('moped')) fallbackType = 'AM';
else if (/\bmc\b/i.test(queryLower) || queryLower.includes('motorcykel')) fallbackType = 'MC';
else if (queryLower.includes('handledar')) fallbackType = 'INTRO';
else if (queryLower.includes('risk 1')) fallbackType = 'RISK1';
else if (queryLower.includes('risk 2')) fallbackType = 'RISK2';
else if (queryLower.includes('teori')) fallbackType = 'TEORI';
else if (queryLower.includes('tung trafik')) fallbackType = 'TUNG';
else if (queryLower.includes('lektion')) fallbackType = 'CAR';

if (fallbackType) {
const fallbackData = GENERAL_FALLBACK_LINKS[fallbackType];
if (fallbackData) {
finalBookingLink = fallbackData.url;
linkVehicleType = fallbackType;
bookingLinkAdded = true; 
}
}
}

if (finalBookingLink) {
const vehicleKey = (linkVehicleType || 'CAR').toUpperCase().replace('BIL', 'CAR'); 
const isExplicitRequest = nluResult.intent === 'booking_link' || nluResult.intent === 'booking' || nluResult.intent === 'contact_info' || /bokningslänk|länk/i.test(query);
const linkAlreadySent = session.linksSentByVehicle[vehicleKey] === true;

if (isExplicitRequest || !linkAlreadySent) {
let linkText;
switch (vehicleKey) {
case 'MC': linkText = 'Boka din MC-kurs här'; break;
case 'AM': linkText = 'Boka din AM-kurs här'; break;
case 'CAR': default: linkText = 'Boka din körlektion här'; break;
}
finalAnswer += `\n\n✅ [${linkText}](${finalBookingLink})`;
session.linksSentByVehicle[vehicleKey] = true;
} 
}

// STEP 8: FINALIZATION & CLEANUP
appendToSession(sessionId, 'assistant', finalAnswer);

// --- UPPDATERA SESSIONEN I MINNET FÖRST - Vi måste spara det vi räknat ut till sessionen, så att getSessionState()
// i res-objektet får med sig den senaste datan.
if (session) {
session.locked_context = { 
city: lockedContext.city || detectedCity || null,
area: lockedContext.area || detectedArea || null,
vehicle: lockedContext.vehicle || detectedVehicleType || null
};

// Spara även flaggor - De uppdateras redan löpande i koden ovan, men bra att veta
if (session.linksSentByVehicle) {
}
}

console.log(`[DEBUG] Slutgiltigt antal chunks: ${topResults.length}`);
if (topResults.length === 0) {
console.log(`[DEBUG] VARNING: Resultatet blev tomt! forceHighConfidence: ${forceHighConfidence}, lockedCity: ${lockedCity}`);
}

// 2. Skicka sedan svaret men behåll ALL din existerande logik för context
res.json({
sessionId: sessionId,
answer: finalAnswer, 
context: topResults.map(r => ({ title: r.title, text: r.text.slice(0, 200), city: r.city, type: r.type, score: r.score })),
locked_context: { 
city: detectedCity || lockedContext.city || null,
area: detectedArea || lockedContext.area || null,
vehicle: detectedVehicleType || lockedContext.vehicle || null 
},
debug: { nlu: nluResult, detected_city: lockedCity, detected_area: detectedArea, chunks_used: topResults.length }
});
} catch (e) {
console.error(`[FATAL ERROR] ${e.message}\n${e.stack}`);
res.status(500).json({
answer: 'Jag förstår inte riktigt vad du menar nu? Kan du omformulera din fråga.',
sessionId: sessionId
});
} finally {
    // ✅ 26/12 RADERA INTE SESSIONEN - State returneras via getSessionState()
    // Sessions rensas automatiskt vid nästa anrop
}
});
}

// ====================================================================
// SECTION 8: STATELESS BRIDGES (Interface for V2 DB)
// ====================================================================
function injectSessionState(sessionId, contextData) {
if (!contextData) return;
if (!sessions.has(sessionId)) {createEmptySession(sessionId);}
const session = sessions.get(sessionId);

// Mappa databas-fält till session-objektet
if (contextData.locked_context) {
session.locked_context = contextData.locked_context;}
if (contextData.linksSentByVehicle) {session.linksSentByVehicle = contextData.linksSentByVehicle;}
if (contextData.messages) {session.messages = contextData.messages;}
}

// ====================================================================
// STATE EXTRACTION HELPER (Get modified state back to V2 DB)
// ====================================================================
function getSessionState(sessionId) {
const session = sessions.get(sessionId);
if (!session) return {};

return {
locked_context: session.locked_context,
linksSentByVehicle: session.linksSentByVehicle,
messages: session.messages
};
}

module.exports = { runLegacyFlow };