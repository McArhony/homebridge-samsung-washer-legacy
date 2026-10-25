'use strict';

// A stand-in for the XML protocol on 2878, built from what a real WW10H9400EW
// answered on 24/10/2026: client certificate required, "DRC-1.00" greeting,
// InvalidateAccount, GetToken → Ready → Completed after a Smart Control press,
// AuthToken, DeviceList, DeviceState, DeviceControl (Start/Pause/Stop accepted,
// anything else refused with a Type-less Fail, ErrorCode 210).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { takeMessages } = require('../lib/drc');

const DECL = '<?xml version="1.0" encoding="utf-8" ?>';

function makeCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-drc-'));
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha1', '-days', '3650',
    '-subj', '/CN=WM14K/O=Samsung Electronics', '-keyout', 'server.key', '-out', 'server.pem');
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha1', '-days', '3650',
    '-subj', '/CN=AC14K_M/O=Samsung Electronics', '-keyout', 'client.key', '-out', 'client.pem');
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const certs = { serverCert: read('server.pem'), serverKey: read('server.key'), clientCert: read('client.pem'), clientKey: read('client.key') };
  fs.rmSync(dir, { recursive: true, force: true });
  return certs;
}

class FakeDrcWasher {
  constructor({ token = '00000000-test-4000-8000-000000000000', smartControl = true, autoPressMs = null, ignoreControl = false } = {}) {
    this.certs = makeCerts();
    this.token = token;
    this.smartControl = smartControl;
    this.autoPressMs = autoPressMs;
    this.ignoreControl = ignoreControl; // accepts DeviceControl without applying it
    this.duid = 'A1B2C3000000000';
    this.operation = 'Stop';
    this.course = 'Cotton';
    this.left = 185;
    this.progress = 'NULL';
    this.waiting = null; // socket with a pending GetToken
    this.log = [];
  }

  start() {
    this.server = tls.createServer({
      cert: this.certs.serverCert, key: this.certs.serverKey, ca: this.certs.clientCert,
      minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0',
      requestCert: true, rejectUnauthorized: true,
    }, (socket) => this.handle(socket));
    this.server.on('tlsClientError', () => {});
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.port = this.server.address().port;
      resolve(this);
    }));
  }

  stop() {
    for (const s of this.server._sockets || []) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  attrs() {
    const a = {
      WM_FUN_POWER: 'On', WM_FUN_SMARTCONTROL: this.smartControl ? 'On' : 'Off', WM_FUN_OPERATION: this.operation,
      WM_FUN_PROGRESS: this.progress, WM_FUN_COURSE: this.course, WM_FUN_OTLEFT: String(this.left),
      WM_FUN_ERROR: 'Normal', WM_FUN_MODEL_DESCRIPTION: 'WW9000HE', WM_FUN_CHILD_LOCK: 'Disable',
    };
    return Object.entries(a).map(([id, v]) => `<Attr ID="${id}" Type="R" Value="${v}"/>`).join('');
  }

  handle(socket) {
    (this.server._sockets = this.server._sockets || new Set()).add(socket);
    socket.on('close', () => this.server._sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    // Greeting and first update arrive in separate, awkwardly cut chunks.
    socket.write('DRC-1.');
    setTimeout(() => socket.write(`00\r\n${DECL}<Update Type="Invalidate`), 5);
    setTimeout(() => socket.write('Account"/>\r\n'), 10);
    let authed = false;
    let buffer = '';
    const send = (xml) => socket.write(`${DECL}${xml}\r\n`);
    socket.on('data', (chunk) => {
      const { messages, rest } = takeMessages(buffer + chunk);
      buffer = rest;
      for (const m of messages) {
        const type = m.attrs.Type;
        this.log.push(type);
        if (type === 'GetToken') {
          send('<Response Type="GetToken" Status="Ready"/>');
          this.waiting = socket;
          if (this.autoPressMs != null) setTimeout(() => this.pressSmartControl(), this.autoPressMs);
        } else if (type === 'AuthToken') {
          const ok = /Token="([^"]+)"/.exec(m.xml)?.[1] === this.token;
          authed = ok;
          send(ok ? '<Response Type="AuthToken" Status="Okay" StartFrom="2026-06-15/02:27:39"/>' : '<Response Type="AuthToken" Status="Fail" ErrorCode="301"/>');
        } else if (!authed) {
          send(`<Response Type="${type}" Status="Fail" ErrorCode="401"/>`);
        } else if (type === 'DeviceList') {
          send(`<Response Type="DeviceList" Status="Okay"><DeviceList DeviceCount="1"><Device DUID="${this.duid}" GroupID="WM" ModelID="WM" /></DeviceList></Response>`);
        } else if (type === 'DeviceState') {
          // An unsolicited update first, as the air conditioners do.
          send(`<Update Type="Status"><Status DUID="${this.duid}"><Attr ID="WM_FUN_OTLEFT" Value="${this.left}"/></Status></Update>`);
          send(`<Response Type="DeviceState" Status="Okay"><DeviceState><Device DUID="${this.duid}" GroupID="WM" ModelID="WM" >${this.attrs()}</Device></DeviceState></Response>`);
        } else if (type === 'DeviceControl') {
          const wanted = /ID="WM_FUN_OPERATION" Value="([^"]+)"/.exec(m.xml)?.[1];
          const commandId = /CommandID="([^"]*)"/.exec(m.xml)?.[1] || '';
          if (!this.smartControl || !['Start', 'Pause', 'Stop'].includes(wanted)) {
            send(`<Response Status="Fail" ErrorCode="${this.smartControl ? 210 : 503}" DUID="${this.duid}" CommandID="${commandId}"/>`);
            continue;
          }
          if (!this.ignoreControl) {
            if (wanted === 'Start') { this.operation = 'Start'; this.progress = 'Wash'; }
            else if (wanted === 'Pause' && this.operation === 'Start') this.operation = 'Pause';
            else if (wanted === 'Stop' && this.operation !== 'Stop') { this.operation = 'Stop'; this.progress = 'NULL'; }
          }
          send(`<Response Type="DeviceControl" Status="Okay" DUID="${this.duid}" CommandID="${commandId}"/>`);
          send(`<Update Type="Status"><Status DUID="${this.duid}" GroupID="WM" ModelID="WM"><Attr ID="WM_FUN_OPERATION" Value="${this.operation}" /></Status></Update>`);
        } else {
          send(`<Response Type="${type}" Status="Fail" ErrorCode="400"/>`);
        }
      }
    });
  }

  // Smart Control off then on while a GetToken is pending.
  pressSmartControl() {
    if (!this.waiting) return;
    const socket = this.waiting;
    this.waiting = null;
    socket.write(`${DECL}<Update Type="GetToken" Status="Completed" Token="${this.token}"/>\r\n`);
  }
}

module.exports = { FakeDrcWasher };
