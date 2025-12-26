// /patch/intentEngine.js Version. 1.9.2 (SLUTGILTIG FIX: Förbättrade intent-matchningar baserat på logg)

const INTENT_PATTERNS = {
price: /(vad kostar|pris|hur mycket|kostar det|pris för|vad tar ni|pris på|prislista|finns pris)/i,
discount: /(rabatt|erbjudande|rea|kampanj|studentrabatt|rabatter)/i,
booking: /(boka|bokning|bokar|ledig tid|bokningslänk|bokningssida|hur bokar)/i,
policy: /(avboka|ånger|återbetalning|avbokning|vab|villkor|ångerrätt|avbokningsregler|policy|kundavtal|faktura\s?(adress|till)|vart\s?skicka|skicka\s?till|betala|giltighet)/i,
risk: /\b(risk ?1|riskettan|risk ?2|risktvåan|halkbana)\b/i,
intent_info: /(vad är|beskriv|förklara|vad innebär|definition|hur fungerar)/i,
// Förstärkt: fångar flera varianter av "testlektion"
testlesson: /(testlektion|provlektion|prova[-\s]?på|prova[-\s]?på-?uppkörning|prov-?lektion|vad kostar(?:.*\s)?testlek(?:tion)?|kostar.*testlek(?:tion)?)/i,
// Förstärkt handledare-match (fångar ex "har haft körkort i 6 år", "6 år", mm)
handledare: /(handledare|introduktionskurs|introkurs|handledarkurs|\b\d{1,2}\s?år\b|\b\d+\s?års\b)/i,
// Tillstånd-relaterade triggers (körkortstillstånd mm)
tillstand: /(körkortstillstånd|tillstånd|körkortstillståndet|körkortstillståndet)/i,
// Specifik kontakt/adress-trigger
contact: /(adress|hitta|ligger|karta|telefon|telefonnummer|nummer|numret|kontakt|mail|öppettider|vart)/i,
weather: /\b(väder|vad är det för väder|temperatur|hur varmt|regn|snö|sol)\b/i

ykb: /\b(ykb|grundutbildning|fortbildning|140 timmar|35 timmar)\b/i,
age_limit: /\b(ålder|gammal|fyllt|när får man)\b/i,

};

const SERVICE_KEYWORD_MAP = [
// ... (Ingen ändring här)
{ term: "Körlektion BIL", kws: ["körlektion bil", "lektion bil"] },
{ term: "Testlektion Bil", kws: ["testlektion", "provlektion"] },
{ term: "Risk 1", kws: ["riskettan", "risk 1"] },
{ term: "Risk 2", kws: ["risktvåan", "risk 2", "halkbana"] },
{ term: "AM Mopedutbildning", kws: ["am-kurs", "am kurs", "mopedutbildning", "moppekort"] },
{ term: "Introduktionskurs", kws: ["introduktionskurs", "handledarkurs"] },
{ term: "Totalpaket", kws: ["totalpaket"] },
{ term: "Intensivkurs", kws: ["intensiv", "intensivutbildning", "intensivvecka"] }
];

