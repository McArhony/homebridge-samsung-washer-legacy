'use strict';

// Client for the older local protocol of Samsung Wi-Fi appliances (2013-2015),
// the one the "AC14K" air conditioners use: XML messages over TLS on TCP 2878.
// Seen on a WW10H9400EW (it reports itself as "WW9000HE") on 24/10/2026, which
// has 8888 closed:
// - TLS 1.0 to 1.2, client certificate signed by Samsung's AC14K_M CA required;
// - on connect the appliance sends "DRC-1.00" then <Update Type="InvalidateAccount"/>;
// - <Request Type="GetToken"/> → Status="Ready"; a press on Smart Control (off,
//   then on again) → <Update Type="GetToken" Status="Completed" Token="…"/>;
// - every later session starts with <Request Type="AuthToken"><User Token="…"/></Request>;
// - <Request Type="DeviceList"/> gives the DUID, <Request Type="DeviceState" DUID="…">
//   the attributes (WM_FUN_OPERATION, WM_FUN_OTLEFT, WM_FUN_COURSE…).
// - <Request Type="DeviceControl"><Control CommandID="…" DUID="…"><Attr ID="WM_FUN_OPERATION"
//   Value="Start|Pause|Stop" /></Control></Request> → Status="Okay", then <Update Type="Status">
//   messages. Start also resumes; "Run" is refused with ErrorCode 210. Failures come
//   back as <Response Status="Fail" ErrorCode="…" CommandID="…"/>, without Type.

const tls = require('node:tls');
const { TLS_BASE, WasherError, classifySocketError } = require('./client');

const DRC_PORT = 2878;
const XML_DECL = '<?xml version="1.0" encoding="utf-8" ?>';
const TOKEN_WINDOW_MS = 30000;

// Home app states → WM_FUN_OPERATION values (tried on the real machine).
const OPERATION_VALUES = { Run: 'Start', Pause: 'Pause', Ready: 'Stop' };

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(value) {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
}

function parseAttributes(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = unescapeXml(m[2]);
  return attrs;
}

// One XML message → { tag, attrs, values (Attr ID → Value), devices, xml }.
function parseMessage(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const root = /^<([\w:]+)([^>]*?)\/?>/.exec(body);
  if (!root) throw new WasherError(`message illisible : ${JSON.stringify(xml.slice(0, 120))}`);
  const values = {};
  for (const m of body.matchAll(/<Attr\b([^>]*?)\/?>/g)) {
    const a = parseAttributes(m[1]);
    if (a.ID !== undefined) values[a.ID] = a.Value;
  }
  const devices = [...body.matchAll(/<Device\b([^>]*?)\/?>/g)].map((m) => parseAttributes(m[1]));
  return { tag: root[1], attrs: parseAttributes(root[2]), values, devices, xml };
}

// Splits the byte stream into complete messages; returns { greetings, messages, rest }.
function takeMessages(text) {
  const greetings = [];
  const messages = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('<?xml');
    // Without a message start, keep the last line: it may be a cut greeting or "<?x".
    const done = start === -1 ? rest.lastIndexOf('\n') + 1 : start;
    for (const m of rest.slice(0, done).matchAll(/DRC-[\d.]+/g)) greetings.push(m[0]);
    rest = rest.slice(done);
    if (start === -1) break;
    const decl = rest.indexOf('?>');
    if (decl === -1) break;
    const root = /^\s*<([\w:]+)[^>]*?(\/?)>/.exec(rest.slice(decl + 2));
    if (!root) break;
    let end;
    if (root[2] === '/') {
      end = decl + 2 + root.index + root[0].length;
    } else {
      const close = rest.indexOf(`</${root[1]}>`, decl + 2);
      if (close === -1) break;
      end = close + root[1].length + 3;
    }
    messages.push(parseMessage(rest.slice(0, end)));
    rest = rest.slice(end);
  }
  return { greetings, messages, rest };
}

// Without an accepted client certificate the handshake ends in an alert (after
// the connection is up with TLS 1.3, which the appliance itself does not offer).
function classifyTlsError(err, withCert) {
  if (!/handshake failure|certificate required|bad certificate|unknown ca/i.test(err.message)) return classifySocketError(err);
  return withCert
    ? new WasherError(`client certificate refused by the washer (${err.message})`, 'auth')
    : new WasherError('the washer requires a client certificate', 'auth');
}

