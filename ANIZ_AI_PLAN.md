# ANIZ AI — Build Plan

Living plan for ANIZ AI. Update it as milestones land; keep claims verifiable.

## Repository inspection (first pass)

`ANIZXD/Aniz-ai` contained **no application code** — a single commit
("Add files via upload") holding one file, `ANIZ_AI_OpenCode_Prompt_Pack.zip`.
Extracted, that archive is two text files: `MASTER_PROMPT.md` (the product brief)
and `README.txt` (usage notes). The zip is preserved untouched at the repo root.

**What already works:** nothing — there was no project to run.

**What was missing:** everything. No server, no provider layer, no UI, no tests,
no run instructions.

**Smallest sensible next milestone:** one reliable end-to-end path — send a
message, get a streamed reply from a configured model, fail gracefully when the
provider is unavailable, keep secrets out of source control, and have a
reproducible run/test command. That was milestone 1.

## Architecture decisions

- **Runtime: Node 24 native TypeScript.** Node 24 executes `.ts` directly via
  type stripping, so there is no build step, no bundler, and no transpile
  dependency. `typescript` stays a dev-only dependency for `tsc --noEmit`.
  Consequence: only *erasable* TypeScript syntax is allowed
  (`erasableSyntaxOnly: true`) and imports carry explicit `.ts` extensions.
- **Server: Express 5.** Small, familiar, adequate for a JSON + SSE surface.
  Express 5 forwards rejected promises from async handlers to the error handler,
  so route handlers can `throw` typed errors.
- **UI: static HTML/CSS/vanilla ES modules, no build step.** The target machine
  has 8 GB of RAM; a bundler/dev-server/toolchain adds nothing. Streaming is done
  with `fetch` + `ReadableStream`.
- **Transport: Server-Sent Events over POST.** The browser needs a POST body for
  the conversation and incremental output; `EventSource` cannot POST, so the
  client parses the SSE stream from a `fetch` response by hand.
- **Provider layer behind one interface.** `ProviderAdapter` separates model
  access from HTTP handling. Ollama is the default (free, local, no account).
  An OpenAI-compatible adapter covers any cloud or local endpoint through
  configuration. A `mock` adapter is a documented test double.
- **Persistence: one JSON file, atomic writes, serialized read-modify-write.**
  `data/sessions.json` is written to a temp file and renamed, so a crash cannot
  leave a half-written file; a corrupt file is moved aside rather than
  overwritten. Concurrent appends queue, so nothing is lost. Right for one user;
  a database is only worth adding if it outgrows this.
- **Tools over a text protocol, not native tool-calling.** A 0.6 B local model
  cannot be relied on to emit native tool calls. The model is told to reply with
  *only* `{"tool": "...", "args": {...}}`; the loop withholds output that could
  still become a tool call, parses it, checks permission, runs it, and feeds back
  a `TOOL RESULT` message.
- **Verification at the tool boundary.** Tools that change state re-read the
  filesystem afterwards and report `verified`. The model is told never to claim
  success unless a tool result says `ok=true`.
- **Permission model: reads free, writes need per-request consent, deletes never
  automatic.** `allowWrite` is a UI toggle (default off). `allowDestructive` is
  supported by the API but not exposed in the UI at all.
- **Secrets:** read from environment only, never logged, never serialized to the
  client. `.env` is git-ignored and `.env.example` holds placeholders only.
- **Local-first:** the server binds `127.0.0.1` by default and is unauthenticated,
  so it is not exposed to the network.
- **No fake functionality:** every button and endpoint does real work. The mock
  provider is labelled as a test double, and browser access reports itself as
  unavailable rather than pretending.

## Milestones

### M1 — Reliable end-to-end chat

- [x] Provider adapter interface with availability checks, model listing, streaming
- [x] Ollama adapter (default), OpenAI-compatible adapter (optional), mock adapter (tests)
- [x] `POST /api/chat` — validates input, streams SSE
- [x] `GET /api/health` — reports which providers are configured and reachable
- [x] Chat UI: empty, loading, streaming, error + retry, stop, provider status
- [x] Friendly errors for: provider down, bad input, upstream failure, timeout, empty reply
- [x] `.env.example`, `.gitignore`, README with reproducible run/test instructions

