#!/usr/bin/env node
'use strict';

// samsung-washer <command> <washer-ip> [options]
//   cert                  downloads Samsung's public certificate (AC14K_M)
//   cert --leaf           also makes a derived certificate (needs openssl)
//   find                  looks for washers on the local network (ports 2878 and 8888)
//   test <ip>             checks that the washer answers (port 2878 or 8888)
//   pair <ip>             gets the token (Smart Control has to be pressed)
// Common option: --protocol drc|rest (otherwise detected: 2878 = drc, 8888 = rest)
//   status <ip>           shows the washer's state
//   start|pause|cancel <ip>

const os = require('node:os');
const { Washer, DEFAULT_PORT, rawRequest, localAddressTowards } = require('../lib/client');
const { DrcWasher, DrcSession, DRC_PORT } = require('../lib/drc');
const { tcpOpen, detectProtocol, createWasher } = require('../lib/connect');
const { pair } = require('../lib/pairing');
const store = require('../lib/store');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[name] = next; i += 1; } else args[name] = true;
    } else args._.push(a);
  }
  return args;
}

const say = (msg = '') => process.stdout.write(`${msg}\n`);
const fail = (msg) => { process.stderr.write(`\n✗ ${msg}\n`); process.exit(1); };

async function protocolFor(host, args) {
  if (args.protocol === 'drc' || args.protocol === 'rest') return args.protocol;
  const protocol = await detectProtocol(host);
  if (!protocol) {
    fail(`neither port ${DRC_PORT} nor port ${DEFAULT_PORT} answers on ${host}.\n`
      + '  Check the IP, that the washer is on, and that Smart Control is on.');
  }
  return protocol;
}

async function washerFor(host, args, dir, { needToken = true } = {}) {
  const identity = store.loadIdentity(dir, args.identity || 'auto');
  if (!identity) fail(`no certificate in ${dir} — run first: samsung-washer cert`);
  const token = args.token || store.loadToken(dir);
  if (needToken && !token) fail(`no token in ${dir} — run first: samsung-washer pair ${host}`);
  const protocol = await protocolFor(host, args);
  return createWasher({ protocol, host, port: Number(args.port) || undefined, cert: identity.cert, key: identity.key, token });
}

async function cmdCert(args, dir) {
  say(`Downloading Samsung's public certificate to ${dir} …`);
  const { certs } = await store.fetchCa(dir);
  say(`✓ certificate saved (${certs} certificates in the chain)`);
  if (args.leaf) {
    say('Making the derived certificate (openssl) …');
    const uuid = await store.mintLeaf(dir);
    say(`✓ derived certificate saved (UUID ${uuid})`);
  }
}

