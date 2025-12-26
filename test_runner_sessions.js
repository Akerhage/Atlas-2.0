const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// === INSTÄLLNINGAR ===
const SERVER_URL = 'http://localhost:3001/search_all';
const API_KEY = process.env.CLIENT_API_KEY;
const SUITE_FILE = 'tests/session_hybrid_tools.json';
const LOG_FILE = 'session_test_results.txt';
const DELAY_MS = 1500;

// === SEMANTISKA SYNONYMER ===
const TEST_SYNONYMS = {
'behöver gå': ['måste gå', 'krävs', 'genomföra', 'obligatorisk'],
'obligatorisk': ['krav', 'måste', 'krävs', 'obligatoriskt moment'],
'14 år och 9 månader': ['14 år och 9 månader', '14,5 år', '14 år 9 mån'],
'15 år': ['15 år', '15-åring', 'myndig moped'],
'16 år': ['16 år', '16-åring', 'övningsköra bil'],
'80 min': ['80 min', '80 minuter', 'standardlektion'],
'am': ['am', 'moped', 'moped klass 1', 'eu-moped', 'moppe'],
'mc': ['mc', 'motorcykel', 'a-behörighet', 'a1', 'a2'],
'bil': ['bil', 'personbil', 'b-körkort'],
'automat': ['automat', 'automatväxlad', 'villkor 78', 'kod 78'],
'risk 1': ['risk 1', 'riskettan', 'riskutbildning del 1'],
'risk 2': ['risk 2', 'risktvåan', 'halkbana', 'halka'],
'intro': ['introduktionskurs', 'handledarkurs', 'handledarutbildning'],
'pris': ['pris', 'kostar', 'kostnad', 'avgift'],
'kontakt': ['kontakt', 'telefon', 'ring', 'maila', 'e-post']
};

