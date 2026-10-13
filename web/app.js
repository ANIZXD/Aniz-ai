/**
 * ANIZ AI client — no build step, no dependencies.
 *
 * Talks to POST /api/chat, which streams Server-Sent Events. EventSource cannot
 * send a request body, so the stream is parsed by hand from a fetch response.
 */

const SESSION_KEY = "anizai.sessionId";
const SETTINGS_KEY = "anizai.settings";

const els = {
  app: document.getElementById("app"),
  sidebar: document.getElementById("sidebar"),
  sessions: document.getElementById("sessions"),
  newChat: document.getElementById("newChat"),
  closeSidebar: document.getElementById("closeSidebar"),
  toggleSidebar: document.getElementById("toggleSidebar"),
  workspaceHint: document.getElementById("workspaceHint"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  chat: document.getElementById("chat"),
  empty: document.getElementById("empty"),
  messages: document.getElementById("messages"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("bannerText"),
  retry: document.getElementById("retry"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  mode: document.getElementById("mode"),
  role: document.getElementById("role"),
  review: document.getElementById("review"),
  allowWrite: document.getElementById("allowWrite"),
};

const state = {
  sessionId: localStorage.getItem(SESSION_KEY) || null,
  sessions: [],
  streaming: false,
  controller: null,
  retryAction: null,
  composerEnabled: true,
};

/* --------------------------------------------------------------- utilities */

function setStatus(kind, text) {
  els.statusDot.dataset.state = kind;
  els.statusText.textContent = text;
}

function showBanner(text, action) {
  els.bannerText.textContent = text;
  els.banner.hidden = false;
  state.retryAction = typeof action === "function" ? action : null;
  els.retry.hidden = state.retryAction === null;
}

function hideBanner() {
  els.banner.hidden = true;
  state.retryAction = null;
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function updateEmpty() {
  els.empty.hidden = els.messages.querySelectorAll("li.message").length > 0;
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

function setStreaming(streaming) {
  state.streaming = streaming;
  els.stop.hidden = !streaming;
  els.send.disabled = streaming || !state.composerEnabled;
  els.input.disabled = streaming;
}

function setComposerEnabled(enabled) {
  state.composerEnabled = enabled;
  els.send.disabled = !enabled || state.streaming;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* keep the default message */
    }
    throw new Error(message);
  }

  return response.status === 204 ? null : response.json();
}

/* --------------------------------------------------------------- rendering */

function addMessage(role, text) {
  const item = document.createElement("li");
  item.className = `message ${role}`;

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "You" : "AN";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  item.append(avatar, bubble);
  els.messages.append(item);
  updateEmpty();
  scrollToBottom();

  return { item, bubble };
}

let reviewBlock = null;

function appendReview(text) {
  if (reviewBlock === null || !reviewBlock.isConnected) {
    const item = document.createElement("li");
    item.className = "message";

    const box = document.createElement("div");
    box.className = "review";

    const label = document.createElement("span");
    label.className = "review-label";
    label.textContent = "Verifier";

    const body = document.createElement("span");
    body.textContent = text;

    box.append(label, body);
    item.append(box);
    els.messages.append(item);
    reviewBlock = { item, body };
    updateEmpty();
  } else {
    reviewBlock.body.textContent += text;
  }
  scrollToBottom();
}

function resetReviewBlock() {
  reviewBlock = null;
}

function addToolCard({ id, name, risk, args, allowed, reason }) {
  const item = document.createElement("li");
  item.className = "message";

  const box = document.createElement("div");
  box.className = "tool";

  const head = document.createElement("div");
  head.className = "tool-head";

  const toolName = document.createElement("span");
  toolName.className = "tool-name";
  toolName.textContent = name;

  const riskBadge = document.createElement("span");
  riskBadge.className = "badge";
  riskBadge.textContent = risk ?? "read";

  const statusBadge = document.createElement("span");
  statusBadge.className = "badge";
  statusBadge.textContent = allowed === false ? "refused" : "running";

  head.append(toolName, riskBadge, statusBadge);

  if (args && Object.keys(args).length > 0) {
    const pre = document.createElement("pre");
    pre.className = "tool-args";
    pre.textContent = JSON.stringify(args, null, 2);
    box.append(head, pre);
  } else {
    box.append(head);
  }

  if (reason) {
    const note = document.createElement("div");
    note.className = "tool-result fail";
    note.textContent = reason;
    box.append(note);
  }

  item.append(box);
  els.messages.append(item);
  updateEmpty();
  scrollToBottom();

  return { item, box, statusBadge };
}

function updateToolCard({ id, name, ok, verified, summary }) {
  const item = [...els.messages.querySelectorAll("li.message")].at(-1);
  if (!item) return;

  const box = item.querySelector(".tool");
  if (!box) return;

  const head = box.querySelector(".tool-head");
  const statusBadge = head?.querySelectorAll(".badge")[1];
  if (statusBadge) {
    statusBadge.textContent = ok ? "ok" : "failed";
    statusBadge.classList.add(ok ? "ok" : "fail");
  }

  if (verified) {
    const verifiedBadge = document.createElement("span");
    verifiedBadge.className = "badge verified";
    verifiedBadge.textContent = "verified";
    verifiedBadge.title = "The outcome was confirmed by re-reading it";
    head?.append(verifiedBadge);
  }

  const result = document.createElement("pre");
  result.className = ok ? "tool-result" : "tool-result fail";
  result.textContent = summary;
  box.append(result);
  scrollToBottom();
}

function renderStoredMessage(message) {
  if (message.role === "user") {
    addMessage("user", message.content);
    return;
  }

  if (message.role === "assistant") {
    if (message.content.startsWith("[Verifier]\n")) {
      appendReview(message.content.slice("[Verifier]\n".length));
      return;
    }
    addMessage("assistant", message.content);
    return;
  }

  if (message.role === "tool") {
    addToolCard({ name: message.toolName ?? "tool", risk: "tool", allowed: true });
    updateToolCard({ name: message.toolName ?? "tool", ok: message.ok === true, verified: false, summary: message.content });
  }
}

function clearChat() {
  els.messages.replaceChildren();
  resetReviewBlock();
  updateEmpty();
}

/* --------------------------------------------------------------- streaming */

async function streamChat(body, signal, on) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let message = `The request failed (${response.status}).`;
    try {
      const payload = await response.json();
      if (payload?.error?.message) message = payload.error.message;
    } catch {
      /* keep the default */
    }
    throw new Error(message);
  }

  if (!response.body) throw new Error("The server returned an empty response.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cancelled = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        let event = "message";
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }

        if (dataLines.length > 0) {
          let payload = null;
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            payload = null;
          }

          if (event === "error") {
            cancelled = true;
            throw new Error(payload?.message ?? "The model reported an error.");
          }
          on(event, payload);
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    if (cancelled) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
}

/* --------------------------------------------------------------- turns */

function removeLastAssistantTurn() {
  const items = [...els.messages.querySelectorAll("li.message")];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].classList.contains("user")) break;
    items[index].remove();
  }
  resetReviewBlock();
  updateEmpty();
}

