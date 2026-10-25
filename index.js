'use strict';

// Homebridge accessory: a Samsung "Smart Control" washer (2014-2018 generation,
// XML protocol on 2878 or JSON on 8888, detected automatically)
// shown in Apple Home as
// - a valve: on = start the programme selected on the panel (or resume),
//   off = pause; shows the remaining time;
// - a "finished" contact sensor that opens when a cycle ends, so the
//   Home app can send a notification.

const path = require('node:path');
const { detectProtocol, createWasher } = require('./lib/connect');
const store = require('./lib/store');
const { version } = require('./package.json');

const PLUGIN_NAME = 'homebridge-samsung-washer-legacy';
const ACCESSORY_NAME = 'SamsungWasherLegacy';
const END_THRESHOLD_MIN = 5;

class WasherAccessory {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    const { Service, Characteristic } = api.hap;
    this.C = Characteristic;

    this.name = this.config.name || 'Washer';
    this.host = this.config.host;
    this.dir = this.config.dataDir || path.join(api.user.storagePath(), 'samsung-washer');
    this.pollMs = Math.max(10, Number(this.config.pollSeconds) || 30) * 1000;
    this.offAction = this.config.offAction === 'cancel' ? 'cancel' : 'pause';
    this.resetMs = Math.max(1, Number(this.config.finishedResetMinutes) || 60) * 60000;
    this.protocol = ['drc', 'rest'].includes(this.config.protocol) ? this.config.protocol : null; // null = auto

    this.washer = null;
    this.current = { reachable: false, state: null, remainingMinutes: null, progress: null };
    this.wasRunning = false;
    this.lastRunRemaining = null;
    this.finishedAt = null;
    this.lastLogged = null;
    this.warned = new Set();

    this.info = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(Characteristic.Model, this.config.model || 'WW10H9400EW')
      .setCharacteristic(Characteristic.SerialNumber, this.host || 'inconnu')
      .setCharacteristic(Characteristic.FirmwareRevision, version);

