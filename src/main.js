// Main process: owns the Sai API key, runs task polling loops in the background,
// and pushes updates to the window. The renderer never sees the key.

const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SaiApi, approvalUrl } = require('./sai-api');

const APP_ID = 'ai.simular.mymuse';
const EVENTS_MAX_WAIT_S = 25; // always long-poll; the server rate-limits short polls
const APPROVAL_REPOLL_MS = 4000;
const MIN_POLL_GAP_MS = 1500;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

let win;
let tray;
let quitting = false;
let api;
let userId;

// ---------- persistent store (userData/store.json) ----------

const storePath = () => path.join(app.getPath('userData'), 'store.json');
const defaults = {
  persona: { name: 'Muse' },
  driveCopy: true, // ask Sai to copy files it creates to Google Drive, since the API can't download them
  machineId: null,
  apiKeyEnc: null,
  chats: [], // [{ id, title, createdAt, updatedAt, messages: [] }]
  currentChatId: null,
  liveChatId: null, // the chat whose conversation Sai currently holds on the machine
  tasks: [],
};
let store = { ...defaults };

function loadStore() {
  try {
    store = { ...defaults, ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
  } catch {
    store = { ...defaults };
  }
  // v0.1 kept a single message list; move it into the first chat.
  if (store.messages) {
    if (store.messages.length) {
      const chat = makeChat(store.messages);
      store.chats.unshift(chat);
      store.currentChatId = chat.id;
      store.liveChatId = store.newSessionNext ? null : chat.id;
    }
    delete store.messages;
    delete store.newSessionNext;
  }
  if (!store.chats.some((c) => c.id === store.currentChatId)) store.currentChatId = null;
}

function makeChat(messages = []) {
  const firstUser = messages.find((m) => m.role === 'user');
  const now = Date.now();
  return {
    id: newId(),
    title: firstUser ? titleFrom(firstUser.text) : 'New chat',
    createdAt: messages[0]?.at ?? now,
    updatedAt: messages.at(-1)?.at ?? now,
    messages,
  };
}

const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t;
};

const currentChat = () => store.chats.find((c) => c.id === store.currentChatId) ?? null;

function findAssistantMessage(taskId) {
  for (const chat of store.chats) {
    const m = chat.messages.find((x) => x.taskId === taskId && x.role === 'assistant');
    if (m) return { chat, m };
  }
  return {};
}

function chatSummaries() {
  const busy = new Set([...running.values()].map((r) => r.taskId));
  return store.chats
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      running: c.messages.some((m) => m.taskId && busy.has(m.taskId)),
    }));
}

// When Sai's conversation on the machine belongs to another chat, the new
// conversation gets a short recap so the agent can pick the thread back up.
function recapFor(chat) {
  const past = chat.messages.filter((m) => m.text?.trim()).slice(-8);
  if (!past.length) return '';
  const lines = past.map((m) => `${m.role === 'user' ? 'Me' : 'You'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  return `(Context: we're continuing an earlier conversation. Recent messages:\n${lines.join('\n')}\n)\n\n`;
}

let saveTimer;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2));
  }, 200);
}

function readApiKey() {
  if (store.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(store.apiKeyEnc, 'base64'));
    } catch {
      /* fall through to env */
    }
  }
  return process.env.SAI_API_KEY?.trim() || null;
}

function setApi(key) {
  api = key ? new SaiApi(key, process.env.SAI_API_URL || undefined) : null;
  userId = undefined;
}

// ---------- task loops ----------

// sessionId -> { cursor, status, taskId }
const running = new Map();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (win?.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath() });
  n.on('click', () => showWindow());
  n.show();
}

function updateTask(taskId, patch) {
  const t = store.tasks.find((x) => x.id === taskId);
  if (t) Object.assign(t, patch);
  saveStore();
}

