'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { Washer, parseResponse, parseMinutes } = require('../lib/client');
const { pair } = require('../lib/pairing');
const { splitBundle } = require('../lib/store');
const { FakeWasher } = require('./fake-washer');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function washerFor(fake, token = fake.token) {
  return new Washer({ host: '127.0.0.1', port: fake.port, cert: fake.certs.clientCert, key: fake.certs.clientKey, token });
}

test('parseResponse tolerates the malformed "X-API-Version :" header', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nX-API-Version : v1.0.0\r\nContent-Length: 2\r\n\r\n{}extra');
  const res = parseResponse(raw);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['x-api-version'], 'v1.0.0');
  assert.strictEqual(res.body, '{}');
});

test('parseMinutes', () => {
  assert.strictEqual(parseMinutes('01:12:00'), 72);
  assert.strictEqual(parseMinutes('00:00:40'), 1);
  assert.strictEqual(parseMinutes('0:45'), 45);
  assert.strictEqual(parseMinutes(''), null);
});

test('splitBundle separates key and certificates', () => {
  const bundle = '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n'
    + '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nC\n-----END CERTIFICATE-----';
  const { key, certs } = splitBundle(bundle);
  assert.match(key, /AAA/);
  assert.strictEqual(certs.length, 2);
  assert.ok(certs.every((c) => c.endsWith('\n')));
});

test('talks TLS 1.0 to the appliance and reads its state', async () => {
  const fake = await new FakeWasher().start();
  try {
    const state = await washerFor(fake).readState();
    assert.strictEqual(state.state, 'Ready');
    assert.strictEqual(state.remainingMinutes, 72);
    assert.strictEqual(fake.lastRequest.protocol, 'TLSv1');
    assert.strictEqual(await washerFor(fake).readRemoteControl(), true);
  } finally { await fake.stop(); }
});

test('no client certificate → auth error naming the certificate', async () => {
  const fake = await new FakeWasher().start();
  try {
    const washer = new Washer({ host: '127.0.0.1', port: fake.port, token: fake.token });
    await assert.rejects(washer.readState(), (err) => err.kind === 'auth' && /certificate/.test(err.message));
  } finally { await fake.stop(); }
});

test('wrong token → auth error 401', async () => {
  const fake = await new FakeWasher().start();
  try {
    await assert.rejects(washerFor(fake, 'nope').readState(), (err) => err.kind === 'auth' && err.status === 401);
  } finally { await fake.stop(); }
});

test('start, pause, verified by reading back', async () => {
  const fake = await new FakeWasher().start();
  try {
    const washer = washerFor(fake);
    assert.strictEqual(await washer.setStateVerified('Run', 10), 'Run');
    assert.strictEqual(fake.state, 'Run');
    assert.strictEqual(await washer.setStateVerified('Pause', 10), 'Pause');
  } finally { await fake.stop(); }
});

test('Smart Control off → control-disabled', async () => {
  const fake = await new FakeWasher({ remoteControl: false }).start();
  try {
    await assert.rejects(washerFor(fake).writeState('Run'), (err) => err.kind === 'control-disabled');
    assert.strictEqual(fake.state, 'Ready');
  } finally { await fake.stop(); }
});

test('unreachable appliance → offline', async () => {
  const port = await freePort();
  const washer = new Washer({ host: '127.0.0.1', port, token: 't' });
  await assert.rejects(washer.readState(), (err) => err.kind === 'offline');
});

test('unreadable certificate → tls error, not a crash', async () => {
  const washer = new Washer({ host: '127.0.0.1', port: await freePort(), cert: 'x', key: 'y', token: 't' });
  await assert.rejects(washer.readState(), (err) => err.kind === 'tls');
});

for (const plainCallback of [false, true]) {
  test(`pairing: token delivered by ${plainCallback ? 'HTTP' : 'HTTPS'} callback after Smart Control press`, async () => {
    const fake = await new FakeWasher({ plainCallback, autoPressMs: 300 }).start();
    try {
      const events = [];
      const token = await pair({
        washer: washerFor(fake, null), cert: fake.certs.clientCert, key: fake.certs.clientKey,
        callbackIp: '127.0.0.1', callbackPort: await freePort(), totalMs: 10000, onEvent: (e) => events.push(e),
      });
      assert.strictEqual(token, 'TOKEN-123');
      assert.ok(events.some((e) => e.type === 'request' && e.status === 200));
      assert.ok(events.some((e) => e.type === 'callback' && e.secure === !plainCallback && e.hasToken));
    } finally { await fake.stop(); }
  });
}

test('pairing: nobody presses the button → gives up, then a later press works', async () => {
  const fake = await new FakeWasher().start();
  try {
    const callbackPort = await freePort();
    const base = { washer: washerFor(fake, null), cert: fake.certs.clientCert, key: fake.certs.clientKey, callbackIp: '127.0.0.1', callbackPort };
    await assert.rejects(pair({ ...base, totalMs: 500, windowMs: 200 }), /no token/);
    // A window is still pending on the appliance: the next request gets 403 until it expires.
    fake.pending = null;
    const events = [];
    const promise = pair({ ...base, totalMs: 5000, windowMs: 2000, onEvent: (e) => events.push(e) });
    setTimeout(() => fake.pressSmartControl(), 400);
    assert.strictEqual(await promise, 'TOKEN-123');
  } finally { await fake.stop(); }
});