// Every /24 network of this computer, each address tried on both ports.
async function cmdFind() {
  const prefixes = [...new Set(Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address.split('.').slice(0, 3).join('.')))];
  if (!prefixes.length) fail('no IPv4 network found on this computer');
  say(`Looking for washers on ${prefixes.map((p) => `${p}.1-254`).join(', ')} (ports ${DRC_PORT} and ${DEFAULT_PORT}) …`);
  const found = [];
  await Promise.all(prefixes.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`)).map(async (ip) => {
    const [drc, rest] = await Promise.all([tcpOpen(ip, DRC_PORT, 1500), tcpOpen(ip, DEFAULT_PORT, 1500)]);
    if (drc) found.push({ ip, port: DRC_PORT });
    if (rest) found.push({ ip, port: DEFAULT_PORT });
  }));
  if (!found.length) {
    say('✗ nothing found. Is the washer on, with Smart Control on, and on the same network as this computer?');
    process.exit(1);
  }
  for (const { ip, port } of found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))) {
    say(`  ${ip.padEnd(15)} port ${port}  → check with: samsung-washer test ${ip}`);
  }
  say('Other devices (e.g. some smart speakers) may also use these ports: "test" tells which one is the washer.');
}

async function cmdTest(host, args, dir) {
  const protocol = args.protocol || (await tcpOpen(host, DRC_PORT) ? 'drc' : 'rest');
  if (protocol === 'drc') return cmdTestDrc(host, args, dir);
  const port = Number(args.port) || DEFAULT_PORT;
  say(`1) Port ${port} on ${host} …`);
  if (!(await tcpOpen(host, port))) {
    say('   ✗ closed or washer unreachable.');
    say('   → Check the IP, that the washer is on, and turn Smart Control on:');
    say('     without it, the washer leaves the Wi-Fi a few minutes after stopping.');
    process.exit(1);
  }
  say('   ✓ open');

  say('2) TLS handshake without a certificate …');
  try {
    const res = await rawRequest({ host, port, method: 'GET', path: '/devices' });
    say(`   ✓ the washer answers (${res.status}) ${/certificate/i.test(res.body) ? '— it requires a client certificate, as expected' : ''}`);
  } catch (err) {
    say(`   ✗ ${err.message}`);
  }

  const identity = store.loadIdentity(dir, args.identity || 'auto');
  if (!identity) {
    say(`3) Samsung certificate: missing — run "samsung-washer cert", then this test again.`);
    return;
  }
  say(`3) Request with the Samsung certificate (${identity.name}) …`);
  const washer = new Washer({ host, port, cert: identity.cert, key: identity.key, token: store.loadToken(dir) });
  try {
    const state = await washer.readState();
    say(`   ✓ full access: state ${state.state}, ${state.remainingMinutes ?? '?'} min left`);
  } catch (err) {
    if (err.kind === 'auth' && err.status === 401) {
      say('   ✓ the washer accepts the certificate and asks for a token (401): right protocol.');
      say(`   → Next step: samsung-washer pair ${host}`);
    } else if (err.kind === 'control-disabled') {
      say('   ✓ right protocol, but Smart Control is off on the washer.');
    } else {
      say(`   ✗ ${err.message}`);
    }
  }
}

// Same steps for the XML protocol on 2878 (2013-2015 appliances).
async function cmdTestDrc(host, args, dir) {
  const port = Number(args.port) || DRC_PORT;
  say(`1) Port ${port} on ${host} …`);
  if (!(await tcpOpen(host, port))) {
    say('   ✗ closed or washer unreachable.');
    process.exit(1);
  }
  say('   ✓ open (XML protocol of 2013-2015 Samsung appliances)');

  say('2) TLS handshake without a certificate …');
  try {
    (await DrcSession.open({ host, port, timeoutMs: 8000 })).close();
    say('   ? the washer accepts a connection without a certificate (unexpected)');
  } catch (err) {
    say(err.kind === 'auth' ? '   ✓ it requires a client certificate, as expected' : `   ✗ ${err.message}`);
  }

  const identity = store.loadIdentity(dir, args.identity || 'auto');
  if (!identity) {
    say('3) Samsung certificate: missing — run "samsung-washer cert", then this test again.');
    return;
  }
  say(`3) Connecting with the Samsung certificate (${identity.name}) …`);
  let session;
  try {
    session = await DrcSession.open({ host, port, cert: identity.cert, key: identity.key, timeoutMs: 8000 });
    const invalidate = await session.next((m) => m.attrs.Type === 'InvalidateAccount', 5000).catch(() => null);
    say(`   ✓ certificate accepted${session.greeting ? ` (${session.greeting})` : ''}${invalidate ? ', the washer asks for a token' : ''}`);
  } catch (err) {
    say(`   ✗ ${err.message}`);
    return;
  } finally {
    if (session) session.close();
  }

  const token = args.token || store.loadToken(dir);
  if (!token) {
    say(`   → Next step: samsung-washer pair ${host}`);
    return;
  }
  say('4) Authenticating with the saved token …');
  try {
    const state = await new DrcWasher({ host, port, cert: identity.cert, key: identity.key, token }).readState();
    say(`   ✓ full access: ${state.operation ?? '?'}, programme ${state.course ?? '?'}, ${state.remainingMinutes ?? '?'} min`);
  } catch (err) {
    say(`   ✗ ${err.message}${err.kind === 'auth' ? ` → run again: samsung-washer pair ${host}` : ''}`);
  }
}

async function cmdPairDrc(washer, host, args, dir) {
  const minutes = Number(args.minutes) || 3;
  say(`Pairing with ${host} (port ${washer.port}), for ${minutes} min.`);
  say('');
  say('  • Child lock off, door closed, Smart Control on.');
  say('  • As soon as "request sent" shows: press Smart Control briefly');
  say('    (it turns off), wait 2-3 s, then press it again (it turns back on).');
  say('  • NEVER hold it until "AP".');
  say('  • Nothing after 30 s? Try again at the next request.');
  say('');
  try {
    const token = await washer.pair({
      totalMs: minutes * 60000,
      onEvent: (e) => {
        if (e.type === 'request') say(`[${e.attempt}] request sent (${e.status}) → turn Smart Control off, then on again`);
        else if (e.type === 'request-error') say(`[${e.attempt}] request failed: ${e.message}`);
        else if (e.type === 'update') say(`    ↳ the washer answers: ${e.status}`);
      },
    });
    store.saveToken(dir, token);
    say('');
    say(`✓ Token received and saved in ${dir}/token`);
    say(`  Check with: samsung-washer status ${host}`);
  } catch (err) {
    fail(`No token received (${err.message}). Leads: child lock, Smart Control turned off then on\n`
      + '  while a request is pending, door properly closed.');
  }
}

async function cmdPair(host, args, dir) {
  const washer = await washerFor(host, args, dir, { needToken: false });
  if (washer.protocol === 'drc') return cmdPairDrc(washer, host, args, dir);
  const callbackIp = args['callback-ip'] || await localAddressTowards(host);
  const minutes = Number(args.minutes) || 4;
  const identity = store.loadIdentity(dir, args.identity || 'auto');
  say(`Pairing with ${host} — callback expected on ${callbackIp}:8889, for ${minutes} min.`);
  say('');
  say('  • Child lock off, door closed.');
  say('  • If Smart Control is already on, turn it off now.');
  say('  • As soon as "window open" shows: press Smart Control to turn it on.');
  say('    (short press; if nothing lights up, hold ~3 s — NEVER until "AP")');
  say('  • Nothing after a minute? Turn Smart Control off and on at the next window.');
  say('');
  try {
    const token = await pair({
      washer, cert: identity.cert, key: identity.key, callbackIp, totalMs: minutes * 60000,
      onEvent: (e) => {
        if (e.type === 'request') {
          if (e.status === 200) say(`[${e.attempt}] window open (~1 min) → press Smart Control`);
          else if (e.status === 403) say(`[${e.attempt}] a window is already open (403), waiting`);
          else say(`[${e.attempt}] unexpected answer: ${e.status}`);
        } else if (e.type === 'request-error') {
          say(`[${e.attempt}] request failed: ${e.message}`);
        } else if (e.type === 'connection') {
          say(`    ↳ incoming connection from ${e.remote}`);
        } else if (e.type === 'callback') {
          say(`    ↳ ${e.secure ? 'HTTPS' : 'HTTP'} callback: "${e.firstLine}"${e.hasToken ? ' — token received' : ''}`);
        } else if (e.type === 'callback-error') {
          say(`    ↳ callback interrupted: ${e.message}`);
        }
      },
    });
    store.saveToken(dir, token);
    say('');
    say(`✓ Token received and saved in ${dir}/token`);
    say(`  Check with: samsung-washer status ${host}`);
  } catch {
    fail('No token received. Leads: child lock, Smart Control pressed during an open window,\n'
      + '  firewall on port 8889, Homebridge in Docker without "network_mode: host",\n'
      + '  or try the derived certificate: samsung-washer cert --leaf, then pair again.');
  }
}

async function cmdStatus(host, args, dir) {
  const washer = await washerFor(host, args, dir);
  const s = await washer.readState();
  let remote = s.remoteControl ?? null;
  if (remote === null) {
    try { remote = await washer.readRemoteControl(); } catch { /* optional */ }
  }
  say(`State       : ${s.state}${s.operation && s.operation !== s.state ? ` (${s.operation})` : ''}`);
  if (s.course) say(`Programme   : ${s.course}`);
  say(`Phase       : ${s.progress ?? '?'} (${s.progressPercentage ?? '?'} %)`);
  say(`Remaining   : ${s.remainingMinutes ?? '?'} min`);
  say(`Smart Ctrl  : ${remote === null ? '?' : remote ? 'on' : 'off'}`);
  say(`Child lock  : ${s.kidsLock ?? '?'}`);
  if (args.raw) say(JSON.stringify(s.raw, null, 2));
}

async function cmdState(host, args, dir, state) {
  const washer = await washerFor(host, args, dir);
  if (state === 'Ready') {
    // Ready from Pause is ignored, and from Ready it resets the panel settings.
    const current = await washer.readOperationState();
    if (current !== 'Run') fail(`cancelling only works during a cycle (current state: ${current})`);
  }
  const reported = await washer.setStateVerified(state);
  say(`✓ the washer reports: ${reported}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, host] = args._;
  const dir = args.dir || store.defaultDir();
  const needHost = ['test', 'pair', 'status', 'start', 'pause', 'cancel'];
  if (!command || (needHost.includes(command) && !host)) {
    say('Usage: samsung-washer find');
    say('       samsung-washer cert [--leaf]');
    say('       samsung-washer test|pair|status|start|pause|cancel <washer-ip> [--protocol drc|rest]');
    say(`Folder: ${dir} (change it with --dir)`);
    process.exit(command ? 1 : 0);
  }
  try {
    if (command === 'find') await cmdFind();
    else if (command === 'cert') await cmdCert(args, dir);
    else if (command === 'test') await cmdTest(host, args, dir);
    else if (command === 'pair') await cmdPair(host, args, dir);
    else if (command === 'status') await cmdStatus(host, args, dir);
    else if (command === 'start') await cmdState(host, args, dir, 'Run');
    else if (command === 'pause') await cmdState(host, args, dir, 'Pause');
    else if (command === 'cancel') await cmdState(host, args, dir, 'Ready');
    else fail(`unknown command: ${command}`);
  } catch (err) {
    fail(err.kind === 'control-disabled'
      ? 'Smart Control is off: turn it on at the washer (door closed).'
      : err.message);
  }
}

main();
