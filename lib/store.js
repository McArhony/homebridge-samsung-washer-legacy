'use strict';

// Where the certificate and the token live, shared by the CLI and the plugin:
// <homebridge storage>/samsung-washer/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

// Samsung's AC14K_M CA certificate and key, publicly mirrored for years and used
// by every local-control project for these appliances. Not shipped here.
const BUNDLE_URL = 'https://raw.githubusercontent.com/brayStorm/samsung-appliance-token/main/cert.pem';
const UUID_HOST = 'connect-v2.samsungiotcloud.com';

const CA_CERT = 'ac14k_m.pem';
const CA_KEY = 'ac14k_m.key';
const LEAF_CERT = 'leaf_fullchain.pem';
const LEAF_KEY = 'leaf.key';
const TOKEN_FILE = 'token';

function defaultDir() {
  const roots = [process.env.UIX_STORAGE_PATH, '/var/lib/homebridge', '/homebridge', path.join(os.homedir(), '.homebridge')];
  for (const root of roots) {
    if (root && fs.existsSync(root)) return path.join(root, 'samsung-washer');
  }
  return path.join(os.homedir(), '.homebridge', 'samsung-washer');
}

function read(dir, name) {
  const file = path.join(dir, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function write(dir, name, content, mode = 0o600) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, { mode });
}

// identity: 'auto' (leaf if present, else CA), 'leaf' or 'ca'
function loadIdentity(dir, identity = 'auto') {
  const leaf = { cert: read(dir, LEAF_CERT), key: read(dir, LEAF_KEY), name: 'leaf' };
  const ca = { cert: read(dir, CA_CERT), key: read(dir, CA_KEY), name: 'ca' };
  const order = identity === 'leaf' ? [leaf] : identity === 'ca' ? [ca] : [leaf, ca];
  return order.find((id) => id.cert && id.key) || null;
}

function loadToken(dir) {
  const token = read(dir, TOKEN_FILE);
  return token ? token.trim() : null;
}

function saveToken(dir, token) {
  write(dir, TOKEN_FILE, `${token}\n`);
}

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed (${res.statusCode})`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function onTimeout() { this.destroy(new Error('timed out')); });
  });
}

function splitBundle(bundle) {
  const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----\n?/.exec(bundle);
  const certs = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/g) || [];
  if (!key || certs.length < 1) throw new Error('the downloaded file has no certificate and key');
  return { key: key[0], certs: certs.map((c) => (c.endsWith('\n') ? c : `${c}\n`)) };
}

async function fetchCa(dir) {
  const { key, certs } = splitBundle(await download(BUNDLE_URL));
  write(dir, CA_KEY, key);
  write(dir, CA_CERT, certs.join(''), 0o644);
  return { certs: certs.length };
}

// The UUID Samsung's own servers carry; newer firmware grants full access to it.
function fetchSamsungUuid() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: UUID_HOST, port: 443, servername: UUID_HOST, rejectUnauthorized: false }, () => {
      const subject = JSON.stringify(socket.getPeerCertificate().subject || {});
      socket.end();
      const match = /uuid:([0-9a-fA-F-]{36})/.exec(subject);
      if (match) resolve(match[1]); else reject(new Error(`pas d'UUID dans ${subject}`));
    });
    socket.setTimeout(20000, () => socket.destroy(new Error('timed out')));
    socket.on('error', reject);
  });
}

// Optional: a leaf certificate signed by AC14K_M for that UUID (needs openssl).
async function mintLeaf(dir) {
  const caCert = read(dir, CA_CERT);
  if (!caCert || !read(dir, CA_KEY)) throw new Error('run the "cert" command first');
  const uuid = await fetchSamsungUuid();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'samsung-washer-'));
  try {
    const firstCa = caCert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/)[0];
    fs.writeFileSync(path.join(work, 'ca.pem'), firstCa);
    fs.writeFileSync(path.join(work, 'ca.key'), read(dir, CA_KEY), { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'leaf.cnf'),
      'basicConstraints = CA:FALSE\n'
      + 'extendedKeyUsage = clientAuth, serverAuth, 1.3.6.1.4.1.51414.0.1.2\n'
      + `subjectAltName = URI:urn:uuid:${uuid}, DNS:${uuid}\n`
      + '1.3.6.1.4.1.51414.1.3 = ASN1:UTF8String:samsung.role.hub\n');
    const run = (...args) => execFileSync('openssl', args, { cwd: work, stdio: 'pipe' });
    run('genrsa', '-out', 'leaf.key', '2048');
    run('req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-sha1',
      '-subj', `/OU=uuid:${uuid}/CN=urn:uuid:${uuid}/O=Samsung Electronics/C=KR`);
    const sign = ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', 'leaf.pem', '-sha1', '-extfile', 'leaf.cnf'];
    try {
      // Same validity as Samsung's own certificates: survives a reset clock.
      run(...sign, '-not_before', '19600101000000Z', '-not_after', '20600101000000Z');
    } catch {
      run(...sign, '-days', '36500'); // openssl < 3.4
    }
    write(dir, LEAF_KEY, fs.readFileSync(path.join(work, 'leaf.key'), 'utf8'));
    write(dir, LEAF_CERT, fs.readFileSync(path.join(work, 'leaf.pem'), 'utf8') + caCert, 0o644);
    return uuid;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = {
  BUNDLE_URL, CA_CERT, CA_KEY, LEAF_CERT, LEAF_KEY, TOKEN_FILE,
  defaultDir, loadIdentity, loadToken, saveToken, fetchCa, mintLeaf, splitBundle,
};
