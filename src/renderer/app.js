/* global muse, renderMarkdown */
const $ = (sel) => document.querySelector(sel);

const IDEAS = [
  { emoji: '🌙', title: 'Get me ready for tomorrow', detail: 'Calendar, email and prep in one brief', text: "Get me ready for tomorrow: check my calendar, find related emails and documents for each event, flag any conflicts, and give me a short morning brief. Ask before sending anything." },
  { emoji: '🗂️', title: 'Clean up my Downloads', detail: 'Sort files, trash the old stuff', text: 'My Downloads folder is a mess — organize it into folders by type, and list anything older than 6 months that you would move to the Recycle Bin. Ask me before deleting.' },
  { emoji: '📬', title: 'What did I miss this week?', detail: 'A digest of what needs you', text: "Go through my email from the past week and sort it into: needs my reply, FYI, and safe to ignore. Give me the top 5 that need me." },
  { emoji: '📝', title: 'Fill out a form for me', detail: 'Uses info from your files', text: 'I need to fill out a form. I will attach it — fill it in using information from my documents, and show me what you filled before submitting anything.' },
  { emoji: '🛒', title: 'Compare prices', detail: 'Find the best deal online', text: 'Compare prices for [product] across major stores, including shipping and return policy, and tell me the best option.' },
  { emoji: '🎂', title: 'Plan a birthday dinner', detail: 'Restaurant, time and invites', text: 'Help me plan a birthday dinner for [name] next weekend: suggest 3 restaurants nearby with availability, and draft an invite message. Don’t book or send anything without asking.' },
];

const ROUTINES = [
  { emoji: '🍎', title: 'School stuff', detail: 'Permission slips, events, deadlines', text: "Check my email for anything from my kid's school this week — permission slips, events, deadlines — and give me a short list of what needs my action." },
  { emoji: '🌤️', title: 'Morning brief', detail: 'Your day at a glance', text: 'Get me ready for today: summarize my calendar, important unread email, and anything I need to prepare.' },
  { emoji: '🏈', title: 'Weekend plans', detail: 'Family activities nearby', text: 'Find 3 fun family activities near me this weekend with times and prices.' },
  { emoji: '📄', title: 'Tidy documents', detail: 'Organize Documents and Downloads', text: 'Organize my Documents and Downloads folders by type and year, and tell me what you would delete before deleting anything.' },
];

const state = {
  persona: { name: 'Muse' },
  messages: [],
  chats: [],
  chatId: null,
  tasks: [],
  live: {}, // taskId -> { status, text, progress, approval, costUsd, sessionId, error }
  decisions: {}, // taskId -> [{ title, label }]
  machines: [],
  machineId: null,
  attachments: [],
  hasKey: false,
  view: 'chat',
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
  return node;
}

const icon = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = paths;
  return s;
};
const ICON_SCREEN = '<rect x="3.5" y="4.5" width="17" height="12.5" rx="2.5"/><path d="M8 20h8"/>';
const ICON_CHEVRON = '<path d="M6 9.5l6 6 6-6"/>';

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtStamp(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return fmtTime(ts);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + fmtTime(ts);
}
const withPersona = (s) => (s || '').replace(/\bSai\b/g, state.persona.name);
const activeTask = () => state.tasks.find((t) => ['running', 'needs_approval'].includes(liveStatus(t.id) ?? t.status));
const liveStatus = (taskId) => state.live[taskId]?.status;

// ---------- views ----------

function setView(view) {
  state.view = view;
  document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  if (view === 'computer') {
    loadMachines().then(() => {
      const id = state.viewingId && state.machines.some((m) => m.machineId === state.viewingId) ? state.viewingId : state.machineId;
      if (id) viewScreen(id);
    });
  } else {
    window.LiveScreen.disconnect();
    document.querySelector('.view-panel[data-view="computer"]').classList.remove('expanded');
  }
  if (view === 'tasks') renderTasks();
  if (view === 'chat') $('#input').focus();
}

// ---------- chat thread ----------