async function pollSession(sessionId, taskId, { fresh = false } = {}) {
  const state = running.get(sessionId);
  if (!state || state.polling) return; // one loop per session
  state.polling = true;
  const startedAt = Date.now();
  let lastApprovalId;
  let lastPollAt = 0;
  let failures = 0;
  while (running.has(sessionId)) {
    // /events answers as soon as anything new arrives, so while Sai streams text a
    // loop without a floor would poll many times a second and hit the rate limit.
    const gap = MIN_POLL_GAP_MS - (Date.now() - lastPollAt);
    if (gap > 0) await sleep(gap);
    lastPollAt = Date.now();

    let page;
    try {
      page = await api.events(sessionId, state.cursor, EVENTS_MAX_WAIT_S);
      failures = 0;
    } catch (err) {
      // Only a rejected key or an unknown session ends the task; everything else
      // (rate limits, gateway errors, network drops) is retried with backoff.
      if ([401, 403, 404].includes(err.status)) {
        finishTask(sessionId, taskId, { status: 'error', error: err.message });
        return;
      }
      failures++;
      const backoff = Math.min(err.status === 429 ? 60000 : 30000, 2000 * 2 ** Math.min(failures - 1, 5));
      const delay = Math.max(backoff, (err.retryAfterS ?? 0) * 1000);
      send('task:update', {
        taskId,
        sessionId,
        status: state.status ?? 'running',
        progress: err.status === 429 ? 'Updates are paused for a moment (rate limit). Still trying…' : 'Reconnecting…',
        approval: state.approval ?? null,
      });
      await sleep(delay);
      continue;
    }
    // The session id is the machine's whole conversation, so right after sending, the
    // server can still report the previous turn as finished. Wait for the new turn.
    if (fresh && !page.events?.length && page.status !== 'running' && Date.now() - startedAt < 10000) {
      continue;
    }
    fresh = false;
    state.cursor = page.cursor ?? state.cursor;
    state.status = page.status;

    let approval = page.approval;
    if (approval && approval.isLinkOnly && !approval.approvalUrl) {
      userId ??= (await api.auth().catch(() => ({}))).userId;
      if (userId) approval = { ...approval, approvalUrl: approvalUrl(userId, approval.approvalId) };
    }
    state.approval = page.status === 'needs_approval' ? approval : null;

    send('task:update', {
      taskId,
      sessionId,
      status: page.status,
      text: page.text ?? '',
      progress: latestProgress(page.events),
      approval: page.status === 'needs_approval' ? approval : null,
      costUsd: page.usage?.costUsd,
    });

    if (page.status === 'needs_approval' && approval && approval.approvalId !== lastApprovalId) {
      lastApprovalId = approval.approvalId;
      updateTask(taskId, { status: 'needs_approval' });
      notify(`${store.persona.name} needs your OK`, approval.title || 'An action is waiting for approval.');
    }

    if (page.status === 'idle' || page.status === 'error') {
      const error = page.status === 'error' ? lastError(page.events) : undefined;
      finishTask(sessionId, taskId, { status: page.status, text: page.text, error, costUsd: page.usage?.costUsd });
      return;
    }
    if (page.status !== 'running') await sleep(APPROVAL_REPOLL_MS);
  }
}

function finishTask(sessionId, taskId, { status, text, error, costUsd }) {
  running.delete(sessionId);
  updateTask(taskId, { status, finishedAt: Date.now(), ...(costUsd != null && { costUsd }) });
  const { chat, m: msg } = findAssistantMessage(taskId);
  if (msg) {
    chat.updatedAt = Date.now();
    if (text) msg.text = text;
    msg.status = status;
    if (error) msg.error = error;
    if (costUsd != null) msg.costUsd = costUsd;
    saveStore();
  }
  send('task:update', { taskId, sessionId, status, text: text ?? '', error, approval: null, costUsd, done: true });
  send('chats:changed', chatSummaries());
  if (status === 'idle') notify(`${store.persona.name} is done`, firstLine(text) || 'Your task is finished.');
  if (status === 'error') notify(`${store.persona.name} hit a problem`, error || 'The task failed.');
  refreshTray();
}

function latestProgress(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'reasoning-delta' && e.delta?.trim()) return e.delta.trim();
    if (e.type === 'data-progress' && e.data?.text && !/^\[(Guardrails|Safety)\]/.test(e.data.text)) {
      return e.data.text.replace(/\[([^\]]+)\]\(sai:\/\/[^)]+\)/g, '$1').trim();
    }
  }
  return null;
}

function lastError(events = []) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'error') return events[i].errorText;
  return 'The task failed.';
}