function escapeRegex(str) {
return (str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class IntentEngine {
constructor(knownCities = [], cityAliases = {}, vehicleMap = {}, areas = {}) {
this.knownCities = knownCities.map(c => c.toLowerCase());
this.cityAliases = this.flattenAliases(cityAliases);
this.vehicleMap = vehicleMap;
this.areas = areas;
this.defaultConfidence = 0.2;
console.log(`[IntentEngine] Initierad med ${this.knownCities.length} städer och ${Object.keys(this.areas).length} områden.`);
}

flattenAliases(aliases) {
const flatMap = {};
for (const [alias, city] of Object.entries(aliases || {})) {
flatMap[this.norm(alias)] = this.norm(city);
}
return flatMap;
}

norm(s) {
return (s || "").toString()
.normalize('NFKC')
.trim()
.toLowerCase()
.replace(/[^\wåäö\s-]/g, '')
.replace(/\s+/g, ' ');
}

extractCity(queryLower, city) {
// Kontrollera alias först
for (const [alias, c] of Object.entries(this.cityAliases)) {
const a = this.norm(alias);
const re = new RegExp(`\\b${escapeRegex(a)}\\b`, 'i');
if (re.test(queryLower)) return c;
}

// Direkt match mot kända städer
for (const c of this.knownCities) {
const cc = this.norm(c);
const re = new RegExp(`\\b${escapeRegex(cc)}\\b`, 'i');
if (re.test(queryLower)) return cc;
}

// Fallback: den sparade staden i context
if (city) {
const sc = this.norm(city);
const re = new RegExp(`\\b${escapeRegex(sc)}\\b`, 'i');
if (re.test(queryLower)) return sc;
}
return null;
}

extractVehicle(queryLower, vehicle) {
// 1. Specifik YKB-check (Tvingar LASTBIL oavsett andra träffar)
if (/\b(ykb|grundutbildning|fortbildning|140 timmar|35 timmar)\b/i.test(queryLower)) {
return 'LASTBIL';
}

// 2. Standard-matchning mot vehicleMap
for (const [key, kws] of Object.entries(this.vehicleMap)) {
for (const kw of kws) {
const cleanKw = this.norm(kw);
const re = new RegExp(`\\b${escapeRegex(cleanKw)}\\b`, 'i');
if (re.test(queryLower)) {
return key;
}
}
}

// 3. Fallback: använd fordon från kontexten om ingen ny matchning hittades
if (vehicle) {
const sv = this.norm(vehicle);
// Här kollar vi om kontext-fordonet nämns, eller returnerar det helt enkelt
return vehicle.toUpperCase(); 
}

return null;
}

extractService(queryLower) {
for (const entry of SERVICE_KEYWORD_MAP) {
for (const kw of entry.kws) {
const cleanKw = this.norm(kw);
const re = new RegExp(`\\b${escapeRegex(cleanKw)}\\b`, 'i');
if (re.test(queryLower)) {
return entry.term;
}
}
}
return null;
}

parseIntent(rawQuery, context = {}) {
const query = this.norm(rawQuery || '');
const ql = query;

const slots = {
city: null,
area: null,
vehicle: null,
service: null
};

// 1. Identifiera Område (Area) FÖRST - och tvinga Stad
for (const [areaName, cityName] of Object.entries(this.areas)) {
const areaRegex = new RegExp(`\\b${escapeRegex(this.norm(areaName))}\\b`, 'i');
if (areaRegex.test(ql)) {
slots.area = areaName;
slots.city = cityName;
break;
}
}

// 2. Om ingen area hittades, sök stad som vanligt
if (!slots.city) {
slots.city = this.extractCity(ql, context.city || null);
}

// 3. Extrahera Fordon/Tjänst
slots.vehicle = this.extractVehicle(ql, context.vehicle || null);
slots.service = this.extractService(ql);

let intent = 'unknown';
let confidence = this.defaultConfidence;

// Intent logic (ordning viktig)
if (INTENT_PATTERNS.weather && INTENT_PATTERNS.weather.test(ql)) {
intent = 'weather';
confidence = 0.95;
} else if (INTENT_PATTERNS.testlesson.test(ql)) {
intent = 'testlesson_info';
confidence = 0.92;
} else if (INTENT_PATTERNS.risk.test(ql)) {
intent = 'risk_info';
confidence = 0.86;
} else if (INTENT_PATTERNS.handledare.test(ql)) {
intent = 'handledare_course';
confidence = 0.82;
} else if (INTENT_PATTERNS.tillstand && INTENT_PATTERNS.tillstand.test(ql)) {
intent = 'tillstand_info';
confidence = 0.8;
} else if (INTENT_PATTERNS.policy.test(ql)) {
intent = 'policy';
confidence = 0.85;
} else if (INTENT_PATTERNS.contact.test(ql)) {
intent = 'contact_info';
confidence = 0.8;
} else if (INTENT_PATTERNS.booking.test(ql)) {
intent = 'booking';
confidence = 0.76;
} else if (INTENT_PATTERNS.price.test(ql)) {
intent = 'price_lookup';
confidence = 0.75;
} else if (INTENT_PATTERNS.discount.test(ql)) {
intent = 'discount';
confidence = 0.7;
} else if (INTENT_PATTERNS.intent_info.test(ql)) {
intent = 'intent_info';
confidence = 0.65;
} else {
intent = 'unknown';
}

// Debug-logg
try {
console.log(`[IntentEngine] parseIntent -> query="${ql}", intent="${intent}", confidence=${confidence}, slots=${JSON.stringify(slots)}`);
} catch (e) {}

// Returnerar slots som redan är normaliserade; fallback till session/context där relevant
return {
intent,
confidence,
slots: {
city: slots.city || context.city || null,
area: slots.area || context.area || null,
vehicle: slots.vehicle || context.vehicle || null,
service: slots.service || context.service || null
}
};
}
}

module.exports = { IntentEngine, INTENT_PATTERNS };