function renderThread() {
  const scroll = $('#scroll');
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const openSummaries = new Set([...document.querySelectorAll('.summary.open')].map((n) => n.dataset.id));
  const thread = $('#thread');
  thread.replaceChildren();

  if (!state.messages.length) {
    thread.append(renderEmpty());
    return;
  }

  let lastTs = 0;
  for (const m of state.messages) {
    if (m.at - lastTs > 10 * 60 * 1000) thread.append(el('div', { class: 'stamp' }, fmtStamp(m.at)));
    lastTs = m.at;

    if (m.role === 'user') {
      thread.append(
        el('div', { class: 'msg user' },
          el('div', { class: 'bubble' }, m.text, m.attachments?.length ? el('div', { class: 'attach-line' }, '📎 ' + m.attachments.join(', ')) : null),
        ),
      );
      continue;
    }

    const live = state.live[m.taskId] || {};
    const status = live.status ?? m.status;
    const text = live.text || m.text;
    const busy = status === 'running' || status === 'needs_approval';

    if (text) thread.append(el('div', { class: 'msg agent' }, el('div', { class: 'bubble', html: renderMarkdown(withPersona(text)) })));

    for (const d of state.decisions[m.taskId] || []) {
      thread.append(el('div', { class: 'status-line' }, `${d.label}: ${withPersona(d.title)}`));
    }

    if (status === 'needs_approval' && live.approval) {
      thread.append(renderApproval(m.taskId, live.approval, openSummaries));
    } else if (busy) {
      const progress = live.progress ? withPersona(live.progress) : text ? 'Still working…' : 'Getting started…';
      thread.append(
        el('div', { class: 'status-line' },
          el('span', { class: 'dots' }, el('i'), el('i'), el('i')),
          el('span', {}, truncate(progress, 110)),
          live.sessionId ? el('button', { class: 'stop', onclick: () => stopTask(live.sessionId) }, 'Stop') : null,
        ),
      );
    } else if (status === 'error') {
      thread.append(el('div', { class: 'msg agent' }, el('div', { class: 'bubble err' }, live.error || m.error || 'Something went wrong.')));
    } else if (status === 'stopped') {
      thread.append(el('div', { class: 'status-line' }, '⏹ Stopped.'));
      const note = live.error || m.error;
      if (note) thread.append(el('div', { class: 'meta-line' }, note));
    }

    const cost = live.costUsd ?? m.costUsd;
    if (!busy && status === 'idle' && cost != null) thread.append(el('div', { class: 'meta-line' }, `$${cost.toFixed(2)}`));
  }

  if (atBottom) requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
}

function truncate(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderEmpty() {
  const machine = state.machines.find((m) => m.machineId === state.machineId);
  return el('div', { class: 'empty' },
    el('div', { class: 'avatar' }),
    el('h2', {}, `Hi, I'm ${state.persona.name}.`),
    el('p', {}, state.hasKey
      ? `Tell me what you need. I'll do it on ${machine ? `“${machine.name}”` : 'your cloud computer'} and check with you before anything important.`
      : 'Add your Sai API key in Settings to get started.'),
    el('div', { class: 'suggestions' },
      IDEAS.slice(0, 4).map((i) => el('button', { class: 'suggestion', onclick: () => prefill(i.text) }, `${i.emoji} ${i.title}`)),
    ),
  );
}

function renderApproval(taskId, a, openSummaries) {
  const linkOnly = a.isLinkOnly || a.approvalType === 'choice';
  const title = withPersona(a.title || `Allow ${state.persona.name} to continue?`);
  const description = withPersona(a.description || 'This step needs your OK.');
  const more = [a.command && `Command: ${a.command}`, a.cwd && `In: ${a.cwd}`].filter(Boolean).join('\n');
  const summary = el('div', { class: 'summary', 'data-id': a.approvalId, onclick: (e) => more && e.currentTarget.classList.toggle('open') },
    el('div', {}, el('div', { class: 'summary-label' }, 'Task summary'), el('div', { class: 'summary-text' }, description)),
    more ? icon(ICON_CHEVRON) : el('span'),
    more ? el('div', { class: 'summary-more' }, more) : null,
  );
  if (openSummaries.has(a.approvalId)) summary.classList.add('open');

  const decide = async (decision, label, buttons) => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      await muse.approve(a.approvalId, decision);
      (state.decisions[taskId] ||= []).push({ title: a.title || 'Approval', label });
      state.live[taskId] = { ...state.live[taskId], status: 'running', approval: null, progress: decision === 'deny' ? 'Okay, skipping that.' : 'On it…' };
      renderThread();
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      toast(err.message);
    }
  };

  let actions;
  if (linkOnly && a.approvalUrl) {
    actions = el('div', { class: 'approval-actions' },
      el('button', { class: 'btn primary', onclick: () => muse.openLink(a.approvalUrl) }, 'Open to continue'),
    );
  } else {
    const allow = el('button', { class: 'btn primary' }, 'Allow');
    const always = el('button', { class: 'btn' }, 'Always allow');
    const deny = el('button', { class: 'btn' }, 'Deny');
    const all = [allow, always, deny];
    allow.onclick = () => decide('approve', 'Allowed', all);
    always.onclick = () => decide('approve_for_task', 'Always allowed for this task', all);
    deny.onclick = () => decide('deny', 'Denied', all);
    actions = el('div', { class: 'approval-actions' }, all);
  }

  return el('div', { class: 'approval' },
    el('div', { class: 'approval-head' }, icon(ICON_SCREEN), el('span', {}, title)),
    summary,
    actions,
  );
}

