'use strict';

// Pairing = obtaining the device token.
// 1. We listen on 8889.
// 2. We POST /devicetoken/request with "Host: <our ip>:8889".
// 3. Someone presses Smart Control on the machine while the window (~63 s) is open.
// 4. The machine connects back to us and posts {"DeviceToken": "..."}.
// The callback is HTTPS on the models documented so far; plain HTTP is accepted
// too, in case this older generation does it differently.

const net = require('node:net');
const tls = require('node:tls');
const { Duplex } = require('node:stream');
const { CALLBACK_PORT, TLS_BASE } = require('./client');

const TOKEN_RE = /"DeviceToken"\s*:\s*"([^"]+)"/;
const PAIR_WINDOW_MS = 63000;

// A Duplex over a net.Socket whose first chunk was already consumed, so the
// TLS layer can be handed the whole byte stream.
function replayable(socket, first) {
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
    destroy(err, cb) { socket.destroy(); cb(err); },
  });
  duplex.push(first);
  socket.on('data', (chunk) => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on('end', () => duplex.push(null));
  socket.on('error', (err) => duplex.destroy(err));
  return duplex;
}

function serveCallback(stream, { secure, remote, onToken, onEvent }) {
  let data = Buffer.alloc(0);
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    const text = data.toString('utf8');
    const match = TOKEN_RE.exec(text);
    onEvent({ type: 'callback', remote, secure, firstLine: text.split(/\r?\n/)[0] || '', hasToken: !!match });
    if (match) onToken(match[1]);
    try {
      stream.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    } catch { /* ignore */ }
  };
  const timer = setTimeout(answer, 10000);
  stream.on('data', (chunk) => {
    data = Buffer.concat([data, chunk]).subarray(0, 65536);
    if (TOKEN_RE.test(data.toString('utf8'))) { clearTimeout(timer); answer(); }
  });
  stream.on('end', () => { clearTimeout(timer); answer(); });
  stream.on('error', (err) => {
    clearTimeout(timer);
    onEvent({ type: 'callback-error', remote, secure, message: err.message });
  });
}

function startCallbackServer({ cert, key, port = CALLBACK_PORT, onToken, onEvent = () => {} }) {
  const secureContext = tls.createSecureContext({ cert, key, ...TLS_BASE });
  const server = net.createServer((socket) => {
    const remote = socket.remoteAddress;
    onEvent({ type: 'connection', remote });
    socket.once('data', (first) => {
      socket.pause();
      if (first[0] === 0x16) {
        const secure = new tls.TLSSocket(replayable(socket, first), {
          isServer: true, secureContext, requestCert: false,
        });
        secure.on('error', (err) => onEvent({ type: 'callback-error', remote, secure: true, message: err.message }));
        serveCallback(secure, { secure: true, remote, onToken, onEvent });
      } else {
        serveCallback(socket, { secure: false, remote, onToken, onEvent });
        socket.emit('data', first);
        socket.resume();
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// Returns the token, or throws after totalMs.
async function pair({ washer, cert, key, callbackIp, callbackPort = CALLBACK_PORT, totalMs = 240000, windowMs = PAIR_WINDOW_MS, onEvent = () => {} }) {
  let resolveToken;
  const tokenPromise = new Promise((r) => { resolveToken = r; });
  const server = await startCallbackServer({ cert, key, port: callbackPort, onToken: resolveToken, onEvent });
  const deadline = Date.now() + totalMs;
  const bodies = ['', '{}']; // both shapes are seen in the wild
  let attempt = 0;
  try {
    while (Date.now() < deadline) {
      const body = bodies[attempt % bodies.length];
      attempt += 1;
      try {
        const status = await washer.requestToken(`${callbackIp}:${callbackPort}`, body);
        onEvent({ type: 'request', attempt, status });
      } catch (err) {
        onEvent({ type: 'request-error', attempt, kind: err.kind, message: err.message });
      }
      const wait = Math.max(0, Math.min(windowMs, deadline - Date.now()));
      let timer;
      const token = await Promise.race([
        tokenPromise,
        new Promise((r) => { timer = setTimeout(() => r(null), wait); }),
      ]);
      clearTimeout(timer);
      if (token) return token;
    }
    throw new Error('no token received');
  } finally {
    server.close();
  }
}

module.exports = { pair, startCallbackServer, TOKEN_RE, PAIR_WINDOW_MS };