// === NORMALISERING ===
function normalizeForComparison(text) {
if (!text) return '';
let normalized = text.toLowerCase()
.replace(/[^a-zåäöüéè\s\d]/g, ' ')
.replace(/\s+/g, ' ')
.trim();

// Enhetlig åldersformat
normalized = normalized.replace(/(\d+)\s?år/g, '$1ar');
normalized = normalized.replace(/(\d+)\s?månader/g, '$1manader');

// Fix specifika termer
normalized = normalized.replace(/kod 78/g, 'villkor 78');
normalized = normalized.replace(/kvällslektioner/g, 'kväll');
normalized = normalized.replace(/halkbanan/g, 'risk 2');

return normalized;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runSessionTests() {
const suitePath = path.join(__dirname, SUITE_FILE);
if (!fs.existsSync(suitePath)) {
console.error(`❌ Saknas: ${suitePath}`);
return;
}

const scenarios = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
console.log(`🎬 Startar SESSIONSTEST med ${scenarios.length} scenarier...\n`);

// Rensa loggfil
fs.writeFileSync(LOG_FILE, `=== SESSION RESULTAT ${new Date().toLocaleString()} ===\n\n`);

let passedScenarios = 0;
let failedScenarios = 0;

for (const scenario of scenarios) {
console.log(`📹 SCENARIO: ${scenario.name}`);

// ✅ EN UNIK SESSION FÖR HELA SCENARIOT
const sessionId = crypto.randomBytes(16).toString('hex');
let isFirst = true;
let scenarioFailed = false;

// ❌ TA BORT: scenarioContext (servern hanterar det nu)

for (let i = 0; i < scenario.steps.length; i++) {
const step = scenario.steps[i];
process.stdout.write(`   [Steg ${i+1}] "${step.query}" -> `);

try {
// ✅ KORREKT PAYLOAD (Inga context-fält)
const payload = {
	query: step.query,
	sessionId: sessionId,
	isFirstMessage: isFirst
	// ❌ TA BORT: context (servern hanterar det via DB)
};

const startTime = Date.now();
const res = await axios.post(SERVER_URL, payload, {
	headers: { 
		'x-api-key': API_KEY, 
		'Content-Type': 'application/json' 
	},
	timeout: 20000
});
const duration = Date.now() - startTime;

const rawAnswer = res.data.answer || "";
const normalizedAnswer = normalizeForComparison(rawAnswer);

// ✅ LOGGA LOCKED_CONTEXT FÖR DEBUG
if (res.data.locked_context) {
	console.log(`\n      🔒 Context: City=${res.data.locked_context.city}, Vehicle=${res.data.locked_context.vehicle}`);
}

// --- VALIDERING ---
const missingExpect = [];
const foundForbidden = [];

// 1. Kolla EXPECT
if (step.expect) {
	step.expect.forEach(kw => {
		const normKw = normalizeForComparison(kw);
		let found = normalizedAnswer.includes(normKw);

		// Synonym-check
		if (!found && TEST_SYNONYMS[kw.toLowerCase()]) {
			found = TEST_SYNONYMS[kw.toLowerCase()].some(syn => 
				normalizedAnswer.includes(normalizeForComparison(syn))
			);
		}

		if (!found) missingExpect.push(kw);
	});
}

// 2. Kolla MISSING (Förbjudna ord)
if (step.missing) {
	step.missing.forEach(kw => {
		const normKw = normalizeForComparison(kw);
		if (normalizedAnswer.includes(normKw)) {
			foundForbidden.push(kw);
		}
	});
}

// --- RESULTAT ---
if (missingExpect.length === 0 && foundForbidden.length === 0) {
	console.log(`✅ OK (${duration}ms)`);
} else {
	console.log(`❌ FAIL`);
	scenarioFailed = true;

	if (missingExpect.length > 0) {
		console.log(`      Saknade ord: [${missingExpect.join(', ')}]`);
	}
	if (foundForbidden.length > 0) {
		console.log(`      Förbjudna ord hittades: [${foundForbidden.join(', ')}]`);
	}
	console.log(`      Svar: "${rawAnswer.slice(0, 150)}..."`);

	// Logga till fil
	const logEntry = [
		`--------------------------------------------------`,
		`[FAIL] SCENARIO: ${scenario.name}`,
		`STEG ${i+1}: "${step.query}"`,
		`SVAR: "${rawAnswer}"`,
		`SAKNADE: ${missingExpect.join(', ')}`,
		`FÖRBJUDNA: ${foundForbidden.join(', ')}`,
		`LOCKED_CONTEXT: ${JSON.stringify(res.data.locked_context)}`,
		`--------------------------------------------------\n`
	].join('\n');
	fs.appendFileSync(LOG_FILE, logEntry);
}

isFirst = false;

} catch (err) {
console.log(`🔥 ERROR: ${err.message}`);
scenarioFailed = true;

const errorLog = [
	`[ERROR] ${scenario.name} - Steg ${i+1}`,
	`Query: "${step.query}"`,
	`Error: ${err.message}`,
	`Stack: ${err.stack}\n`
].join('\n');
fs.appendFileSync(LOG_FILE, errorLog);
}

// Pausa mellan steg
await delay(DELAY_MS);
}

if (scenarioFailed) {
failedScenarios++;
console.log(`   ⚠️  Scenario misslyckades.\n`);
} else {
passedScenarios++;
console.log(`   🌟 Scenario klart utan anmärkning.\n`);
}
}

// === SUMMERING ===
const summary = `\n🏁 SESSIONSTEST KLART: ${passedScenarios} Lyckade, ${failedScenarios} Misslyckade\n`;
console.log(summary);
fs.appendFileSync(LOG_FILE, summary);

if (failedScenarios > 0) {
console.log(`📄 Detaljerad logg: ${LOG_FILE}`);
}
}

// === KÖR TESTER ===
runSessionTests().catch(err => {
console.error("💥 CRITICAL ERROR:", err);
process.exit(1);
});