// ---------- composer ----------

function prefill(text) {
  setView('chat');
  const input = $('#input');
  input.value = text;
  autosize();
  input.focus();
  const i = text.indexOf('[');
  if (i >= 0) input.setSelectionRange(i, text.indexOf(']', i) + 1);
}

function autosize() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  const hasText = input.value.trim().length > 0;
  $('#send-btn').hidden = !hasText;
  $('#mic-btn').hidden = hasText;
}

function renderChips() {
  $('#attach-chips').replaceChildren(
    ...state.attachments.map((a, i) =>
      el('span', { class: 'chip' }, a.name, el('button', { 'aria-label': `Remove ${a.name}`, onclick: () => { state.attachments.splice(i, 1); renderChips(); } }, '×')),
    ),
  );
}

async function send() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.hasKey) { setView('settings'); toast('Add your Sai API key first.'); return; }
  const attachments = state.attachments.slice();
  input.value = '';
  state.attachments = [];
  renderChips();
  autosize();
  try {
    const res = await muse.startTask(text, attachments);
    await reloadState();
    if (res.queued) toast(`${state.persona.name} is mid-task — added that as a note to it.`);
    state.live[res.taskId] = { ...state.live[res.taskId], sessionId: res.sessionId, status: state.live[res.taskId]?.status ?? 'running' };
    renderThread();
    updateMenu();
  } catch (err) {
    input.value = text;
    state.attachments = attachments;
    renderChips();
    autosize();
    toast(err.message);
  }
}

async function stopTask(sessionId) {
  try {
    toast('Stopping…');
    const res = await muse.abort(sessionId);
    toast(res.abortError ? 'Stopped in the app. Sai didn’t confirm, so check the screen.' : 'Stopped.');
  } catch (err) {
    toast(err.message);
  }
}

// ---------- panels ----------

async function loadMachines() {
  const list = $('#machine-list');
  if (!state.hasKey) { list.replaceChildren(el('div', { class: 'muted' }, 'Add your Sai API key in Settings first.')); return; }
  if (!state.machines.length) list.replaceChildren(el('div', { class: 'muted' }, 'Loading computers…'));
  try {
    const { machines, machineId } = await muse.listMachines();
    state.machines = machines;
    state.machineId = machineId;
    renderMachines();
    if (!state.messages.length) renderThread();
  } catch (err) {
    list.replaceChildren(el('div', { class: 'err' }, err.message));
  }
}

function viewScreen(machineId) {
  const m = state.machines.find((x) => x.machineId === machineId);
  state.viewingId = machineId;
  renderMachines();
  window.LiveScreen.connect(machineId, m?.name);
}

function renderMachines() {
  $('#machine-list').replaceChildren(
    ...state.machines.map((m) => {
      const inUse = m.machineId === state.machineId;
      const use = async (e) => {
        e.stopPropagation();
        await muse.selectMachine(m.machineId);
        state.machineId = m.machineId;
        renderMachines();
        toast(`${state.persona.name} will now work on “${m.name}”. The next message starts a fresh conversation.`);
      };
      return el('div', {
        class: 'row-item selectable' + (m.machineId === state.viewingId ? ' selected' : ''),
        role: 'button', tabindex: '0', title: 'Show this screen',
        onclick: () => viewScreen(m.machineId),
      },
        el('span', { class: 'dot' + (m.online ? ' on' : '') }),
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, m.name || m.machineId),
          el('div', { class: 'detail' }, `${m.kind === 'own' ? 'Your computer' : 'Cloud computer'} · ${m.online ? 'Online' : 'Offline'}`),
        ),
        inUse ? el('span', { class: 'badge running' }, `${state.persona.name} works here`) : el('button', { class: 'btn small', onclick: use }, `Use for ${state.persona.name}`),
      );
    }),
  );
}

