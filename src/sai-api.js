// Thin client for the Sai agents API (https://api.simular.ai/v1/agents/*).
// Endpoints and semantics mirror @simular-ai/sai-mcp 0.2.2.

const DEFAULT_API_URL = 'https://api.simular.ai';
const APPROVAL_URL_BASE = 'https://sai.simular.ai/approval';

class SaiApiError extends Error {
  constructor(status, body, message) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class SaiApi {
  constructor(apiKey, apiUrl = DEFAULT_API_URL) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  async json(path, { prefix, timeoutMs = 15000, ...init } = {}) {
    let res;
    try {
      res = await fetch(`${this.apiUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`${prefix}: request timed out.`);
      throw new Error(`${prefix}: could not reach Sai (${err.cause?.message ?? err.message}).`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = typeof body.error === 'string' ? body.error : res.statusText;
      const hint = res.status === 401 ? ' Your Sai API key was rejected — it may be revoked or expired.' : '';
      const err = new SaiApiError(res.status, body, `${prefix} (${res.status}): ${detail}.${hint}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterS = retryAfter;
      throw err;
    }
    return res.json();
  }

  auth() {
    return this.json('/v1/agents/auth', { headers: this.headers(), prefix: 'Sign-in check failed' });
  }

  async machines() {
    const { machines } = await this.json('/v1/agents/machines', { headers: this.headers(), prefix: 'Could not list computers' });
    return machines;
  }

  // View-only Guacamole tunnel: { websocketUrl, width, height }. The URL carries a
  // session token, so it goes to the screen view only, never to logs.
  liveScreen(machineId) {
    return this.json(`/v1/agents/machines/${encodeURIComponent(machineId)}/live`, {
      method: 'POST',
      headers: this.headers(),
      timeoutMs: 20000,
      prefix: 'Live screen unavailable',
    });
  }

  async newSession(machineId) {
    const { sessionId } = await this.json('/v1/agents/new-session', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ machineId, channel: 'api' }),
      prefix: 'Could not start a new conversation',
    });
    return sessionId;
  }

  // Returns { sessionId, machineId, queued } without waiting for the task.
  sendMessage({ machineId, message, attachments, model }) {
    return this.json('/v1/agents/message', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        machineId,
        message,
        wait: false,
        ...(attachments?.length && { attachments }),
        ...(model && { model }),
      }),
      timeoutMs: 30000,
      prefix: 'Could not send the task',
    });
  }

  // Long-polls up to waitS (0..60) seconds. Returns { status, events, text, approval?, usage?, cursor }.
  events(sessionId, since, waitS) {
    const params = new URLSearchParams({ sessionId, wait: String(waitS) });
    if (since) params.set('since', since);
    return this.json(`/v1/agents/events?${params}`, {
      headers: this.headers(),
      timeoutMs: (waitS + 15) * 1000,
      prefix: 'Could not fetch task updates',
    });
  }

  // decision: 'approve' | 'approve_for_task' | 'deny'
  approve(approvalId, decision, selections) {
    const response = { approve: 'yes', approve_for_task: 'task', deny: 'no' }[decision];
    return this.json('/v1/agents/approve', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ approvalId, response, ...(selections && { selections }) }),
      prefix: 'Could not send your decision',
    });
  }

  abort(sessionId) {
    return this.json('/v1/agents/abort', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sessionId }),
      prefix: 'Could not stop the task',
    });
  }

  // Raw bytes in the body; the server derives the MIME type from the file name.
  upload(name, bytes) {
    return this.json('/v1/agents/upload', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }),
      body: bytes,
      timeoutMs: 120000,
      prefix: 'Upload failed',
    });
  }
}

function approvalUrl(userId, approvalId) {
  return `${APPROVAL_URL_BASE}/${encodeURIComponent(userId)}/${encodeURIComponent(approvalId)}`;
}

module.exports = { SaiApi, SaiApiError, approvalUrl };