    this.valve = new Service.Valve(this.name);
    this.valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.GENERIC_VALVE);
    this.valve.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.isRunning() ? 1 : 0))
      .onSet((value) => this.setActive(value));
    this.valve.getCharacteristic(Characteristic.InUse)
      .onGet(() => (this.isRunning() ? 1 : 0));
    this.valve.getCharacteristic(Characteristic.RemainingDuration)
      .setProps({ maxValue: 6 * 3600 })
      .onGet(() => this.remainingSeconds());

    if (this.config.finishedSensor !== false) {
      this.contact = new Service.ContactSensor(`${this.name} finished`, 'finished');
      this.contact.getCharacteristic(Characteristic.ContactSensorState)
        .onGet(() => this.contactState());
    }

    if (!this.host) {
      this.log.error('Missing "host" setting: enter the washer\'s IP address.');
      return;
    }
    api.on('didFinishLaunching', () => {
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollMs);
    });
    api.on('shutdown', () => clearInterval(this.timer));
  }

  getServices() {
    return [this.info, this.valve, this.contact].filter(Boolean);
  }

  isRunning() {
    return this.current.reachable && this.current.state === 'Run';
  }

  remainingSeconds() {
    if (!this.isRunning() || this.current.remainingMinutes == null) return 0;
    return Math.min(6 * 3600, this.current.remainingMinutes * 60);
  }

  contactState() {
    const finished = this.finishedAt && Date.now() - this.finishedAt < this.resetMs;
    return finished
      ? this.C.ContactSensorState.CONTACT_NOT_DETECTED
      : this.C.ContactSensorState.CONTACT_DETECTED;
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(message);
  }

  // Loaded lazily, so pairing can happen while Homebridge is running.
  async client() {
    if (this.washer) return this.washer;
    let identity;
    let token;
    try {
      identity = store.loadIdentity(this.dir, this.config.identity || 'auto');
      token = this.config.token || store.loadToken(this.dir);
    } catch (err) {
      // Typically files written by another user than the one running Homebridge.
      this.warnOnce('read', `Lecture impossible dans ${this.dir} : ${err.message}`);
      return null;
    }
    if (!identity) {
      this.warnOnce('cert', `No certificate in ${this.dir}. In the Homebridge terminal: samsung-washer cert`);
      return null;
    }
    if (!token) {
      this.warnOnce('token', `No token. In the Homebridge terminal: samsung-washer pair ${this.host}`);
      return null;
    }
    if (!this.protocol) {
      // Retried at each poll while the machine is off the network.
      this.protocol = await detectProtocol(this.host);
      if (!this.protocol) return null;
      this.log.info(`Protocol detected: ${this.protocol === 'drc' ? 'XML, port 2878' : 'JSON, port 8888'}`);
    }
    this.washer = createWasher({
      protocol: this.protocol, host: this.host, port: Number(this.config.port) || undefined, cert: identity.cert, key: identity.key, token,
    });
    return this.washer;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const washer = await this.client();
      if (!washer) {
        if (this.current.reachable) this.apply({ reachable: false, state: null, remainingMinutes: null, progress: null });
        return;
      }
      const state = await washer.readState();
      this.warned.delete('auth');
      this.apply({ reachable: true, ...state });
    } catch (err) {
      if (err.kind === 'auth') {
        this.washer = null; // re-read the token file next time
        this.warnOnce('auth', `The washer refuses access (${err.message}). Run again: samsung-washer pair ${this.host}`);
      } else if (err.kind === 'tls') {
        this.warnOnce('tls', `Connexion TLS impossible : ${err.message}`);
      } else {
        this.log.debug(`Interrogation impossible : ${err.message}`);
      }
      this.apply({ reachable: false, state: null, remainingMinutes: null, progress: null });
    } finally {
      this.polling = false;
    }
  }

  apply(next) {
    const running = next.reachable && next.state === 'Run';
    if (running) {
      this.wasRunning = true;
      this.lastRunRemaining = next.remainingMinutes;
      this.finishedAt = null;
    } else if (next.state !== 'Pause' && this.wasRunning) {
      // Stopped (Ready, End, or gone from the network). Only a cycle that was
      // nearly over counts as finished, not a Wi-Fi drop in the middle of one.
      const ended = /end|complete|finish/i.test(next.progress || '')
        || (this.lastRunRemaining != null && this.lastRunRemaining <= END_THRESHOLD_MIN);
      if (ended) {
        this.finishedAt = Date.now();
        this.log.info('Wash finished.');
      }
      this.wasRunning = false;
    }
    this.current = next;

    const label = !next.reachable ? 'unreachable' : `${next.state}${running && next.remainingMinutes != null ? ` (${next.remainingMinutes} min left)` : ''}`;
    const stateKey = !next.reachable ? 'offline' : next.state;
    if (stateKey !== this.lastLogged) {
      this.lastLogged = stateKey;
      if (next.reachable) this.log.info(`État : ${label}`);
      else this.log.debug('Washer unreachable (normal when it is off or without Smart Control).');
    }

    const C = this.C;
    this.valve.updateCharacteristic(C.Active, running ? 1 : 0);
    this.valve.updateCharacteristic(C.InUse, running ? 1 : 0);
    this.valve.updateCharacteristic(C.RemainingDuration, this.remainingSeconds());
    if (this.contact) this.contact.updateCharacteristic(C.ContactSensorState, this.contactState());
  }

  hapError(status) {
    const { HapStatusError, HAPStatus } = this.api.hap;
    return new HapStatusError(HAPStatus[status]);
  }

  async setActive(value) {
    const washer = await this.client();
    if (!washer) throw this.hapError('SERVICE_COMMUNICATION_FAILURE');
    try {
      const state = await washer.readOperationState();
      if (value === 1 || value === true) {
        if (state === 'Run') return;
        await washer.writeState('Run');
        this.log.info(state === 'Pause' ? 'Resume requested.' : 'Starting the programme selected on the washer.');
      } else if (state === 'Run') {
        await washer.writeState(this.offAction === 'cancel' ? 'Ready' : 'Pause');
        this.log.info(this.offAction === 'cancel' ? 'Cancel requested.' : 'Pause requested.');
      }
    } catch (err) {
      if (err.kind === 'control-disabled') {
        this.log.warn('Command refused: turn Smart Control on at the washer (door closed, child lock off).');
        throw this.hapError('NOT_ALLOWED_IN_CURRENT_STATE');
      }
      if (err.kind === 'offline') {
        this.log.warn('Washer unreachable: it leaves the Wi-Fi when stopped unless Smart Control is on.');
      } else {
        this.log.error(`Command failed: ${err.message}`);
      }
      throw this.hapError('SERVICE_COMMUNICATION_FAILURE');
    } finally {
      // The answer means "accepted", not "applied": check what really happened.
      setTimeout(() => this.poll(), 4000);
    }
  }
}

module.exports = (api) => {
  api.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, WasherAccessory);
};
module.exports.WasherAccessory = WasherAccessory;