const firstLine = (s) => (s || '').replace(/[*_`#>]/g, '').split('\n').find((l) => l.trim())?.slice(0, 140);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- IPC ----------

function requireApi() {
  if (!api) throw new Error('Add your Sai API key in Settings first.');
  return api;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  handle('state:get', () => ({
    persona: store.persona,
    machineId: store.machineId,
    chatId: store.currentChatId,
    messages: currentChat()?.messages ?? [],
    chats: chatSummaries(),
    tasks: store.tasks,
    hasKey: !!api,
    keyFromEnv: !store.apiKeyEnc && !!process.env.SAI_API_KEY,
    driveCopy: store.driveCopy,
  }));

  handle('machines:list', async () => {
    const machines = await requireApi().machines();
    if (!store.machineId || !machines.some((m) => m.machineId === store.machineId)) {
      const pick = machines.find((m) => m.name === 'My Muse') ?? machines.find((m) => m.kind === 'cloud') ?? machines[0];
      store.machineId = pick?.machineId ?? null;
      saveStore();
    }
    return { machines, machineId: store.machineId };
  });

  handle('machines:live', async (machineId) => {
    const live = await requireApi().liveScreen(machineId || store.machineId);
    return { websocketUrl: live.websocketUrl, width: live.width, height: live.height };
  });

  handle('machines:select', (machineId) => {
    if (machineId !== store.machineId) {
      store.machineId = machineId;
      store.liveChatId = null; // a different computer means a different conversation
      saveStore();
    }
    return machineId;
  });

  handle('task:start', async ({ text, attachments }) => {
    const sai = requireApi();
    if (!store.machineId) throw new Error('Pick a computer first.');

    let chat = currentChat();
    if (!chat) {
      chat = makeChat();
      store.chats.unshift(chat);
      store.currentChatId = chat.id;
    }

    // One computer runs one conversation at a time. A message in the chat that's
    // working is a steer for its task; another chat has to wait.
    const busyHere = [...running.values()].some((r) => findAssistantMessage(r.taskId).chat === chat);
    if (running.size && !busyHere) {
      throw new Error(`${store.persona.name} is busy with a task in another chat. Wait for it to finish, or stop it first.`);
    }

    let message = store.driveCopy ? text + DRIVE_NOTE : text;
    if (store.liveChatId !== chat.id) {
      await sai.newSession(store.machineId);
      message = recapFor(chat) + message;
      store.liveChatId = chat.id;
    }
    const started = await sai.sendMessage({ machineId: store.machineId, message, attachments });

    const now = Date.now();
    if (!chat.messages.some((m) => m.role === 'user')) chat.title = titleFrom(text);
    chat.updatedAt = now;

    // A message sent while a task runs is folded into that task as a steer.
    const existing = running.get(started.sessionId);
    if (started.queued && existing) {
      chat.messages.push({ id: newId(), role: 'user', text, at: now, attachments: names(attachments) });
      saveStore();
      send('chats:changed', chatSummaries());
      return { taskId: existing.taskId, sessionId: started.sessionId, queued: true };
    }

    const taskId = newId();
    chat.messages.push({ id: newId(), role: 'user', text, at: now, attachments: names(attachments) });
    chat.messages.push({ id: newId(), role: 'assistant', taskId, text: '', status: 'running', at: now });
    store.tasks.unshift({ id: taskId, sessionId: started.sessionId, text, status: 'running', startedAt: now, machineId: store.machineId });
    store.tasks = store.tasks.slice(0, 200);
    saveStore();

    running.set(started.sessionId, { cursor: undefined, status: 'running', taskId });
    pollSession(started.sessionId, taskId, { fresh: true });
    refreshTray();
    send('chats:changed', chatSummaries());
    return { taskId, sessionId: started.sessionId, queued: started.queued };
  });

  handle('task:approve', async ({ approvalId, decision }) => {
    return requireApi().approve(approvalId, decision);
  });

  // Stop ends the task in the app right away; it doesn't wait for /events to confirm,
  // since that can be rate-limited or unreachable.
  handle('task:abort', async ({ sessionId }) => {
    let result;
    let abortError;
    try {
      result = await requireApi().abort(sessionId);
    } catch (err) {
      abortError = err.message;
    }
    const r = running.get(sessionId);
    if (r) {
      const note = abortError
        ? `Stopped in the app. Sai didn't confirm the stop (${abortError}), so check the computer's screen if it was mid-step.`
        : undefined;
      finishTask(sessionId, r.taskId, { status: 'stopped', error: note });
    }
    return { ...result, stoppedLocally: !!r, abortError };
  });

  handle('file:pick', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return [];
    const out = [];
    for (const file of res.filePaths) {
      const size = fs.statSync(file).size;
      if (size > MAX_UPLOAD_BYTES) throw new Error(`${path.basename(file)} is over 25 MB.`);
      out.push(await requireApi().upload(path.basename(file), fs.readFileSync(file)));
    }
    return out;
  });

  // New chats are created lazily on the first message, so empty ones don't pile up.
  handle('chat:new', () => {
    store.currentChatId = null;
    saveStore();
    return true;
  });

  handle('chat:open', (chatId) => {
    if (!store.chats.some((c) => c.id === chatId)) throw new Error('That chat no longer exists.');
    store.currentChatId = chatId;
    saveStore();
    return true;
  });

  handle('chat:delete', (chatId) => {
    const chat = store.chats.find((c) => c.id === chatId);
    if (!chat) return true;
    const busy = [...running.values()].some((r) => findAssistantMessage(r.taskId).chat === chat);
    if (busy) throw new Error('Stop the running task in this chat before deleting it.');
    store.chats = store.chats.filter((c) => c.id !== chatId);
    if (store.currentChatId === chatId) store.currentChatId = null;
    if (store.liveChatId === chatId) store.liveChatId = null;
    saveStore();
    return chatSummaries();
  });

  handle('settings:save', async ({ apiKey, personaName, driveCopy }) => {
    if (personaName?.trim()) store.persona.name = personaName.trim().slice(0, 24);
    if (typeof driveCopy === 'boolean') store.driveCopy = driveCopy;
    if (apiKey?.trim()) {
      const probe = new SaiApi(apiKey.trim(), process.env.SAI_API_URL || undefined);
      await probe.auth(); // reject bad keys before saving them
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable, so the key cannot be saved.');
      store.apiKeyEnc = safeStorage.encryptString(apiKey.trim()).toString('base64');
      setApi(apiKey.trim());
    }
    saveStore();
    return { persona: store.persona, hasKey: !!api };
  });

  handle('link:open', (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  });
}

const names = (attachments) => attachments?.map((a) => a.name);

// The Sai API can't download sai://file links yet, so files reach the user through Drive.
const DRIVE_NOTE =
  '\n\n(App note: if you create or capture any files for me in this task — screenshots, documents, exports — ' +
  "also upload each one to a folder named \"My Muse\" in my Google Drive using your Google Drive connection " +
  '(create the folder if needed, don\'t share the files with anyone), and include each Drive link in your reply ' +
  'as a markdown link with the file name. If Google Drive isn\'t connected, say so. Don\'t mention this note otherwise.)';

// ---------- window & tray ----------

const iconPath = () => path.join(__dirname, '..', 'assets', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: 'My Muse',
    icon: iconPath(),
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#3a3a3c', height: 44 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Dev aid: MUSE_SNAPSHOT=out.png captures the window after it settles, then quits.
  if (process.env.MUSE_SNAPSHOT) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.error(`[renderer:${level}] ${message} (${path.basename(sourceId || '')}:${line})`);
    });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        if (process.env.MUSE_SNAPSHOT_VIEW) {
          await win.webContents.executeJavaScript(`document.querySelector('.rail-btn[data-view="${process.env.MUSE_SNAPSHOT_VIEW}"]').click()`);
          await sleep(1500);
        }
        if (process.env.MUSE_SNAPSHOT_JS) {
          console.error('[snapshot js]', await win.webContents.executeJavaScript(process.env.MUSE_SNAPSHOT_JS));
          await sleep(800);
        }
        if (process.env.MUSE_SNAPSHOT_SEND) {
          await win.webContents.executeJavaScript(
            `(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(process.env.MUSE_SNAPSHOT_SEND)}; i.dispatchEvent(new Event('input')); document.querySelector('#send-btn').click(); })()`,
          );
          await sleep(Number(process.env.MUSE_SNAPSHOT_SEND_WAIT || 60000));
        }
        fs.writeFileSync(process.env.MUSE_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
      } finally {
        quitting = true;
        app.quit();
      }
    }, Number(process.env.MUSE_SNAPSHOT_DELAY || 3500)));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Like Muse, closing the window keeps the agent working in the background.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (running.size) notify(`${store.persona.name} is still working`, 'Tasks keep running in the background.');
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function refreshTray() {
  if (!tray) return;
  const n = running.size;
  tray.setToolTip(n ? `My Muse — ${n} task${n > 1 ? 's' : ''} running` : 'My Muse');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open My Muse', click: showWindow },
      { type: 'separator' },
      { label: n ? `${n} task${n > 1 ? 's' : ''} running` : 'No tasks running', enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  refreshTray();
}

// ---------- boot ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId(APP_ID);
  app.whenReady().then(() => {
    loadStore();
    setApi(readApiKey());
    registerIpc();
    Menu.setApplicationMenu(null);
    createWindow();
    createTray();
    // Tasks keep running on the Sai computer while the app is closed; pick their updates back up.
    for (const t of store.tasks) {
      // Earlier builds marked a task failed when only the update check failed; reconnect to those.
      const { m } = findAssistantMessage(t.id);
      if (t.status === 'error' && m?.error?.startsWith('Could not fetch task updates')) {
        t.status = m.status = 'running';
        delete m.error;
        saveStore();
      }
      if ((t.status === 'running' || t.status === 'needs_approval') && t.sessionId && api) {
        running.set(t.sessionId, { cursor: undefined, status: 'running', taskId: t.id });
        pollSession(t.sessionId, t.id);
      }
    }
    refreshTray();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