function renderTasks() {
  const labels = { running: 'Working', needs_approval: 'Needs you', idle: 'Done', error: 'Failed', stopped: 'Stopped' };
  const list = $('#task-list');
  if (!state.tasks.length) { list.replaceChildren(el('div', { class: 'muted' }, 'No tasks yet.')); return; }
  list.replaceChildren(
    ...state.tasks.map((t) => {
      const status = liveStatus(t.id) ?? t.status;
      const machine = state.machines.find((m) => m.machineId === t.machineId);
      const cost = state.live[t.id]?.costUsd ?? t.costUsd;
      return el('div', { class: 'row-item' },
        el('div', { class: 'grow' },
          el('div', { class: 'title' }, t.text),
          el('div', { class: 'detail' }, [fmtStamp(t.startedAt), machine?.name, cost != null ? `$${cost.toFixed(2)}` : null].filter(Boolean).join(' · ')),
        ),
        el('span', { class: `badge ${status}` }, labels[status] || status),
      );
    }),
  );
}

function renderCards(container, items) {
  container.replaceChildren(
    ...items.map((i) =>
      el('button', { class: 'card', onclick: () => prefill(i.text) },
        el('span', { class: 'emoji' }, i.emoji), el('span', { class: 'title' }, i.title), el('span', { class: 'detail' }, i.detail)),
    ),
  );
}

function renderRoutineShortcuts() {
  $('#routine-shortcuts').replaceChildren(
    ...ROUTINES.map((r) => el('button', { title: r.title, 'aria-label': r.title, onclick: () => prefill(r.text) }, r.emoji)),
  );
}

function renderPersona() {
  $('#persona-name').textContent = state.persona.name;
  $('#set-name').value = state.persona.name;
  $('#input').placeholder = 'Message';
  document.title = `${state.persona.name} — My Muse`;
}

// ---------- chats ----------

function toggleDrawer(open) {
  const drawer = $('#chats-drawer');
  const show = open ?? drawer.hidden;
  drawer.hidden = !show;
  $('#chats-pill').setAttribute('aria-expanded', String(show));
  if (show) renderChatList();
}

function groupLabel(ts) {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - day) return 'Yesterday';
  if (ts >= startOfToday - 6 * day) return 'Previous 7 days';
  return 'Older';
}

function renderChatList() {
  const list = $('#chat-list');
  if (!state.chats.length) {
    list.replaceChildren(el('div', { class: 'drawer-empty' }, 'No chats yet. Send a message to start one.'));
    return;
  }
  const nodes = [];
  let group;
  for (const c of state.chats) {
    const g = groupLabel(c.updatedAt);
    if (g !== group) nodes.push(el('div', { class: 'chat-group' }, (group = g)));
    nodes.push(
      el('div', { class: 'chat-row' + (c.id === state.chatId ? ' current' : ''), role: 'button', tabindex: '0', onclick: () => openChat(c.id) },
        c.running ? el('span', { class: 'live-dot', title: 'Working' }) : null,
        el('div', { class: 'grow' }, el('div', { class: 'title' }, c.title), el('div', { class: 'when' }, fmtStamp(c.updatedAt))),
        el('button', { class: 'del', title: 'Delete chat', 'aria-label': `Delete ${c.title}`, onclick: (e) => { e.stopPropagation(); deleteChat(c); } }, '×'),
      ),
    );
  }
  list.replaceChildren(...nodes);
}

async function newChat() {
  await muse.newChat();
  state.decisions = {};
  await reloadState();
  toggleDrawer(false);
  setView('chat');
  renderThread();
}

async function openChat(id) {
  try {
    await muse.openChat(id);
    await reloadState();
    toggleDrawer(false);
    setView('chat');
    renderThread();
    requestAnimationFrame(() => ($('#scroll').scrollTop = $('#scroll').scrollHeight));
  } catch (err) {
    toast(err.message);
  }
}

