'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DrcWasher, takeMessages, operationToState } = require('../lib/drc');
const { detectProtocol, createWasher } = require('../lib/connect');
const { FakeDrcWasher } = require('./fake-drc');

function washerFor(fake, token = fake.token) {
  return new DrcWasher({ host: '127.0.0.1', port: fake.port, cert: fake.certs.clientCert, key: fake.certs.clientKey, token, timeoutMs: 3000 });
}

test('takeMessages: greeting, self-closing and nested messages, cut anywhere', () => {
  const stream = 'DRC-1.00\r\n<?xml version="1.0" encoding="utf-8" ?><Update Type="InvalidateAccount"/>\r\n'
    + '<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceList" Status="Okay"><DeviceList DeviceCount="1"><Device DUID="ABC" GroupID="WM" /></DeviceList></Response>';
  for (let cut = 1; cut < stream.length; cut += 7) {
    const first = takeMessages(stream.slice(0, cut));
    const second = takeMessages(first.rest + stream.slice(cut));
    const messages = [...first.messages, ...second.messages];
    assert.deepStrictEqual(messages.map((m) => m.attrs.Type), ['InvalidateAccount', 'DeviceList'], `cut at ${cut}`);
    assert.deepStrictEqual([...first.greetings, ...second.greetings], ['DRC-1.00'], `cut at ${cut}`);
    assert.strictEqual(messages[1].devices[0].DUID, 'ABC');
  }
});

test('takeMessages reads Attr values the way the real washer sends them', () => {
  const xml = '<?xml version="1.0" encoding="utf-8" ?><Response Type="DeviceState" Status="Okay"><DeviceState><Device DUID="X" GroupID="WM" ModelID="WM" >'
    + '<Attr ID="WM_FUN_SETTIME" Type="W" Value=""/><Attr ID="WM_FUN_OPERATION" Type="RW" Value="Stop"/><Attr ID="WM_FUN_OTLEFT" Type="R" Value="185"/>'
    + '</Device></DeviceState></Response>';
  const [m] = takeMessages(xml).messages;
  assert.strictEqual(m.values.WM_FUN_OPERATION, 'Stop');
  assert.strictEqual(m.values.WM_FUN_OTLEFT, '185');
  assert.strictEqual(m.values.WM_FUN_SETTIME, '');
});

test('operationToState', () => {
  assert.strictEqual(operationToState('Run'), 'Run');
  assert.strictEqual(operationToState('Pause'), 'Pause');
  assert.strictEqual(operationToState('Stop'), 'Ready');
  assert.strictEqual(operationToState(undefined), null);
});

test('drc: reads the state with certificate and token', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    const state = await washerFor(fake).readState();
    assert.strictEqual(state.state, 'Ready');
    assert.strictEqual(state.operation, 'Stop');
    assert.strictEqual(state.course, 'Cotton');
    assert.strictEqual(state.remainingMinutes, 185);
    assert.strictEqual(state.progress, null);
    assert.strictEqual(state.remoteControl, true);
    assert.deepStrictEqual(fake.log, ['AuthToken', 'DeviceList', 'DeviceState']);
  } finally { await fake.stop(); }
});

test('drc: a delayed start is not shown as running', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    fake.operation = 'Start';
    fake.progress = 'Delaywash';
    const state = await washerFor(fake).readState();
    assert.strictEqual(state.state, 'Ready');
    assert.strictEqual(state.operation, 'Start');
    assert.strictEqual(state.progress, 'Delaywash');
  } finally { await fake.stop(); }
});

test('drc: no client certificate → auth error', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    const washer = new DrcWasher({ host: '127.0.0.1', port: fake.port, token: fake.token, timeoutMs: 3000 });
    await assert.rejects(washer.readState(), (err) => err.kind === 'auth' && /certificate/.test(err.message));
  } finally { await fake.stop(); }
});

