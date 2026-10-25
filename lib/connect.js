'use strict';

// Picks the protocol the appliance speaks:
// - "drc"  : XML on TCP 2878 (2013-2015, e.g. WW10H9400EW);
// - "rest" : JSON on TCP 8888 (2016-2018).
// Both clients expose the same methods (readState, writeState, setStateVerified…).

const net = require('node:net');
const { Washer, DEFAULT_PORT, WasherError } = require('./client');
const { DrcWasher, DRC_PORT } = require('./drc');

const PORTS = { drc: DRC_PORT, rest: DEFAULT_PORT };

function tcpOpen(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

// 'drc' | 'rest', or null when neither port answers (machine off the network).
async function detectProtocol(host, timeoutMs = 5000) {
  const [drc, rest] = await Promise.all([tcpOpen(host, DRC_PORT, timeoutMs), tcpOpen(host, DEFAULT_PORT, timeoutMs)]);
  if (drc) return 'drc';
  if (rest) return 'rest';
  return null;
}

function createWasher({ protocol, host, port, cert, key, token }) {
  if (protocol === 'drc') return new DrcWasher({ host, port: port || DRC_PORT, cert, key, token });
  if (protocol === 'rest') return new Washer({ host, port: port || DEFAULT_PORT, cert, key, token });
  throw new WasherError(`protocole inconnu : ${protocol}`);
}

module.exports = { PORTS, tcpOpen, detectProtocol, createWasher };