async function deleteChat(c) {
  if (!confirm(`Delete “${c.title}”? This removes it from this app only.`)) return;
  try {
    await muse.deleteChat(c.id);
    await reloadState();
    renderChatList();
    renderThread();
  } catch (err) {
    toast(err.message);
  }
}

function updateMenu() {
  if (!$('#chats-drawer').hidden) renderChatList();
}

// ---------- state ----------

async function reloadState() {
  const s = await muse.getState();
  state.persona = s.persona;
  state.messages = s.messages;
  state.chats = s.chats;
  state.chatId = s.chatId;
  state.tasks = s.tasks;
  state.hasKey = s.hasKey;
  state.machineId = s.machineId;
  $('#set-drive').checked = s.driveCopy;
  $('#key-status').textContent = s.hasKey
    ? s.keyFromEnv ? 'Using SAI_API_KEY from your environment. Paste a key to save one in the app instead.' : 'A key is saved. Paste a new one to replace it.'
    : 'No key yet.';
  for (const t of s.tasks) {
    if (!state.live[t.id] && t.sessionId) state.live[t.id] = { sessionId: t.sessionId };
  }
}

muse.onTaskUpdate((u) => {
  const prev = state.live[u.taskId] || {};
  state.live[u.taskId] = {
    ...prev,
    sessionId: u.sessionId,
    status: u.status,
    text: u.text || prev.text,
    progress: u.progress || prev.progress,
    approval: u.approval,
    costUsd: u.costUsd ?? prev.costUsd,
    error: u.error,
  };
  if (u.done) reloadState().then(() => { renderThread(); if (state.view === 'tasks') renderTasks(); });
  else renderThread();
  if (state.view === 'tasks') renderTasks();
  updateMenu();
});

// ---------- wiring ----------

function wire() {
  document.querySelectorAll('.rail-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('#mic-btn').addEventListener('click', () => toast('Voice input is coming soon.'));
  $('#attach-btn').addEventListener('click', async () => {
    if (!state.hasKey) { toast('Add your Sai API key first.'); return; }
    try {
      toast('Uploading…');
      const files = await muse.pickFiles();
      state.attachments.push(...files);
      renderChips();
      if (files.length) toast(`Attached ${files.length} file${files.length > 1 ? 's' : ''}.`);
      else $('#toast').hidden = true;
    } catch (err) {
      toast(err.message);
    }
  });

  $('#chats-pill').addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
  $('#chats-drawer').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleDrawer(false));
  $('#new-chat-btn').addEventListener('click', newChat);
  $('#drawer-new').addEventListener('click', newChat);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
    if (e.key === 'Escape') toggleDrawer(false);
  });
  muse.onChatsChanged((chats) => { state.chats = chats; updateMenu(); });

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#settings-msg');
    msg.textContent = 'Saving…';
    try {
      await muse.saveSettings({ apiKey: $('#set-key').value, personaName: $('#set-name').value, driveCopy: $('#set-drive').checked });
      $('#set-key').value = '';
      await reloadState();
      renderPersona();
      renderThread();
      msg.textContent = 'Saved.';
      if (state.hasKey) loadMachines();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  $('#screen-reconnect').addEventListener('click', () => state.viewingId && viewScreen(state.viewingId));
  $('#screen-full').addEventListener('click', () => {
    const panel = document.querySelector('.view-panel[data-view="computer"]');
    panel.classList.toggle('expanded');
    $('#screen-full').textContent = panel.classList.contains('expanded') ? 'Show list' : 'Expand';
  });

  document.addEventListener('click', (e) => {
    const ws = e.target.closest('a.workspace-link');
    if (ws) { e.preventDefault(); setView('computer'); return; }
    const a = e.target.closest('a.ext');
    if (a) { e.preventDefault(); muse.openLink(a.href); }
  });
}

(async function boot() {
  wire();
  renderCards($('#idea-list'), IDEAS);
  renderCards($('#routine-list'), ROUTINES);
  renderRoutineShortcuts();
  await reloadState();
  renderPersona();
  renderThread();
  autosize();
  if (state.hasKey) loadMachines();
  else setView('settings');
})();
