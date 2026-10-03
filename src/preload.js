const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

contextBridge.exposeInMainWorld('muse', {
  getState: () => call('state:get'),
  listMachines: () => call('machines:list'),
  selectMachine: (id) => call('machines:select', id),
  liveScreen: (id) => call('machines:live', id),
  startTask: (text, attachments) => call('task:start', { text, attachments }),
  approve: (approvalId, decision) => call('task:approve', { approvalId, decision }),
  abort: (sessionId) => call('task:abort', { sessionId }),
  pickFiles: () => call('file:pick'),
  newChat: () => call('chat:new'),
  openChat: (id) => call('chat:open', id),
  deleteChat: (id) => call('chat:delete', id),
  onChatsChanged: (fn) => ipcRenderer.on('chats:changed', (_e, chats) => fn(chats)),
  saveSettings: (s) => call('settings:save', s),
  openLink: (url) => call('link:open', url),
  onTaskUpdate: (fn) => ipcRenderer.on('task:update', (_e, payload) => fn(payload)),
});
