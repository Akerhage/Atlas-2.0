// /utils/priceResolver.js version 1.6
// Den är strukturellt korrekt enligt roadmapen.

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  } else {
    return sorted[mid];
  }
}

function serviceMatchesChunk(serviceTerm, chunk) {
  if (!serviceTerm || !chunk) return false;
  const term = serviceTerm.toString().toLowerCase();
  
  // Exakt match på titel/tjänstnamn
  if (chunk.service_name && chunk.service_name.toLowerCase() === term) return true;
  if (chunk.title && chunk.title.toLowerCase() === term) return true;

  // Inkluderar-matchning
  if (chunk.service_name && chunk.service_name.toLowerCase().includes(term)) return true;
  if (chunk.title && chunk.title.toLowerCase().includes(term)) return true;

  if (chunk.keywords && Array.isArray(chunk.keywords)) {
    for (const kw of chunk.keywords) {
      if (term.includes(kw.toString().toLowerCase()) || kw.toString().toLowerCase().includes(term)) {
        return true;
      }
    }
  }
  return false;
}

function extractPriceChunksFromMap(chunkMap) {
  const out = [];
  if (!chunkMap) return out;
  if (chunkMap instanceof Map) {
    for (const [id, chunk] of chunkMap.entries()) {
      if (chunk && chunk.type === 'price' && chunk.price) {
        out.push({ id, ...chunk });
      }
    }
  }
  return out;
}

function resolvePrice({ officeId = null, city = null, serviceTerm = null, chunkMap = null, globalFallback = null }) {
  
  const allPriceChunks = extractPriceChunksFromMap(chunkMap);
  const matches = [];

  // 1) Försök matcha exakt kontor (officeId) OCH exakt tjänst (serviceTerm)
  if (officeId && serviceTerm) {
    for (const chunk of allPriceChunks) {
      const chunkOffice = (chunk.office || chunk.officeId || '').toString().toLowerCase();
      if (chunkOffice === officeId.toString().toLowerCase() && serviceMatchesChunk(serviceTerm, chunk)) {
         matches.push({ chunk, matchedOn: 'officeExactServiceExact' });
      }
    }
     if (matches.length > 0) {
      return {
        found: true,
        price: matches[0].chunk.price, // Ta första bästa exakta träff
        currency: matches[0].chunk.currency || 'SEK',
        source: 'office_exact',
        matches: matches.map(m => ({ id: m.chunk.id, service_name: m.chunk.title, price: m.chunk.price }))
      };
    }
  }

  // 2) Fallback: Matcha Stad (city) och tjänst (serviceTerm)
  if (city && serviceTerm) {
    const cityMatches = [];
    for (const chunk of allPriceChunks) {
      const chunkCity = (chunk.city || '').toString().toLowerCase();
      if (chunkCity === city.toString().toLowerCase() && serviceMatchesChunk(serviceTerm, chunk)) {
        cityMatches.push(chunk.price);
        matches.push({ chunk, matchedOn: 'cityExactServiceExact' });
      }
    }
    if (cityMatches.length > 0) {
      const priceValue = median(cityMatches); // Använd median för stadsfallback
      return {
        found: true,
        price: priceValue,
        currency: (matches[0] && matches[0].chunk && matches[0].chunk.currency) || 'SEK',
        source: 'city_fallback',
        matches: matches.map(m => ({ id: m.chunk.id, service_name: m.chunk.title, price: m.chunk.price }))
      };
    }
  }
  
  // 3) Global fallback (t.ex. för AM-standardpris)
   if (globalFallback && serviceTerm) {
    const key = Object.keys(globalFallback).find(k => k.toLowerCase() === serviceTerm.toLowerCase());
    if (key) {
      const entry = globalFallback[key];
      return {
        found: true,
        price: entry.price,
        currency: entry.currency || 'SEK',
        source: 'global_fallback',
        matches: [{ id: 'globalFallback', service_name: key, price: entry.price }]
      };
    }
  }

  return { found: false, source: 'none', matches: [] };
}

module.exports = {
  resolvePrice
};