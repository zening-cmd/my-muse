/* global muse, Guacamole */
// View-only live screen of a Sai computer over the Guacamole tunnel from
// POST /machines/:id/live. Mirrors the connect flow in @simular-ai/sai-mcp's task view.
(function () {
  const STATE_CONNECTED = 3;
  const STATE_DISCONNECTED = 5;
  let current = null; // { machineId, client, observer, closed }
  let token = 0;

  const $ = (s) => document.querySelector(s);
  const note = (text) => {
    const n = $('#screen-note');
    n.textContent = text || '';
    n.hidden = !text;
  };
  const setLive = (on) => {
    $('#live-badge').hidden = !on;
    $('#screen-reconnect').hidden = on;
  };

  function teardown() {
    if (!current) return;
    current.closed = true;
    current.observer?.disconnect();
    try { current.client?.disconnect(); } catch { /* already closed */ }
    const screen = $('#screen');
    [...screen.children].forEach((c) => c.id !== 'screen-note' && c.remove());
    current = null;
  }

  async function connect(machineId, name) {
    teardown();
    const mine = ++token;
    $('#screen-title').textContent = name || 'Screen';
    setLive(false);
    $('#screen-reconnect').hidden = true;
    note('Connecting to the computer…');

    let live;
    for (;;) {
      try {
        live = await muse.liveScreen(machineId);
      } catch (err) {
        if (mine !== token) return;
        note(err.message);
        $('#screen-reconnect').hidden = false;
        return;
      }
      if (mine !== token) return;
      if (live?.websocketUrl) break;
      note('Waiting for the computer to start…');
      await new Promise((r) => setTimeout(r, 8000));
      if (mine !== token) return;
    }

    const [base, query = ''] = live.websocketUrl.split('?', 2);
    const tunnel = new Guacamole.WebSocketTunnel(base);
    const client = new Guacamole.Client(tunnel);
    const display = client.getDisplay();
    const screen = $('#screen');
    screen.append(display.getElement());

    const fit = () => {
      const w = display.getWidth();
      const h = display.getHeight();
      if (w > 0 && h > 0) display.scale(Math.min(screen.clientWidth / w, screen.clientHeight / h));
    };
    display.onresize = fit;
    const observer = new ResizeObserver(fit);
    observer.observe(screen);
    current = { machineId, client, observer, closed: false };
    const self = current;

    const lost = (msg) => {
      if (self.closed) return;
      self.closed = true;
      observer.disconnect();
      setLive(false);
      note(msg || 'The screen disconnected.');
    };
    tunnel.onerror = (s) => lost(s?.message ? `Connection error: ${s.message}` : 'Connection error.');
    client.onerror = (s) => lost(s?.message ? `Screen error: ${s.message}` : 'Screen error.');
    client.onstatechange = (state) => {
      if (state === STATE_CONNECTED) { note(''); setLive(true); fit(); }
      else if (state === STATE_DISCONNECTED) lost('The screen disconnected.');
    };
    client.connect(query);
  }

  function disconnect() {
    token++;
    teardown();
    setLive(false);
    $('#screen-reconnect').hidden = true;
  }

  window.LiveScreen = { connect, disconnect, get machineId() { return current?.machineId ?? null; } };
})();
