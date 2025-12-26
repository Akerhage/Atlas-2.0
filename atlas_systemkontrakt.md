# ATLAS – SYSTEMKONTRAKT & LLM‑SKYDDSDOKUMENT (v1.0)

Detta dokument är **ground truth** för Atlas‑systemet.

**Syfte**
- Förhindra att LLM:er (eller människor) oavsiktligt bryter systemet
- Ge full överblick över filer, kontrakt, dataflöden och heliga strukturer
- Vara det ENDA dokument som får användas som referens vid kodändringar

---

## 0. Grundregel (viktigast av allt)

> **Ingen fil, funktion, datastruktur eller nyckel får ändras, döpas om eller slås ihop utan uttryckligt beslut.**
>
> Om något känns “onödigt”, “duplicerat” eller “kan förenklas” → **STOPP**.

Atlas är ett **kontraktsstyrt system**, inte ett refactor‑vänligt hobbyprojekt.

---

## 1. Systemöversikt (helhetskarta)

```
Electron (main.js)
 ├─ preload.js  ──► renderer.js (UI)
 │                    │
 │                    ▼
 │               IPC-kontrakt
 │                    │
 ▼                    ▼
Node server (server.js) ──► legacy_engine.js
                                 │
                                 ▼
                          intentEngine.js
                          contextLock.js
                          priceResolver.js
                                 │
                                 ▼
                              SQLite (db.js)
```

Allt ovan är **samtidigt aktivt**. Inget är “legacy som inte används”.

---

## 2. Fil-för-fil: Ansvar & kontrakt

### 2.1 `main.js` (EXTREMT KRITISK)

**Roll**:
- Startar Electron
- Startar Node‑servern
- Äger IPC‑kontraktet
- Äger CSP‑policy
- Äger team‑auth mot server

**RÖR ALDRIG:**
- `spawn(process.execPath, [server.js])`
- Port `3001`
- CSP‑injektionen (`onHeadersReceived`)
- IPC‑event‑namn

**Renderer förutsätter exakt:**
- IPC‑namn
- Returformat
- Timing (serverReady)

---

### 2.2 `db.js`

**Roll**:
- ENDA källan till SQLite
- Skapar tabeller
- Äger ALLA DB‑accessors

**Heliga tabeller**:
- `templates`
- `settings`
- `context_store`
- `chat_v2_state`
- `local_qa_history`
- `users`

**Viktigt**:
- WAL‑mode är KRITISKT
- `claimTicket` är atomisk – ändra ej logiken

---

### 2.3 `server.js`

**Roll**:
- HTTP API
- Socket.io
- RAG‑orkestrering
- Context‑merge

**Heliga objekt**:
- `contextData`
- `contextData.messages`
- `contextData.locked_context`

**Regel**:
- Servern är stateless
- ALL state måste kunna rekonstrueras från DB + payload

---

### 2.4 `legacy_engine.js`

**Roll**:
- Samordnar intent → context → svar
- Binder ihop alla utils

**OBS**:
- Namnet är missvisande
- Filen är PRODUKTIONSKRITISK

---

### 2.5 `intentEngine.js`

**Roll**:
- Intent‑klassificering
- Slot‑extraktion

**Output‑kontrakt**:
```js
{
  intent,
  confidence,
  slots: { city, area, vehicle, service }
}
```

**Får inte ändras**:
- Slot‑namn
- Normalisering

---

### 2.6 `contextLock.js`

**Roll**:
- Förhindrar kontext‑läckage
- Städar område vid stadbyte

**Helig funktion**:
- `resolveContext`

Denna fil är **safety‑critical**.

---

### 2.7 `priceResolver.js`

**Roll**:
- Prislogik
- Median‑fallback

**Kontrakt**:
- Returnerar alltid `{ found, price?, source, matches }`

---

## 3. Heliga datastrukturer (RÖR EJ)

### 3.1 Context
```js
contextData = {
  messages: [],
  locked_context: {
    city,
    area,
    vehicle,
    service
  }
}
```

- `messages` är CHAT‑HISTORIK
- `locked_context` är AFFÄRSSTATE

Blanda ALDRIG dessa.

---

## 4. Förbjudna LLM‑förslag (exempel)

❌ "Förenkla context till ett objekt"
❌ "Ta bort legacy_engine"
❌ "Flytta state till frontend"
❌ "Byt namn för tydlighet"
❌ "Slå ihop IPC‑handlers"

Alla ovan **bryter Atlas**.

---

## 5. Godkända ändringar (endast dessa)

✅ Lägg till NYA fält (bakåtkompatibelt)
✅ Lägg till nya intent
✅ Lägg till nya DB‑tabeller

ALDRIG:
- Ändra befintliga fält
- Ändra kontrakt

---

## 6. Prompt att ge till framtida LLM

> Du hjälper till med Atlas.
> Följ dokumentet "ATLAS – Systemkontrakt & LLM‑skyddsdokument" strikt.
> Ändra aldrig existerande strukturer, kontrakt eller namn.
> Vid osäkerhet: stoppa och fråga.

---

## 7. Status

- Dokumentversion: **v1.0**
- System: **Låst & kartlagt**
- Redo för vidare utveckling

🔒 **Atlas är nu skyddat mot oavsiktlig förstörelse.**