function currentSettings() {
  return {
    mode: els.mode.value,
    role: els.role.value,
    review: els.review.checked,
    allowWrite: els.allowWrite.checked,
  };
}

async function runTurn(body, { ensureAssistantBubble }) {
  hideBanner();
  resetReviewBlock();

  let bubble = null;
  let item = null;

  if (ensureAssistantBubble) {
    const created = addMessage("assistant", "");
    item = created.item;
    bubble = created.bubble;
    bubble.classList.add("streaming");
    bubble.innerHTML = '<span class="placeholder">Thinking…</span>';
  }

  let answer = "";
  let started = false;
  let failed = false;
  const controller = new AbortController();
  state.controller = controller;
  setStreaming(true);

  try {
    await streamChat(body, controller.signal, (event, payload) => {
      switch (event) {
        case "meta":
          if (payload?.sessionId && payload.sessionId !== state.sessionId) {
            state.sessionId = payload.sessionId;
            localStorage.setItem(SESSION_KEY, payload.sessionId);
            void refreshSessions();
          }
          break;

        case "delta":
          if (bubble === null) {
            const created = addMessage("assistant", "");
            item = created.item;
            bubble = created.bubble;
            bubble.classList.add("streaming");
          }
          if (!started) {
            bubble.textContent = "";
            started = true;
          }
          answer += payload.text ?? "";
          bubble.textContent = answer;
          scrollToBottom();
          break;

        case "tool_call":
          addToolCard(payload);
          break;

        case "tool_result":
          updateToolCard(payload);
          break;

        case "review":
          appendReview(payload?.text ?? "");
          break;

        default:
          break;
      }
    });

    if (bubble !== null) {
      if (!started || answer === "") {
        bubble.textContent = "";
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = "The model returned no text. Try rephrasing, or check the model in .env.";
        bubble.append(note);
        item?.classList.add("failed");
        failed = true;
      } else {
        bubble.textContent = answer;
      }
    }

    if (failed) {
      showBanner("The model returned an empty reply.", () => retryLastTurn());
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      if (bubble !== null && answer === "") bubble.textContent = "Stopped before any reply.";
      else if (bubble !== null) bubble.textContent = answer;
      return;
    }

    if (bubble !== null) {
      bubble.textContent = "";
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = answer === "" ? "No reply received." : answer;
      bubble.append(note);
      item?.classList.add("failed");
    }

    showBanner(error?.message ?? "Something went wrong.", () => retryLastTurn());
  } finally {
    bubble?.classList.remove("streaming");
    setStreaming(false);
    state.controller = null;
    els.input.focus();
    void refreshSessions();
  }
}

async function send(text) {
  const message = text.trim();
  if (message === "" || state.streaming) return;

  addMessage("user", message);
  els.input.value = "";
  autoGrow();

  const body = { message, ...currentSettings() };
  if (state.sessionId) body.sessionId = state.sessionId;

  await runTurn(body, { ensureAssistantBubble: true });
}

