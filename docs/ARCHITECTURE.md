# Architecture

## Runtime layers

1. `whatsapp.js`
   Receives inbound WhatsApp messages, handles dedupe, group mention checks, QR/auth lifecycle, and forwards user text to the agent.

2. `agent.js`
   Routes each message into one of four paths:
   - store tools
   - RAG retrieval
   - rules grounding adapter
   - English-only or out-of-scope fallback

3. `gemini.js`
   Isolates all Gemini SDK usage, including plain text generation and function-calling loops through `@google/genai`.

4. Store integration modules
   - `store-tools.js`
   - `rag.js`
   - `rules-grounding.js`

## Store tools

The current tool surface is:

- `searchProducts`
- `getProductDetails`
- `checkOrderStatus`
- `getEvents`
- `getEventDetails`
- `checkVoucher`
- `logSupportRequest`

These tools are exposed to Gemini as function declarations and executed locally by the orchestration layer.

Tool calls are API-backed. If `STORE_API_BASE_URL` is missing or the backend errors, the tool returns an explicit failure back to the agent.

## Retrieval

`rag.js` loads local files from `RAG_SOURCE_PATH` and performs lightweight keyword-overlap ranking over paragraph chunks.

Supported categories:

- `policies`
- `buylist`

This keeps the retrieval boundary simple so the implementation can be swapped later for a database or vector backend without changing the agent entrypoint.

## Rules grounding

`rules-grounding.js` is intentionally a stub. The adapter exists so a future MTG rules grounding service can be added without changing WhatsApp or Gemini wiring.

## Session memory

`history.js` stores short in-memory chat history per WhatsApp chat ID, supports reset keywords, and trims older turns after the configured message limit.

## HTTP surface

`express.js` exposes:

- `/api/health`
- `/api/status`
- `/api/logs`
- `/api/logs/stream`
- `/api/admin/qr`
- `/api/admin/send-message`