// One TLS connection: send requests, wait for the matching message.
class DrcSession {
  constructor(socket, timeoutMs, withCert) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.inbox = [];
    this.greeting = null;
    this.waiters = [];
    this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      const { greetings, messages, rest } = takeMessages(this.buffer + chunk);
      this.buffer = rest;
      if (greetings.length && !this.greeting) this.greeting = greetings[0];
      this.inbox.push(...messages);
      this._dispatch();
    });
    const fail = (err) => {
      this.error = this.error || err;
      for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(this.error); }
    };
    socket.on('error', (err) => fail(classifyTlsError(err, withCert)));
    socket.on('close', () => fail(new WasherError('the washer closed the connection', 'offline')));
  }

  static open({ host, port = DRC_PORT, cert, key, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = tls.connect({ host, port, rejectUnauthorized: false, ...TLS_BASE, ...(cert && key ? { cert, key } : {}) });
      } catch (err) {
        reject(new WasherError(`unreadable certificate: ${err.message}`, 'tls'));
        return;
      }
      const timer = setTimeout(() => { socket.destroy(); reject(new WasherError('timed out', 'offline')); }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new DrcSession(socket, timeoutMs, !!(cert && key)));
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(classifyTlsError(err, !!(cert && key)));
      });
    });
  }

  _dispatch() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex(w.match);
      if (i === -1) continue;
      const [msg] = this.inbox.splice(i, 1);
      this.waiters.splice(this.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  }

  next(match, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.error) { reject(this.error); return; }
      const waiter = { match, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new WasherError('timed out', 'offline'));
      }, timeoutMs);
      this.waiters.push(waiter);
      this._dispatch();
    });
  }

  send(xml) {
    if (this.error) throw this.error;
    this.socket.write(`${XML_DECL}${xml}\r\n`);
  }

  // Sends a request and resolves with the <Response Type="…"> that answers it.
  // A failure carries no Type, only the CommandID when the request had one.
  async request(type, xml, commandId = null) {
    this.send(xml);
    return this.next((m) => m.tag === 'Response' && (m.attrs.Type === type
      || (!m.attrs.Type && (!commandId || !m.attrs.CommandID || m.attrs.CommandID === commandId))));
  }

  close() {
    this.socket.destroy();
  }
}

const isOkay = (msg) => /^ok(ay)?$/i.test(msg.attrs.Status || '');

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function present(value) {
  return value === undefined || value === '' || value === 'NULL' ? null : value;
}

function operationToState(value) {
  if (/^(run|running|start|on)$/i.test(value || '')) return 'Run';
  if (/pause/i.test(value || '')) return 'Pause';
  return value ? 'Ready' : null;
}

class DrcWasher {
  constructor({ host, port = DRC_PORT, cert, key, token, timeoutMs = 15000 }) {
    this.protocol = 'drc';
    this.host = host;
    this.port = port;
    this.cert = cert;
    this.key = key;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.duid = null;
    this._queue = Promise.resolve();
  }

  // One session at a time, as with the other protocol.
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  open() {
    return DrcSession.open({ host: this.host, port: this.port, cert: this.cert, key: this.key, timeoutMs: this.timeoutMs });
  }

  // Runs fn(session, duid) on an authenticated session.
  _withSession(fn) {
    return this._serial(async () => {
      if (!this.token) throw new WasherError('no token', 'auth');
      const session = await this.open();
      try {
        const auth = await session.request('AuthToken', `<Request Type="AuthToken"><User Token="${escapeXml(this.token)}" /></Request>`);
        if (!isOkay(auth)) {
          throw new WasherError(`token refused (${auth.attrs.Status || '?'}${auth.attrs.ErrorCode ? ` ${auth.attrs.ErrorCode}` : ''})`, 'auth', 401);
        }
        if (!this.duid) {
          const list = await session.request('DeviceList', '<Request Type="DeviceList" />');
          const device = list.devices.find((d) => d.DUID);
          if (!device) throw new WasherError('DeviceList returns no device');
          this.duid = device.DUID;
        }
        return await fn(session, this.duid);
      } finally {
        session.close();
      }
    });
  }

  async readAttributes() {
    return this._withSession(async (session, duid) => {
      const res = await session.request('DeviceState', `<Request Type="DeviceState" DUID="${escapeXml(duid)}"></Request>`);
      if (!isOkay(res)) throw new WasherError(`DeviceState → ${res.attrs.Status || '?'}`);
      return res.values;
    });
  }

