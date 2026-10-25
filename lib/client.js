'use strict';

// Client for the local REST API that Samsung Wi-Fi washers of the 2016-2018
// generation expose on TCP 8888 ("Smart Control" models). Older ones (2014)
// speak XML on TCP 2878 instead: see drc.js.
//
// What makes it awkward, and why there is no HTTP library here:
// - the appliance speaks TLS 1.0 only, with a 1024-bit key, so the TLS context
//   has to be relaxed well below today's defaults (SECLEVEL=0);
// - it wants a client certificate signed by Samsung's AC14K_M CA;
// - it sends a malformed header ("X-API-Version : v1.0.0") that strict HTTP
//   parsers reject, so responses are parsed by hand.
// Protocol learned from github.com/perseus177/ha-samsung-washer-local and
// github.com/johnnyvontruant/HASS-Samsung-Dongle-Local.

const tls = require('node:tls');
const dgram = require('node:dgram');

const DEFAULT_PORT = 8888;
const CALLBACK_PORT = 8889;
const TLS_BASE = {
  minVersion: 'TLSv1',
  ciphers: 'DEFAULT:@SECLEVEL=0',
};

class WasherError extends Error {
  // kind: offline | auth | control-disabled | tls | error
  constructor(message, kind = 'error', status = undefined) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const OFFLINE_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET',
  'EHOSTDOWN', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
]);

function classifySocketError(err) {
  if (err instanceof WasherError) return err;
  if (OFFLINE_CODES.has(err.code)) {
    return new WasherError(`washer unreachable (${err.code})`, 'offline');
  }
  return new WasherError(`TLS failure: ${err.message}`, 'tls');
}

// Parse a raw HTTP/1.x response, tolerating malformed header lines.
function parseResponse(buffer) {
  const text = buffer.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  const lines = head.split(/\r?\n/);
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] || '');
  if (!match) throw new WasherError(`unreadable response: ${JSON.stringify(lines[0])}`);
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  // latin1 maps one byte to one character, so string offsets are byte offsets.
  let body = split === -1 ? Buffer.alloc(0) : buffer.subarray(split + 4);
  const length = Number.parseInt(headers['content-length'], 10);
  if (Number.isFinite(length)) body = body.subarray(0, length);
  return { status: Number(match[1]), headers, body: body.toString('utf8') };
}

function responseComplete(buffer) {
  const text = buffer.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  if (split === -1) return false;
  const m = /\r\ncontent-length\s*:\s*(\d+)/i.exec(text.slice(0, split));
  if (!m) return false;
  return buffer.length >= split + 4 + Number(m[1]);
}