test('drc: wrong token → auth error', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    await assert.rejects(washerFor(fake, 'nope').readState(), (err) => err.kind === 'auth' && /token refused/.test(err.message));
  } finally { await fake.stop(); }
});

test('drc: start, pause, stop, verified by reading back', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    const washer = washerFor(fake);
    assert.strictEqual(await washer.setStateVerified('Run', 10), 'Run');
    assert.strictEqual(fake.operation, 'Start');
    assert.strictEqual((await washer.readState()).progress, 'Wash');
    assert.strictEqual(await washer.setStateVerified('Pause', 10), 'Pause');
    assert.strictEqual(await washer.setStateVerified('Run', 10), 'Run');
    assert.strictEqual(await washer.setStateVerified('Ready', 10), 'Ready');
    assert.strictEqual(fake.operation, 'Stop');
  } finally { await fake.stop(); }
});

test('drc: command accepted but not applied → error after reading back', async () => {
  const fake = await new FakeDrcWasher({ ignoreControl: true }).start();
  try {
    await assert.rejects(washerFor(fake).setStateVerified('Run', 10), /ignored/);
  } finally { await fake.stop(); }
});

test('drc: a Type-less Fail answer is reported at once, not as a timeout', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    const washer = washerFor(fake);
    const session = await washer.open();
    try {
      await session.request('AuthToken', `<Request Type="AuthToken"><User Token="${fake.token}" /></Request>`);
      const t = Date.now();
      const res = await session.request('DeviceControl',
        `<Request Type="DeviceControl"><Control CommandID="cmd1" DUID="${fake.duid}"><Attr ID="WM_FUN_OPERATION" Value="Run" /></Control></Request>`, 'cmd1');
      assert.strictEqual(res.attrs.Status, 'Fail');
      assert.strictEqual(res.attrs.Type, undefined);
      assert.strictEqual(res.attrs.ErrorCode, '210');
      assert.ok(Date.now() - t < 1000);
    } finally { session.close(); }
  } finally { await fake.stop(); }
});

test('drc: Smart Control off → control-disabled, nothing sent', async () => {
  const fake = await new FakeDrcWasher({ smartControl: false }).start();
  try {
    await assert.rejects(washerFor(fake).writeState('Run'), (err) => err.kind === 'control-disabled');
    assert.ok(!fake.log.includes('DeviceControl'));
  } finally { await fake.stop(); }
});

test('drc: pairing returns the token sent after the Smart Control press', async () => {
  const fake = await new FakeDrcWasher({ autoPressMs: 200 }).start();
  try {
    const events = [];
    const token = await washerFor(fake, null).pair({ totalMs: 5000, onEvent: (e) => events.push(e) });
    assert.strictEqual(token, fake.token);
    assert.ok(events.some((e) => e.type === 'request' && e.status === 'Ready'));
  } finally { await fake.stop(); }
});

test('drc: pairing asks again when nobody presses, then a later press works', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    const events = [];
    const promise = washerFor(fake, null).pair({ totalMs: 5000, windowMs: 300, onEvent: (e) => events.push(e) });
    setTimeout(() => fake.pressSmartControl(), 800);
    assert.strictEqual(await promise, fake.token);
    assert.ok(events.filter((e) => e.type === 'request').length >= 2);
  } finally { await fake.stop(); }
});

test('drc: pairing gives up after totalMs', async () => {
  const fake = await new FakeDrcWasher().start();
  try {
    await assert.rejects(washerFor(fake, null).pair({ totalMs: 400, windowMs: 150 }), /no token/);
  } finally { await fake.stop(); }
});

test('detectProtocol: closed ports → null; createWasher picks the client', async () => {
  assert.strictEqual(createWasher({ protocol: 'drc', host: 'h' }).port, 2878);
  assert.strictEqual(createWasher({ protocol: 'rest', host: 'h' }).port, 8888);
  assert.strictEqual(await detectProtocol('127.0.0.1', 500), null);
});