Two real bugs were found and fixed while verifying M1: `request.on("close")` fires
when the request body is read (not on disconnect) and was aborting the stream
right after `meta` — the route now watches `response.on("close")` together with
`writableEnded`; and undici wraps `ECONNREFUSED` in an `AggregateError` with an
empty message, so hint matching walks `cause` **and** `.errors`. Both are under test.

### M2 — Conversation persistence

- [x] `data/sessions.json` via an atomic, write-serialized JSON store
- [x] Create, append, list, rename, delete; corrupt files moved aside for recovery
- [x] `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id`
- [x] Chat accepts `sessionId`; omitting it starts a conversation and returns its id in `meta`
- [x] Sessions auto-titled from the first user message; context bounded to the last 40 messages
- [x] Sidebar UI: list, switch, rename, delete; remembered across reloads
- [x] `retry` re-runs the last message without storing it twice

### M3 — Single-agent tool loop

- [x] Tool interface with name, description, typed parameters, risk level, availability
- [x] Argument validation that tolerates strings-for-booleans from small models
- [x] Registry with a prompt catalogue and availability reporting
- [x] Five workspace-scoped file tools: `list_files`, `read_file`, `search_files`, `write_file`, `delete_file`
- [x] Single path resolver that refuses absolute paths and `..` escapes
- [x] Streaming loop: detect tool call → check permission → run → feed result back → repeat
- [x] Turn cap (`MAX_AGENT_STEPS`), tool-call withholding so JSON never leaks to the user
- [x] `tool_call` / `tool_result` SSE events and tool cards in the UI
- [x] A repeated identical tool call is refused instead of re-run

### M4 — Verifier

- [x] `write_file` re-reads the file and confirms it matches byte for byte
- [x] `delete_file` confirms the path is gone
- [x] `verified` surfaced on every tool result, in the UI badge, and to the model
- [x] `summarizeToolOutcomes` separates *ok, verified* / *ok, unverified* / *failed*
- [x] System prompt forbids claiming success without a confirming tool result
- [x] Optional verifier pass after an agent run: `Outcome / Evidence / Unverified / Risk / Next step`

### M5 — Specialist agents

- [x] Roles as system-prompt specialisations: `assistant`, `coder`, `researcher`, `reviewer`
- [x] `plan` mode: numbered plan, no tools, one step
- [x] `agent` mode: the M3 loop
- [x] `review` flag runs the verifier role over the transcript and tool evidence
- [x] Deliberately **no** multi-agent orchestration: one loop, one selected role, one
      verifier pass. Nothing here is theatre.

### M6 — Browser automation (works via a system browser)

- [x] `browser_navigate` tool: returns a page title and visible text
- [x] Read-only by design — it never clicks, types or submits, so it cannot change
      state on a site
- [x] Sees JavaScript-rendered content, which a plain HTTP fetch cannot
- [x] Honest availability: without Playwright *and* a browser it reports itself
      unavailable and `/api/health` says so, instead of failing at call time
- [x] Prefers Playwright's bundled Chromium when present, otherwise drives a system
      Microsoft Edge / Google Chrome — so **no large download is needed** on a
      normal Windows machine (`src/tools/browserLocate.ts`)
- [x] Verified live: navigated to `https://example.com` through the installed Edge
      with no Chromium download

### Voice — talking like a person, not a help desk

- [x] System prompt: sound like a sharp, friendly person; lead with the answer;
      finish the whole job in one reply; never close with an offer of help
- [x] Enforced in code (`src/agent/style.ts`): canned closers are stripped from the
      output while still streaming sentence by sentence, because a small model will
      not reliably obey the instruction alone
- [x] Only short filler (≤ 70 characters) is ever removed, so real content that
      merely mentions helping is kept

### Deferred

Desktop control and video-editing automation require real, documented
integrations. They stay off the roadmap until such an integration exists and is
verified — the assistant will not claim these abilities before then.

## Verification log (2026-10-13)

Commands: `npm run typecheck`, `npm test`, `npm start` + live HTTP calls against
Ollama `qwen3:0.6b`.

- `npm run typecheck` — clean (src and test).
- `npm test` — **145 tests, 145 pass, 0 fail**, no network required. Suites:
  adapters, routes, sessions, tools, protocol, agent, style, verifier helpers,
  browser location, config, chat history and system prompts.
