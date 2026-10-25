'use strict';

// A stand-in for the appliance, faithful to what the community documented:
// TLS 1.0 only, 1024-bit RSA key, client certificate required, a malformed
// "X-API-Version :" header, bearer token, SHE-001 when Smart Control is off,
// and the token delivered by calling back the address given in Host.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

function makeCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-washer-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  // Appliance: 1024-bit, SHA-1, like the real one.
  run('req', '-x509', '-newkey', 'rsa:1024', '-nodes', '-sha1', '-days', '3650',
    '-subj', '/CN=DA_SET/O=Samsung Electronics', '-keyout', 'server.key', '-out', 'server.pem');
  // Stand-in for the AC14K_M CA used as client identity.
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha1', '-days', '3650',
    '-subj', '/CN=AC14K_M/O=Samsung Electronics', '-keyout', 'client.key', '-out', 'client.pem');
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const certs = { serverCert: read('server.pem'), serverKey: read('server.key'), clientCert: read('client.pem'), clientKey: read('client.key') };
  fs.rmSync(dir, { recursive: true, force: true });
  return certs;
}

function reply(socket, status, body, extra = {}) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const reason = { 200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden' }[status] || 'X';
  const headers = {
    Server: 'nginx/1.2.7',
    'Content-Type': body && typeof body !== 'string' ? 'application/json' : 'text/html',
    'Content-Length': Buffer.byteLength(text),
    Connection: 'close',
    ...extra,
  };
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'X-API-Version : v1.0.0'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  socket.end(`${lines.join('\r\n')}\r\n\r\n${text}`);
}

function readRequest(socket, onRequest) {
  let data = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]);
    const text = data.toString('latin1');
    const split = text.indexOf('\r\n\r\n');
    if (split === -1) return;
    const lines = text.slice(0, split).split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const length = Number(headers['content-length'] || 0);
    if (data.length < split + 4 + length) return;
    const [method, url] = lines[0].split(' ');
    socket.removeAllListeners('data');
    onRequest({ method, url, headers, body: data.subarray(split + 4, split + 4 + length).toString('utf8') });
  });
}

class FakeWasher {
  constructor({ token = 'TOKEN-123', remoteControl = true, plainCallback = false, autoPressMs = null, callbackRequestsCert = false } = {}) {
    this.certs = makeCerts();
    this.token = token;
    this.remoteControl = remoteControl;
    this.plainCallback = plainCallback;
    this.autoPressMs = autoPressMs;
    this.state = 'Ready';
    this.remaining = '01:12:00';
    this.progress = 'None';
    this.pending = null;
    this.log = [];
    this.callbackRequestsCert = callbackRequestsCert;
  }

  start() {
    this.server = tls.createServer({
      cert: this.certs.serverCert, key: this.certs.serverKey,
      minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0',
      requestCert: true, rejectUnauthorized: false,
    }, (socket) => this.handle(socket));
    this.server.on('tlsClientError', () => {});
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      resolve(this);
    }));
  }

  stop() {
    clearTimeout(this.pendingTimer);
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  handle(socket) {
    socket.on('error', () => {});
    readRequest(socket, (req) => {
      this.log.push(`${req.method} ${req.url}`);
      this.lastRequest = { ...req, protocol: socket.getProtocol() };
      const peer = socket.getPeerCertificate();
      if (!peer || !Object.keys(peer).length) {
        return reply(socket, 400, '<html><center>No required SSL certificate was sent</center></html>');
      }
      if (req.method === 'POST' && req.url === '/devicetoken/request') {
        if (this.pending) return reply(socket, 403, { errorCode: '403', errorDescription: 'not able to be processed until previous request' });
        this.pending = { callback: req.headers.host };
        clearTimeout(this.pendingTimer);
        this.pendingTimer = setTimeout(() => { this.pending = null; }, 63000);
        this.pendingTimer.unref();
        if (this.autoPressMs != null) setTimeout(() => this.pressSmartControl(), this.autoPressMs);
        return reply(socket, 200, '');
      }
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        return reply(socket, 401, { errorCode: '401', errorDescription: 'Token is not valid' });
      }
      const she001 = () => reply(socket, 403, { errorCode: 'SHE-001', errorDescription: 'current function of WiFi is disabled, please enable the function for controlling' });
      const operation = () => ({ state: this.state, progress: this.progress, progressPercentage: '40', remainingTime: this.remaining, power: 'On', kidsLock: 'Off' });
      if (req.method === 'GET' && req.url === '/devices') {
        return reply(socket, 200, { Devices: [{ id: '0', Operation: operation(), Washer: { waterTemperature: '40', spinLevel: '1400' }, Mode: { options: ['Course_63'] } }] });
      }
      if (req.method === 'GET' && req.url === '/devices/0/operation') return reply(socket, 200, { Operation: operation() });
      if (req.method === 'GET' && req.url === '/devices/0/configuration') return reply(socket, 200, { Configuration: { remoteControlEnabled: this.remoteControl ? 'true' : 'false' } });
      if (req.method === 'PUT' && req.url === '/devices/0/operation') {
        if (!this.remoteControl) return she001();
        const wanted = JSON.parse(req.body).Operation.state;
        if (wanted === 'Run' || (wanted === 'Pause' && this.state === 'Run') || (wanted === 'Ready' && this.state === 'Run')) this.state = wanted;
        return reply(socket, 204);
      }
      return reply(socket, 400, { errorCode: '400', errorDescription: 'unknown resource' });
    });
  }

  // What happens when someone presses Smart Control during an open window.
  pressSmartControl() {
    if (!this.pending) return;
    const [host, port] = this.pending.callback.split(':');
    this.pending = null;
    clearTimeout(this.pendingTimer);
    const body = JSON.stringify({ DeviceToken: this.token });
    const request = `POST /devicetoken/response HTTP/1.1\r\nHost: ${host}:${port}\r\nX-API-Version : v1.0.0\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const socket = this.plainCallback
      ? net.connect({ host, port: Number(port) }, () => socket.write(request))
      : tls.connect({ host, port: Number(port), rejectUnauthorized: false, minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0', cert: this.certs.serverCert, key: this.certs.serverKey }, () => socket.write(request));
    socket.on('error', () => {});
    socket.on('data', () => socket.end());
  }

  finishCycleSoon() {
    this.remaining = '00:02:00';
  }
}

module.exports = { FakeWasher };
