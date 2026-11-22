# GoldenHour

**Help that reaches you, even when the internet doesn't.**

GoldenHour is an AI-assisted emergency medical response network, built for **EvoHacks II (theme: Projects for Social Good)**. A bystander sends an SOS in three taps, by voice, or by SMS. Agents triage the case, pick the right ambulance and the right hospital (not just the nearest), warn the emergency room before the patient arrives, and coach the bystander through first aid out loud, in English or Urdu. It keeps working when the internet doesn't.

> **Prototype.** Hospitals, ambulances and patients are **simulated** (around Sukkur, Pakistan; hospital names are fictional). GoldenHour supports, and never replaces, national emergency numbers (1122 / 115 in Pakistan, 112, 911). A "Call 1122" button is on every citizen screen.

- **Live demo:** _add the deployed URL here_
- **Demo video (3 min):** _add the video link here_

---

## Why

When someone is badly hurt, the first hour often decides whether they live. About **1.16 million people die in road crashes each year**, and more than **90% of those deaths are in low- and middle-income countries** (WHO). The hour is lost to four avoidable gaps:

| Gap | What GoldenHour does |
|---|---|
| Help is called late, or not at all (no data, unknown number, can't describe the place) | Three-tap SOS with automatic GPS, voice input, **coded SMS when there is no data**, and an **offline queue** when there is no signal |
| The wrong ambulance is sent | Dispatch Agent ranks every free unit by road ETA and capability (ALS/BLS) |
| The patient goes to the wrong hospital (no bed, unit diverting) | Hospital Match Agent picks by required unit + live capacity + ETA, then **pre-alerts the ER** (ATMIST) |
| Nobody at the scene knows what to do | Spoken, step-by-step first aid (CPR beat included), in English and Urdu, **offline** |

## The Connectivity Ladder

| Level | Connection | What happens |
|---|---|---|
| 1 | Internet | App SOS (tap or voice), live tracking, live ETA, spoken first aid |
| 2 | Phone signal only | The app builds a coded SMS (`GH SOS\|T:ACC\|P:2\|S:UNR\|L:27.70,68.85\|ID:7F3K`) and opens the SMS app; any basic phone can also text in plain words ("accident near the toll plaza, 2 injured") |
| 3 | No signal | The SOS is saved on the phone and sends itself when any connection returns; first-aid guides are read aloud from the phone |

## Who uses it

| Screen | For | Highlights |
|---|---|---|
| `/sos` | Anyone (no account) | 3 taps, red-flag questions, English / **اردو** (right-to-left), live ETA, offline + SMS fallback, "help no longer needed?" |
| `/dispatch` | Command center | Live map and queue, priority with reasons (rules + AI), one-click dispatch, escalation alerts, **mass-casualty board**, close/cancel with a logged reason |
| `/crew` | Ambulance crew (phone) | Big one-tap status buttons, patient tags and vitals, hospital choice + pre-alert, re-alert banners |
| `/er` | Hospital emergency room | Live capacity board, ATMIST pre-alerts with Accept / Decline |
| `/admin` | Health authority | Response-time KPIs (median, p90), blind-spot zones, AI oversight, full audit log |

Staff screens need a staff sign-in (demo: pick a role on the home page; optionally protected by a PIN).

## The eight agents

"AI where language and judgement help; plain, testable rules where a mistake could cost a life." Every agent explains itself to a human.

| Agent | What it does | AI or rules |
|---|---|---|
| **Intake & Triage** | Turns taps, voice, SMS (any language) into a structured case and a priority with reasons | Red-flag **rules decide instantly**; AI reads free text and may **raise** the priority, never lower it |
| **Verification** | Merges duplicate reports (same area, same time); never deletes or rejects an SOS | Rules |
| **Dispatch** | Ranks units by road ETA and capability; P1 prefers ALS (sends both when ALS is far); suggests several units for many patients; suggests pre-emption from P3/P4 (a human confirms, the caller is told) | Scoring algorithm |
| **Hospital Match** | Filters by required unit, never a "Diverting" one; ranks by time to real treatment; explains the choice and what it skipped | Scoring algorithm |
| **Pre-Alert** | Sends the ER an ATMIST handover built only from recorded data; falls back to the next hospital after a decline or 2 minutes of silence | Rules + optional AI one-line headline from the ATMIST fields only |
| **First-Aid Coach** | Picks the right guide and reads it aloud step by step, offline | Rules (content is fixed, never AI-written) |
| **Escalation timers** | Not triaged in 60 s, waiting past target, P1 with no free unit, crew not accepting in 60 s, unit not moving 2 min after "en route" | Rules |
| **MCI Coordinator** | Suggests mass-casualty mode (5+ patients, or 3+ reports within 1 km in 15 min); once a shift lead activates it, spreads START-tagged patients across hospitals by free beds (RED first, Limited units only for RED, overflow spread so no single ER is overwhelmed) | Rules + optimisation |

The **Blind Spot** view (admin) flags zones where ambulances are consistently slow and hospitals whose capacity data is stale.

## Responsible use of AI and data

- **AI suggests, humans decide.** Red-flag rules set P1 instantly and lock it; the AI may only raise a priority; any downgrade needs a written reason from a dispatcher and is audited.
- **Never a single point of failure.** With no AI key, or if the AI is slow, wrong or down, every SOS still goes through on rules immediately. The UI says honestly when the AI is off.
- **Human oversight is measured.** The admin console shows how often the AI's suggestion matched the final priority, how often it raised one, and how often a dispatcher changed it.
- **Data minimisation.** Phone numbers, CNIC (ID-card) numbers and e-mails are **removed before any text reaches the AI**. The pre-alert headline is generated from the ATMIST fields only.
- **Encrypted at rest.** What callers typed or said, and SMS bodies, are stored with AES-256-GCM.
- **Deleted after 90 days.** Raw text and the SMS log (with numbers) are purged; anonymous statistics stay for the response-time analytics.
- **Role-based access.** The citizen app and staff screens share one website, so the API is the wall: the public sees only its own SOS; a crew sees only its own unit; an ER only its own hospital; staff tokens are signed and cannot be edited; the audit "who" comes from the token.
- **No diagnosis.** GoldenHour routes, alerts and coaches first aid. First-aid steps come from a fixed library based on public first-aid guidance, marked **pending clinical review**.

## Accessibility and languages

- Citizen flow in **English and Urdu**, right-to-left layout, the page language set for screen readers; first aid and speech input follow the chosen language.
- **WCAG 2.1 AA audited with axe-core: 0 violations** across 12 screen states (home, SOS in both languages, first aid in both languages, command center, crew, ER, admin).
- Screen-reader announcements for SOS progress, ETA and alerts; selected answers announced; named map markers; visible keyboard focus; respects "reduce motion".
- Honest voice: if a phone has no Urdu voice, the coach says so and offers English instead of playing silence.
- Big touch targets for crews, three-tap SOS, plain words.

## Run it

**Requirements:** Node.js 22+ and pnpm 11 (`npm i -g pnpm`).

```bash
pnpm install
cp .env.example .env    # optional: everything has a working default
pnpm dev                # API on :4000, web app on http://localhost:5173
```

No database or API key is needed locally: the API uses an embedded Postgres (PGlite) and runs rules-only without an AI key. On first start it loads the simulated city and 7 days of clearly-labelled simulated history for the dashboard. **Reset demo** (command center, top right) restores that state.

**A 5-minute tour**

1. Home → **Send SOS** → Accident → **5+** → "Do they respond?" **No** → **SEND SOS**.
2. In another tab: Home → **Command Center**. Open the new P1 (marked **MCI?**), activate mass-casualty mode, send the suggested units, tag patients, and press **Assign & pre-alert ERs**.
3. Watch ambulances drive on the map; open **Hospital ER** in another tab to accept a pre-alert; open **Ambulance Crew** to tap statuses.
4. Turn the network off (DevTools → Offline) and send an SOS: it is saved, offers SMS, and sends itself when you go back online.
5. Home → **Admin** for KPIs, blind spots, AI oversight and the audit log.

**Turn on the AI (free):** get a Gemini key at <https://aistudio.google.com/apikey>, put it in `.env` as `LLM_API_KEY=...`, restart. Any OpenAI-compatible API works (Groq example in `.env.example`).

### Configuration

All settings are in [`.env.example`](.env.example). On a public deployment, set **`AUTH_SECRET`**, **`STAFF_PIN`** and **`DATA_KEY`**. Other useful ones: `DATABASE_URL` (Neon/Postgres), `LLM_*`, `TWILIO_*` (real SMS), `CORS_ORIGIN`, `VITE_API_URL`.

## Tests

```bash
pnpm typecheck
pnpm test          # 119 API tests: in-memory database, no network, a fake AI server
```

They cover the full incident lifecycle; triage rules (English, Roman Urdu, Urdu); duplicate merging and idempotent retries; dispatch and pre-emption; hospital matching, pre-alert, decline and fallback; SMS (coded, plain text, "reply 1", crew codes); escalation timers; mass-casualty distribution; the KPI analytics; **AI guardrails** (raise-only, never overrides a dispatcher, survives broken/slow/failed AI, no personal data sent); encryption and retention; and **access control** (citizen / crew / ER / forged tokens / live channels). Regression tests pin every bug fixed during review.

**Browser tests and accessibility audit** (Playwright + axe-core, using an installed Edge or Chrome):

```bash
# bash / Git Bash syntax
pnpm build
# terminal 1: a throwaway API (the tests reset its data)
cd apps/api && PORT=4100 PGLITE_DIR=../../.e2e-db pnpm start
# terminal 2: the built app
cd apps/web && VITE_DEV_API=http://localhost:4100 pnpm exec vite preview --port 4173
# terminal 3
cd e2e && npm install && node run.mjs && node a11y.mjs    # BROWSER=chrome to use Chrome
```

`run.mjs` drives 18 scenarios across a citizen phone, the command center, an ER and a crew phone (mass casualty, escalations, offline delivery, caller cancel, access control, Urdu voice). `a11y.mjs` audits 12 screen states for WCAG 2.1 AA.

## Technology

| Layer | Choice | Why |
|---|---|---|
| Web app | React 19, Vite, TypeScript, Tailwind CSS 4, React Router | One codebase, role-based screens |
| Offline | PWA (vite-plugin-pwa / Workbox), IndexedDB (Dexie), Background Sync | App and first-aid guides cached; SOS queued on the phone |
| Maps and routing | Leaflet + OpenStreetMap; OSRM (public demo server) with a straight-line fallback | Free, no key; real road ETAs |
| Voice | Web Speech API (speech-to-text online; text-to-speech on the device) | Voice SOS; spoken first aid offline |
| API | Node.js, Express 5, Zod, Socket.IO | Typed, real-time rooms per role |
| Data | PostgreSQL via Drizzle ORM (Neon in the cloud, PGlite locally) | Relational incidents, units, hospitals |
| AI | Any OpenAI-compatible LLM (Gemini 2.5 Flash by default) | Multilingual extraction, triage suggestions, ATMIST headline |
| SMS | Twilio webhook, or an Android SMS-gateway phone; a clearly-labelled simulator otherwise | Level 2 for phones without data |

```
apps/api        Express + Socket.IO + agents (src/agents), SMS channels, simulator, tests
apps/web        React PWA: /sos /first-aid /dispatch /crew /er /admin
packages/shared Types, triage rules, red-flag phrases (EN / Roman Urdu / Urdu), SMS codes, first-aid guides
e2e             Browser tests and accessibility audit
```

## Built during the event, and credits

- **All application code in this repository was written during EvoHacks II** (from 21 Nov 2026). No pre-existing project code or boilerplate was reused. Our own design document (the GoldenHour concept & technical blueprint) defined the plan.
- **AI assistance:** developed with Claude Code (Anthropic) as a coding assistant.
- **Open-source libraries:** React, Vite, Tailwind CSS, React Router, Leaflet, react-leaflet, lucide icons, Dexie, Socket.IO, Express, Zod, Drizzle ORM, PGlite, node-postgres, vite-plugin-pwa / Workbox, Plus Jakarta Sans (via Fontsource), Playwright, axe-core. Thank you to their authors.
- **Data and services:** map tiles © OpenStreetMap contributors; routing by the OSRM demo server; landmark search by Nominatim (OpenStreetMap). Statistics from the World Health Organization road-traffic-injuries fact sheet.
- **Methods:** START mass-casualty triage; ATMIST pre-hospital handover; the trauma "golden hour".

## Honest limits

- Hospitals, ambulances and patients are simulated; ambulances drive 8× faster than real time on stage.
- Without Twilio keys, SMS is **simulated** in the command center (same code path as a real gateway).
- Without an AI key, the AI layer is off (rules and dispatchers run everything).
- Spoken Urdu needs an Urdu voice on the device (Android phones can install one in Google's speech engine; desktop Chrome and a default Windows install have none). Without one, the coach shows the steps and offers English.
- Voice SOS needs internet and a browser with speech recognition; Background Sync is Chromium-only (the app also retries on reconnect).
- First-aid guides, red-flag phrases and the Urdu wording must be reviewed by qualified clinicians and native speakers before any real use. **Not a medical device.**

## Roadmap

Bluetooth relay between phones until one finds signal · USSD and a call-in voice line for basic phones · integration with Rescue 1122 / 112 / 911 dispatch systems · hospital information system (HIS) integration · Blind Spot standby suggestions from real historical data.