- `GET /api/health` — `ok: true`, provider `ollama`, model `qwen3:0.6b`; all six
  tools ready, including `browser_navigate` reporting
  `Playwright will drive the installed Microsoft Edge.`; workspace path reported.
- **Browser, live:** in agent mode the model called `browser_navigate` on
  `https://example.com` → `tool_result` ok with `Title: Example Domain` and the
  page text, rendered by the real installed Edge with no Chromium download. The
  returned text included the localized paragraphs that `example.com/s.js` injects
  at runtime — content a plain HTTP fetch never sees.
- **Voice, live:** "What is 2 plus 2?" → `2 + 2 = 4.`; "hi" → `Hi!`. No
  "How can I assist you?" closer in either, where the small model previously
  appended one every time.
- **Tool loop, live:** "Read notes.txt with the read_file tool" → `tool_call`
  (`read_file`, allowed) → `tool_result` (ok, bytes) → grounded answer naming the
  correct project codename. `steps: 2`.
- **Write refused, live:** with `allowWrite` unset, `write_file` came back
  `allowed: false` with "File edits are not enabled…", and `refused.txt` was not created.
- **Write allowed, live:** `write_file` → `ok: true, verified: true`
  ("read back 11 bytes, contents match"); the file exists on disk.
- **Delete refused, live:** `delete_file` came back `allowed: false`
  ("Deleting is never automatic…") and `kept.txt` survived.
- **Delete allowed, live:** with `allowDestructive: true` → `ok: true,
  verified: true` ("the path is gone"); `dup.txt` removed from disk.
- **Persistence, live:** six conversations listed newest-first with sensible
  auto-titles and message counts; rename worked; session detail showed
  `user` → `tool (delete_file)` → `assistant`; delete returned 204 and the
  session then 404'd.
- **Retry, live:** re-ran the last message and produced a reply; the unit test
  asserts the user message is not duplicated.
- **Verifier pass, live:** with `review: true` the stream carried `review` events
  forming a structured verdict, the `done` usage stayed the agent turn's, and the
  verdict was persisted as a `[Verifier]` message.
- **Plan mode, live:** one step, no tool calls.
- **UI assets:** `GET /` 200, `styles.css` 200, `app.js` 200.
- **Storage:** `data/sessions.json` was 12.1 KB after nine conversations.

### Bugs found and fixed during verification

1. An empty streaming delta counted as produced prose, so an empty reply reported
   `finishReason: "stop"` instead of `"empty"`.
2. Models routinely send `"path": ""` (or omit it) to mean "the workspace root";
   the path resolver rejected it. The resolver now maps an empty path to the root.
3. The local model called `write_file` twice with identical arguments. An
   identical repeated call is now refused with a pointer to the earlier result.
4. The verifier pass overwrote the agent turn's `usage` in the `done` event.
5. `read_file` returned a UTF-8 byte-order mark as content; it is now stripped.

### Not verified

- The UI has not been clicked through by hand in a browser; the API and the
  static assets were driven directly.
- The `openai` provider has not been tested against a live endpoint (no key).

### Note on concurrent work

While this was being built, a second session committed an independent line of
work to the same repository (commit `49dcefd`): an Ollama conversation-settings
layer (stop list, thinking toggle, history mode, sampling), `browserLocate.ts`
with the system-browser fallback, and config/history/prompt/browser-location
tests. That work and this one are complementary — the stop list trims the canned
closers at generation time, and `style.ts` removes any that still appear — and the
combined suite passes.

## Known limitations

- Conversations live in one JSON file; fine for one user, not for many.
- One provider is active at a time (choose with `PROVIDER`).
- The verifier is a second model pass, not an independent checker — a weak model
  can be wrong in both passes.
- The tool protocol is text-based, so a small model can emit malformed JSON; that
  is reported as a failed call rather than crashing the run.
- No authentication or rate limiting — localhost-only by design.
- No token accounting beyond what a provider reports.
- Only one local model is installed (`qwen3:0.6b`), so replies are small and slow
  relative to a hosted model. It leaks a literal `/think` token into some replies
  (and once into file content) — model behaviour, not a transport bug.

## Verification commands

```bash
npm run typecheck   # TypeScript, no emit
npm test            # node:test, temp data dir, no network
npm start           # http://127.0.0.1:3210
node --version      # must be >= 22.18 for native TypeScript
```
