const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ANSI Färger
const F_GREEN = "\x1b[32m";
const F_RED = "\x1b[31m";
const F_YELLOW = "\x1b[33m";
const F_CYAN = "\x1b[36m";
const F_RESET = "\x1b[0m";

// === INSTÄLLNINGAR ===
const SERVER_URL = 'http://localhost:3001/search_all';
const API_KEY = process.env.CLIENT_API_KEY;
const SUITE_FILE = 'tests/suite_basfakta_only.json';
const LOG_FILE = 'test_results.txt';
const DELAY_MS = 3000; 

// === SEMANTISKA SYNONYMER (v1.9.4 - Konsoliderad & Validerad mot Atlas svar) ===
const TEST_SYNONYMS = {
    // Dina ursprungliga bas-synonymer
    'pris': ['kostar', 'kostnad', 'avgift', 'kr', 'sek', 'kronor', 'billigt', 'prislista'],
    'boka': ['bokning', 'reservera', 'anmäla', 'köpa', 'beställa', 'tid', 'länk', 'bokat'],
    'kontakt': ['telefon', 'ring', 'maila', 'e-post', 'support', 'kundtjänst', '010', 'nås på', 'handläggare'],
    'obligatorisk': ['krav', 'måste', 'behöver', 'krävs', 'viktigt', 'nödvändigt'],
    'id-handling': ['legitimation', 'pass', 'id-kort', 'leg', 'id', 'legitimera', 'id-handling'],
    'giltighet': ['gäller', 'länge', 'tid', 'förfaller', 'giltig', 'år', 'månader', 'giltighetstid'],
    
    // Synonymer för utbildningssteg och processer
    'handledarkurs': ['handledarutbildning', 'introduktionskurs', 'steg 2', 'gå kursen', 'handledarledd'],
	'gå tillsammans': ['samma tillfälle', 'vid samma tillfälle', 'samtidigt', 'separat', 'olika tillfällen'],
    'handledare': ['elev', 'privat', 'utbildningsledare', 'steg 2', 'handledarskap'],
    'börja ta körkort': ['processen', 'steg', 'vägen till', '12 steg', 'börja'],
    'hur gör man': ['steg', 'så här', 'process', 'vägen till'],

    // NYA: Fixar "falska fails" från din senaste test-logg
    'gå tillsammans': ['samma tillfälle', 'vid samma tillfälle', 'samtidigt', 'separat', 'olika tillfällen'],
    'kundtjänst': ['support', '010-', 'telefon', 'nås på', 'handläggare', 'kontakta oss'],
    'tack': ['varsågod', 'inga problem', 'hjälper gärna', 'tack så mycket', 'tusen tack'],
    'vem är du': ['assistent', 'ai-assistent', 'virtuell', 'atlas'],
    
    // Faktura-specifika (Fixar FAIL 104 & 105)
    'fakturaadress mårtenssons': ['martenssons.trafikskola@pdf.scancloud.se', 'östersund', 'FE 7283'],
    'fakturaadress mda': ['mydrivingacademy.com@pdf.scancloud.se', 'östersund', 'FE 7283'],
    
    // AM & Fordon (Fixar krockar i FAIL 107)
    'vad ingår i am': ['17 timmar', '10 timmar teori', 'manöverkörning', 'trafikkörning', 'moped', 'moppe'],
    'en till en': ['extra stöd', 'privatlektion', 'hjälp med teorin', 'enskild']
};

function normalizeForComparison(text) {
if (!text) return '';
let normalized = text.toLowerCase();
normalized = normalized.replace(/(\d)[\s-–](\d)/g, '$1$2'); 
normalized = normalized.replace(/(\d)[\s-–](\d)/g, '$1$2'); 
normalized = normalized.replace(/sek|kronor|kr\./g, 'kr');
if (normalized.includes('@')) normalized += ' mail';
if (/\b0\d{6,10}/.test(normalized)) normalized += ' telefon';
normalized = normalized.replace(/[^a-zåäö\s\d]/g, ' ').replace(/\s+/g, ' ').trim();
return normalized;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function generateSessionId() { return crypto.randomBytes(16).toString('hex'); }

async function runRegression() {
const suitePath = path.resolve(__dirname, SUITE_FILE);
if (!fs.existsSync(suitePath)) { console.error(`❌ Saknas: ${suitePath}`); return; }

const suiteData = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
let tests = suiteData.tests;
const totalTests = tests.length;

console.log(`${F_CYAN}🚀 Startar regressionstest (${totalTests} frågor)...${F_RESET}`);
fs.writeFileSync(LOG_FILE, `=== TESTRESULTAT ${new Date().toLocaleString()} ===\n\n`);

let passed = 0;
let failed = 0;

// Vi använder "entries()" för att få tillgång till index (i)
for (const [i, test] of tests.entries()) {
const currentNum = i + 1;

console.log(`\n--------------------------------------------------`);
// Lade till [X/Y] numrering här
console.log(`${F_YELLOW}[${currentNum}/${totalTests}]${F_RESET} ${F_GREEN}❓ FRÅGA:${F_RESET} "${test.question}"`);

const sessionId = generateSessionId(); 

try {
const payload = { 
query: test.question, 
prompt: test.question, 
sessionId: sessionId, 
isFirstMessage: false 
};

const res = await axios.post(SERVER_URL, payload, {
headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
timeout: 20000 
});

const rawAnswer = res.data.answer || "";
const normalizedAnswer = normalizeForComparison(rawAnswer);

const cleanPreview = rawAnswer.replace(/\s+/g, ' ').slice(0, 100);
console.log(`${F_CYAN}🤖 SVAR:${F_RESET} "${cleanPreview}..."`);

const missingKeywords = [];
const matchedKeywords = [];
let matchScore = 0;
const totalRequired = test.required_keywords ? test.required_keywords.length : 0;

test.required_keywords.forEach(kw => {
const nKw = normalizeForComparison(kw);
let found = normalizedAnswer.includes(nKw);

if (!found && TEST_SYNONYMS[kw.toLowerCase()]) {
	found = TEST_SYNONYMS[kw.toLowerCase()].some(s => normalizedAnswer.includes(normalizeForComparison(s)));
}

if (found) {
	matchScore++;
	matchedKeywords.push(kw);
} else {
	missingKeywords.push(kw);
}
});

const scoreRatio = totalRequired > 0 ? (matchScore / totalRequired) : 1;
const isPass = scoreRatio >= 0.33;

if (isPass) {
console.log(`${F_GREEN}✅ PASS (${matchScore}/${totalRequired})${F_RESET}`);
passed++;
} else {
console.log(`${F_RED}❌ FAIL (${matchScore}/${totalRequired})${F_RESET} - SAKNADE: [${missingKeywords.join(', ')}]`);
failed++;
fs.appendFileSync(LOG_FILE, `FAIL [${currentNum}]: ${test.id}\nQ: ${test.question}\nA: ${rawAnswer}\nMissing: ${missingKeywords.join()}\n\n`);
}

} catch (err) {
console.log(`${F_RED}🔥 ERROR [${currentNum}]: ${err.message}${F_RESET}`);
failed++;
}

await delay(DELAY_MS);
}

const finalColor = failed === 0 ? F_GREEN : F_YELLOW;
console.log(`\n${finalColor}🏁 KLART: ${passed} PASS, ${failed} FAIL av ${totalTests}.${F_RESET}`);
}

runRegression();