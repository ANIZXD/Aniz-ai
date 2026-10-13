# ANIZ AI

A local-first AI assistant workspace with a replaceable model/provider layer.

Send a message, get a streamed reply. In **Agent** mode the assistant can also use
tools: it reads, searches and (only when you allow it) writes files inside its
workspace. By default the model runs on this machine through
[Ollama](https://ollama.com), so nothing leaves your computer and there is no
account or cost. Point it at any OpenAI-compatible endpoint instead by changing
one line in `.env`.

Milestones 1–6 of [`ANIZ_AI_PLAN.md`](./ANIZ_AI_PLAN.md) are implemented:
streaming chat, persisted conversations, a supervised tool loop, outcome
verification, specialist roles plus a verifier pass, and opt-in browser access.

## Requirements

- **Node.js 22.18 or newer** (24 recommended). The server runs `.ts` files
  directly using Node's built-in type stripping, so there is **no build step**.
- **Ollama** with at least one model, if you want to use the local provider:
  `ollama pull qwen3:0.6b`

## Quick start

```bash
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm start
```

Open <http://127.0.0.1:3210>. The status pill in the header turns green when the
model is reachable.

For development with auto-restart: `npm run dev`

## Using it

- **Conversations** live in the left sidebar. They are saved to
  `data/sessions.json` and survive closing the tab or restarting the server.
  Rename or delete them from the hover actions.
- **Mode**
  - `Chat` — answer only, no tools.
  - `Agent` — can call tools, in a loop, up to `MAX_AGENT_STEPS` steps.
  - `Plan` — produces a numbered plan and uses no tools.
- **Role** — `Assistant`, `Coder`, `Researcher` or `Reviewer`. A role is a
  system-prompt specialisation, not a separate process.
- **Verifier** — after an agent run, one extra pass reviews the transcript and
  the tool results and reports whether the task was actually done.
- **Allow file edits** — off by default. While it is off, `write_file` is
  refused and the model is told so. Deleting is *never* automatic and is not
  exposed in the UI at all.
- **Stop** cancels an in-flight reply. **Retry** re-runs the last message without
  storing it twice.

### Tools

The workspace is `WORKSPACE_DIR` (default `./data/workspace`). Tools cannot read
or write outside it; absolute paths and `..` escapes are refused.

| Tool | Risk | Notes |
| --- | --- | --- |
| `list_files` | read | `path` (default root), `recursive` |
| `read_file` | read | `path`, `maxBytes`; strips a BOM; refuses binary files |
| `search_files` | read | `query`, `path`; returns `file:line: text` |
| `write_file` | write | requires **Allow file edits**; re-reads the file to verify |
| `delete_file` | destructive | requires explicit `allowDestructive`; never from the UI |
| `browser_navigate` | read | **opt-in**, see below |

### How the agent loop works

Small local models are unreliable at native tool-calling, so ANIZ AI uses a strict
text protocol. The system prompt tells the model to reply with **only** a JSON
object to call a tool:

```json
{"tool": "read_file", "args": {"path": "notes.txt"}}
```

The loop streams the model's output, holds back a reply that could still turn out
to be a tool call, parses it, checks permissions, runs the tool, feeds back a
`TOOL RESULT (...)` message, and repeats until the model replies with prose or the
step limit is hit. A repeated identical tool call is refused rather than re-run.

### Verification (milestone 4)

`write_file` and `delete_file` re-check the filesystem after acting and report
`verified: true/false`; the tool card in the UI shows a **verified** badge, and the
verifier pass receives an evidence summary that separates *ok, verified* from
*ok, unverified*. The assistant is instructed never to claim a change succeeded
unless a tool result says `ok=true`.

## Configuration

All configuration is environment-based. Copy `.env.example` to `.env` and edit
it; `.env` is git-ignored and must never hold committed secrets.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3210` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address — loopback only by default |
| `PROVIDER` | `ollama` | `ollama`, `openai` or `mock` |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `qwen3:0.6b` | Model to chat with |
| `LLM_BASE_URL` | — | OpenAI-compatible base URL, e.g. `https://host/v1` |
| `LLM_API_KEY` | — | Key for that endpoint (stays in `.env`) |
| `LLM_MODEL` | — | Model name to send |
| `REQUEST_TIMEOUT_MS` | `300000` | Hard cap on one reply (cold model loads are slow) |
| `DATA_DIR` | `./data` | Where conversations are stored |
| `WORKSPACE_DIR` | `./data/workspace` | The only area tools may touch |
| `MAX_AGENT_STEPS` | `6` | Tool-loop step cap (1–20) |

To use a hosted endpoint, set `PROVIDER=openai` plus the three `LLM_*` values.
The app never prints or sends your key to the browser.

`PROVIDER=mock` runs a deterministic test double. It is **not** a language model;
it only echoes your message so the UI can be exercised without a model.

## HTTP API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/chat` | POST | Chat. Streams SSE. See below. |
| `/api/sessions` | GET | List conversations, newest first |
| `/api/sessions` | POST | Create a conversation: `{ "title": "..." }` (optional) |
| `/api/sessions/:id` | GET | One conversation with its messages |
| `/api/sessions/:id` | PATCH | Rename: `{ "title": "..." }` |
| `/api/sessions/:id` | DELETE | Delete |
| `/api/health` | GET | Providers, tool availability and the workspace path |

### `POST /api/chat`

```jsonc
{
  "message": "Summarise notes.txt",   // or "messages": [...] to run stateless
  "sessionId": "…",                    // omit to start a new conversation
  "mode": "chat" | "agent" | "plan",   // default "chat"
  "role": "assistant" | "coder" | "researcher" | "reviewer",
  "review": false,                     // run the verifier pass after an agent run
  "allowWrite": false,                 // must be true for write_file to run
  "allowDestructive": false,           // must be true for delete_file to run
  "retry": false,                      // re-run the last message; needs sessionId
  "model": "…"                         // optional override
}
```

The response is `text/event-stream` with these events:

- `meta` — `{ provider, model, sessionId, mode, role, review, allowWrite, allowDestructive }`
- `delta` — `{ text }`, repeated as the reply streams
- `tool_call` — `{ id, name, risk, args, allowed, reason }`
- `tool_result` — `{ id, name, ok, verified, summary }`
- `review` — `{ text }` from the verifier pass
- `done` — `{ sessionId, finishReason, steps, usage }`
- `error` — `{ code, message, retryable }`, in place of `done`

Errors before the stream starts are returned as JSON with a `400`-series status.

## Browser access (milestone 6, opt-in)

`browser_navigate` opens a page and returns its title and visible text. It is
**read-only**: it never clicks, types or submits, so it cannot change state on a
site. It needs Playwright, which is a large download, so it is **not installed by
default** and the app reports it as unavailable rather than pretending:

```bash
npm i playwright
npx playwright install chromium
```

`GET /api/health` then lists `browser_navigate` as available.

## Tests and checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, no network required
```

The tests never touch your real conversations or workspace: the HTTP tests run
against a temp `DATA_DIR`/`WORKSPACE_DIR`, the provider is a scripted or mock
adapter, and no network is used.

## Layout

```
src/
  server.ts                 bootstrap: config, dirs, listen, shutdown
  app.ts                    express wiring, static files, error handler
  config.ts                 environment parsing (secrets never logged)
  errors.ts                 AppError types with user-facing messages
  logger.ts                 minimal stderr/stdout logger
  lib/fsjson.ts             atomic, serialized JSON file store
  lib/pathSafe.ts           the single place tool paths are resolved
  lib/lines.ts              newline framing for streamed bodies
  lib/sse.ts                Server-Sent Events helpers
  providers/                ProviderAdapter + ollama / openaiCompatible / mock
  sessions/
    types.ts                Session, StoredMessage, title derivation
    store.ts                create / append / rename / delete / list
    routes.ts               /api/sessions
  tools/
    types.ts                Tool, ToolContext, ToolResult, risk levels
    args.ts                 tolerant argument validation
    registry.ts             lookup, prompt catalogue, availability
    files.ts                the five workspace file tools
    verify.ts               read-back verification helpers (M4)
    browser.ts              opt-in Playwright tool (M6)
  agent/
    prompts.ts              system prompts, roles, modes, verifier prompt
    protocol.ts             tool-call parsing
    verifier.ts             tool-outcome evidence summary
    agent.ts                the streaming loop
  routes/
    chat.ts                 POST /api/chat
    health.ts               GET /api/health
web/                        index.html, styles.css, app.js (no build step)
test/                       adapters, routes, sessions, tools, protocol, agent
ANIZ_AI_OpenCode_Prompt_Pack.zip   the original brief (kept as-is)
```

## Security notes

- The server is unauthenticated and binds to `127.0.0.1`, so it is reachable
  only from this machine. Do not expose the port to a network as-is.
- Secrets are read from the environment only, are never logged, and are never
  included in an HTTP response.
- Input is validated at the boundary; provider output, file contents and web
  pages are treated as untrusted data, and the system prompt says so.
- Tool paths are resolved through one function that refuses anything outside the
  workspace. Writes need explicit per-request consent; deletes are never
  automatic and are not reachable from the UI.

## Known limitations

- The conversation is persisted to a single JSON file. That is right for one
  user; a database is only worth adding if it outgrows this.
- One provider is active at a time (choose with `PROVIDER`).
- The verifier runs as a second model pass, not as an independent checker: a weak
  model can be wrong in both passes.
- Tool calls come from a text protocol, so a small model can still emit malformed
  JSON; that is reported as a failed call rather than crashing the run.
- No token accounting beyond what the provider reports.

See [`ANIZ_AI_PLAN.md`](./ANIZ_AI_PLAN.md) for the milestone log.