  async readState() {
    const v = await this.readAttributes();
    // A delayed start shows as Start + "Delaywash": nothing is washing yet.
    const delayed = /delay/i.test(v.WM_FUN_PROGRESS || '');
    return {
      state: delayed ? 'Ready' : operationToState(v.WM_FUN_OPERATION),
      operation: present(v.WM_FUN_OPERATION),
      progress: present(v.WM_FUN_PROGRESS),
      progressPercentage: null,
      remainingMinutes: toInt(v.WM_FUN_OTLEFT),
      course: present(v.WM_FUN_COURSE),
      power: present(v.WM_FUN_POWER),
      kidsLock: present(v.WM_FUN_CHILD_LOCK),
      error: present(v.WM_FUN_ERROR),
      remoteControl: v.WM_FUN_SMARTCONTROL === undefined ? null : /^on$/i.test(v.WM_FUN_SMARTCONTROL),
      raw: { DUID: this.duid, ...v },
    };
  }

  async readRemoteControl() {
    return (await this.readState()).remoteControl;
  }

  async readOperationState() {
    return (await this.readState()).state;
  }

  async readInformation() {
    const v = await this.readAttributes();
    return { model: present(v.WM_FUN_MODEL_DESCRIPTION), deviceType: present(v.WM_FUN_DEVICE_TYPE), duid: this.duid };
  }

  // Run = start the programme selected on the panel (or resume); Pause; Ready = stop.
  async writeState(state) {
    const value = OPERATION_VALUES[state];
    if (!value) throw new WasherError(`unknown state: ${state}`);
    return this._withSession(async (session, duid) => {
      const before = await session.request('DeviceState', `<Request Type="DeviceState" DUID="${escapeXml(duid)}"></Request>`);
      if (/^off$/i.test(before.values.WM_FUN_SMARTCONTROL || '')) {
        throw new WasherError('Smart Control is off on the washer', 'control-disabled', 403);
      }
      const commandId = `cmd${Date.now() % 100000}`;
      const res = await session.request('DeviceControl',
        `<Request Type="DeviceControl"><Control CommandID="${commandId}" DUID="${escapeXml(duid)}">`
        + `<Attr ID="WM_FUN_OPERATION" Value="${value}" /></Control></Request>`, commandId);
      if (!isOkay(res)) {
        throw new WasherError(`the washer refuses ${value} (${res.attrs.Status || '?'}${res.attrs.ErrorCode ? ` ${res.attrs.ErrorCode}` : ''})`);
      }
    });
  }

  // The answer only means "accepted": read back to be sure.
  async setStateVerified(state, delayMs = 3000) {
    await this.writeState(state);
    await new Promise((r) => setTimeout(r, delayMs));
    const reported = await this.readOperationState();
    if (reported !== state) {
      throw new WasherError(`the washer ignored ${state} (it reports ${reported})`);
    }
    return reported;
  }

  // Asks for a token and waits for someone to press Smart Control (off, then on).
  // The request is sent again every windowMs until totalMs.
  pair({ totalMs = 180000, windowMs = TOKEN_WINDOW_MS, onEvent = () => {} } = {}) {
    return this._serial(async () => {
      const deadline = Date.now() + totalMs;
      let attempt = 0;
      let session = null;
      try {
        while (Date.now() < deadline) {
          if (!session) session = await this.open();
          attempt += 1;
          let res;
          try {
            res = await session.request('GetToken', '<Request Type="GetToken" />');
          } catch (err) {
            onEvent({ type: 'request-error', attempt, kind: err.kind, message: err.message });
            session.close();
            session = null;
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          onEvent({ type: 'request', attempt, status: res.attrs.Status || '?' });
          const wait = Math.max(0, Math.min(windowMs, deadline - Date.now()));
          try {
            const update = await session.next((m) => m.attrs.Type === 'GetToken' && m.tag === 'Update', wait);
            if (update.attrs.Token) return update.attrs.Token;
            onEvent({ type: 'update', attempt, status: update.attrs.Status || '?' });
          } catch (err) {
            if (err.kind === 'offline' && session.error) { session.close(); session = null; }
          }
        }
        throw new Error('no token received');
      } finally {
        if (session) session.close();
      }
    });
  }
}

module.exports = {
  DRC_PORT, TOKEN_WINDOW_MS, DrcWasher, DrcSession, takeMessages, parseMessage, operationToState,
};