// One request over a fresh TLS connection.
function rawRequest({ host, port = DEFAULT_PORT, cert, key, method, path, headers = {}, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const lines = [`${method} ${path} HTTP/1.1`];
    const all = { Host: `${host}:${port}`, Accept: '*/*', Connection: 'close', ...headers };
    if (payload) {
      all['Content-Length'] = String(payload.length);
    }
    for (const [name, value] of Object.entries(all)) lines.push(`${name}: ${value}`);
    const request = Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'), payload || Buffer.alloc(0)]);

    let settled = false;
    const chunks = [];
    const options = { host, port, rejectUnauthorized: false, ...TLS_BASE };
    if (cert && key) Object.assign(options, { cert, key });
    let socket;
    try {
      socket = tls.connect(options, () => socket.write(request));
    } catch (err) {
      // e.g. an unreadable certificate file
      reject(new WasherError(`unreadable certificate: ${err.message}`, 'tls'));
      return;
    }

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(value);
    };
    const tryResolve = () => {
      const data = Buffer.concat(chunks);
      if (!data.length) return finish(new WasherError('the washer closed the connection without answering', 'offline'));
      try { finish(null, parseResponse(data)); } catch (e) { finish(e); }
    };

    socket.setTimeout(timeoutMs, () => finish(new WasherError('timed out', 'offline')));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (responseComplete(Buffer.concat(chunks))) tryResolve();
    });
    socket.on('end', tryResolve);
    socket.on('close', () => { if (!settled) tryResolve(); });
    socket.on('error', (err) => {
      // A reply may already be in hand when the appliance resets the socket.
      if (chunks.length) return tryResolve();
      finish(classifySocketError(err));
    });
  });
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// "HH:MM:SS" or "HH:MM" -> minutes
function parseMinutes(value) {
  if (typeof value !== 'string' || !value) return null;
  const parts = value.split(':').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + (parts[2] >= 30 ? 1 : 0);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function truthy(value) {
  if (value === true) return true;
  if (typeof value === 'string') return /^(true|on|enable|enabled|1)$/i.test(value.trim());
  return value === 1;
}

class Washer {
  constructor({ host, port = DEFAULT_PORT, cert, key, token, timeoutMs = 15000 }) {
    this.protocol = 'rest';
    this.host = host;
    this.port = port;
    this.cert = cert;
    this.key = key;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this._queue = Promise.resolve();
  }

  // The appliance handles one session at a time: serialise every request.
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async request(method, path, payload, { auth = true, headers = {} } = {}) {
    const extra = { ...headers };
    if (auth && this.token) extra.Authorization = `Bearer ${this.token}`;
    let body;
    if (payload !== undefined) {
      extra['Content-Type'] = 'application/json';
      body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    }
    const res = await this._serial(() => rawRequest({
      host: this.host, port: this.port, cert: this.cert, key: this.key,
      method, path, headers: extra, body, timeoutMs: this.timeoutMs,
    }));
    const data = parseJson(res.body);
    const description = data && typeof data === 'object' ? String(data.errorDescription || '') : '';

    if (res.status === 400 && typeof data === 'string' && /certificate/i.test(data)) {
      throw new WasherError('client certificate refused by the washer', 'auth', 400);
    }
    if (res.status === 401 || (res.status === 400 && /token/i.test(description))) {
      throw new WasherError(description || 'token refused (401)', 'auth', res.status);
    }
    if (res.status === 403 && data && typeof data === 'object'
        && (data.errorCode === 'SHE-001' || /wifi is disabled/i.test(description))) {
      throw new WasherError('Smart Control is off on the washer', 'control-disabled', 403);
    }
    if (res.status >= 500) {
      throw new WasherError(`the washer is not ready (${res.status} ${description})`, 'offline', res.status);
    }
    return { status: res.status, data };
  }

  async get(path) {
    const { status, data } = await this.request('GET', path);
    if (status !== 200 || !data || typeof data !== 'object') {
      throw new WasherError(`GET ${path} → ${status} ${JSON.stringify(data)}`, 'error', status);
    }
    return data;
  }

  async readState() {
    const devices = (await this.get('/devices')).Devices || [];
    if (!devices.length) throw new WasherError('/devices returns no device');
    const device = devices[0];
    const op = device.Operation || {};
    const pct = Number.parseInt(op.progressPercentage, 10);
    return {
      state: op.state || null,
      progress: typeof op.progress === 'string' ? op.progress : null,
      progressPercentage: Number.isNaN(pct) ? null : pct,
      remainingMinutes: parseMinutes(op.remainingTime),
      power: op.power || null,
      kidsLock: op.kidsLock || null,
      raw: device,
    };
  }

  async readRemoteControl() {
    const data = await this.get('/devices/0/configuration');
    const value = (data.Configuration || {}).remoteControlEnabled;
    return value === undefined ? null : truthy(value);
  }

  async readOperationState() {
    return ((await this.get('/devices/0/operation')).Operation || {}).state || null;
  }

  async readInformation() {
    return (await this.get('/devices/0/information')).Information || {};
  }

  // Run = start the programme selected on the panel (or resume); Pause; Ready = cancel.
  async writeState(state) {
    const { status, data } = await this.request('PUT', '/devices/0/operation', { Operation: { state } });
    if (status !== 200 && status !== 204) {
      throw new WasherError(`the washer refuses state=${state} (${status} ${JSON.stringify(data)})`, 'error', status);
    }
  }

  // A 204 means "accepted", not "applied": read back to be sure.
  async setStateVerified(state, delayMs = 3000) {
    await this.writeState(state);
    await new Promise((r) => setTimeout(r, delayMs));
    const reported = await this.readOperationState();
    if (reported !== state) {
      throw new WasherError(`the washer ignored state=${state} (it reports ${reported})`);
    }
    return reported;
  }

  // Opens a ~63 s pairing window. The appliance calls back the address given
  // in the Host header (not the source address) once Smart Control is pressed.
  async requestToken(callback, body = '') {
    const { status } = await this.request('POST', '/devicetoken/request', body, {
      auth: false,
      headers: { Host: callback, DeviceToken: 'xxxxxxxxxxx' },
    });
    return status;
  }
}

// Local IPv4 address the OS would use to reach `host` (no packet is sent).
function localAddressTowards(host) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', (err) => { socket.close(); reject(err); });
    socket.connect(9, host, () => {
      const { address } = socket.address();
      socket.close();
      resolve(address);
    });
  });
}

module.exports = {
  DEFAULT_PORT, CALLBACK_PORT, TLS_BASE, Washer, WasherError, classifySocketError,
  rawRequest, parseResponse, parseMinutes, localAddressTowards,
};