async function retryLastTurn() {
  if (state.streaming) return;
  if (state.sessionId === null) return;

  removeLastAssistantTurn();

  const body = { retry: true, sessionId: state.sessionId, ...currentSettings() };
  await runTurn(body, { ensureAssistantBubble: true });
}

/* --------------------------------------------------------------- sessions */

async function refreshSessions() {
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions ?? [];
    renderSessions();
  } catch {
    /* the session list is not critical; leave what we have */
  }
}

function renderSessions() {
  els.sessions.replaceChildren();

  if (state.sessions.length === 0) {
    const hint = document.createElement("li");
    hint.className = "hint";
    hint.textContent = "No conversations yet.";
    els.sessions.append(hint);
    return;
  }

  for (const session of state.sessions) {
    const item = document.createElement("li");
    item.className = `session${session.id === state.sessionId ? " active" : ""}`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.title || "New chat";

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = `${session.messageCount} message${session.messageCount === 1 ? "" : "s"} · ${relativeTime(session.updatedAt)}`;

    open.append(title, meta);
    open.addEventListener("click", () => {
      void selectSession(session.id);
      els.app.classList.remove("sidebar-open");
    });

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "ghost mini";
    rename.textContent = "Rename";
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      void renameSession(session);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost mini";
    remove.textContent = "Delete";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteSession(session);
    });

    actions.append(rename, remove);
    item.append(open, actions);
    els.sessions.append(item);
  }
}

async function selectSession(id) {
  if (state.streaming) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    const session = data.session;
    state.sessionId = session.id;
    localStorage.setItem(SESSION_KEY, session.id);

    clearChat();
    for (const message of session.messages) renderStoredMessage(message);
    resetReviewBlock();
    renderSessions();
    scrollToBottom();
  } catch (error) {
    showBanner(error.message, () => void refreshSessions());
  }
}

function startNewChat() {
  if (state.streaming) return;
  state.sessionId = null;
  localStorage.removeItem(SESSION_KEY);
  clearChat();
  renderSessions();
  els.input.focus();
}

async function renameSession(session) {
  const next = window.prompt("Rename this conversation", session.title || "New chat");
  if (next === null) return;
  const title = next.trim();
  if (title === "") return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    await refreshSessions();
  } catch (error) {
    showBanner(error.message, null);
  }
}

async function deleteSession(session) {
  if (!window.confirm(`Delete "${session.title || "New chat"}"? This cannot be undone.`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    if (state.sessionId === session.id) startNewChat();
    await refreshSessions();
  } catch (error) {
    showBanner(error.message, null);
  }
}

/* --------------------------------------------------------------- health */

async function checkHealth() {
  setStatus("pending", "Checking the model…");
  try {
    const data = await api("/api/health");
    const active = data.provider ?? {};
    const activeCheck = (data.providers ?? []).find((entry) => entry.active);

    const unavailable = (data.tools ?? []).filter((tool) => !tool.ok);
    const browser = unavailable.find((tool) => tool.name === "browser_navigate");
    const notes = [`Workspace: ${data.workspace?.dir ?? "unknown"}`];
    if (browser) notes.push("Browsing is off (Playwright not installed).");
    els.workspaceHint.textContent = notes.join("\n");

    if (data.ok) {
      setStatus("ok", `${active.label ?? active.id ?? "Model"} · ${active.model ?? ""}`.trim());
      hideBanner();
      setComposerEnabled(true);
      return;
    }

    setStatus("error", `${active.label ?? "Model"} unavailable`);
    showBanner(activeCheck?.detail ?? "The model is unavailable.", () => void checkHealth());
    setComposerEnabled(false);
  } catch {
    setStatus("error", "Server unreachable");
    showBanner("Cannot reach the ANIZ AI server. Is it still running?", () => void checkHealth());
    setComposerEnabled(false);
  }
}

/* --------------------------------------------------------------- wiring */

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (["chat", "agent", "plan"].includes(saved.mode)) els.mode.value = saved.mode;
    if (["assistant", "coder", "researcher", "reviewer"].includes(saved.role)) els.role.value = saved.role;
    els.review.checked = saved.review === true;
    els.allowWrite.checked = saved.allowWrite === true;
  } catch {
    /* defaults are fine */
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
}

for (const control of [els.mode, els.role, els.review, els.allowWrite]) {
  control.addEventListener("change", saveSettings);
}

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send(els.input.value);
});

els.input.addEventListener("input", autoGrow);
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send(els.input.value);
  }
});

els.stop.addEventListener("click", () => state.controller?.abort());
els.retry.addEventListener("click", () => {
  const action = state.retryAction;
  if (action) action();
});
els.newChat.addEventListener("click", startNewChat);
els.toggleSidebar.addEventListener("click", () => els.app.classList.add("sidebar-open"));
els.closeSidebar.addEventListener("click", () => els.app.classList.remove("sidebar-open"));

async function init() {
  loadSettings();
  autoGrow();
  updateEmpty();
  renderSessions();
  await checkHealth();
  await refreshSessions();
  if (state.sessionId) await selectSession(state.sessionId);
}

void init();
