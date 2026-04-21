# MTG Store WhatsApp Assistant

An MTG store support bot built on `whatsapp-web.js`, Express, and Gemini via the official `@google/genai` SDK.

## What it does

- Answers store support questions in English only
- Uses Gemini for response generation and tool orchestration
- Routes operational requests to store tools
- Uses local file-backed RAG for policy and buylist questions
- Leaves MTG rules grounding behind a dedicated adapter boundary
- Keeps WhatsApp session handling and Express health/admin endpoints

## Current scope

Supported:

- Product search and product detail lookups
- Event listings and event detail lookups
- Order status checks
- Voucher checks
- Support ticket logging
- Policy and buylist answers from local knowledge files

Not supported in chat:

- Order placement
- Inventory reservation
- Event registration
- Full MTG rules adjudication
- Non-English conversations

## Environment variables

```bash
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
STORE_API_BASE_URL=
STORE_API_KEY=
RAG_SOURCE_PATH=./rag
RULES_GROUNDING_ENABLED=false
API_PORT=3000
```

## Run

```bash
npm install
npm start
```

For development:

```bash
npm run dev
```

## Architecture

Core runtime files:

- `index.js`: bootstraps config, Gemini, the agent layer, WhatsApp, and Express
- `config.js`: store, feature-flag, Gemini, and runtime configuration
- `history.js`: in-memory session history with reset support
- `prompts/system-prompt.js`: English-only MTG store system prompt

Services:

- `src/services/gemini.js`: Gemini model access and function-calling orchestration
- `src/services/agent.js`: intent routing across tools, RAG, rules grounding, and fallbacks
- `src/services/store-tools.js`: store-facing operational tools
- `src/services/rag.js`: local file-backed retrieval
- `src/services/rules-grounding.js`: adapter stub for future official rules grounding
- `src/services/whatsapp.js`: WhatsApp lifecycle and inbound message handling
- `src/services/express.js`: health, status, logs, QR, and admin send endpoints

Knowledge:

- `rag/policies.md`
- `rag/buylist.md`

## Notes

- Store tools are API-backed and require `STORE_API_BASE_URL` plus any needed backend routes.
- `RULES_GROUNDING_ENABLED=true` only toggles the adapter path today. The grounding implementation itself is still pending.
