'use strict';

const utils = require('@iobroker/adapter-core');
const mqtt = require('mqtt');
const P = require('./lib/protocol');

// Registers polled continuously (overview). Everything else is refreshed in the slow cycle.
const FAST_DEFAULT = [
    1079, 1082, 1088, 1893, 1894, 1936, 1946, 1951, 5001, 5002, 5004, 5005, 5006, 5032, 5034, 5039, 5049, 5105, 5119,
    5132, 5174, 5190, 5205, 5231, 5233, 5320, 5321, 5353, 5359, 5572, 5581, 5625, 5626, 5693, 5911,
];
// Refrigerant circuit values shown in the "heat pump" scheme of the web UI (service menu only).
// They are always read (fast cycle) and placed in their own folder "refrigerant_circuit".
const SCHEME = [5136, 5139, 5146, 5200, 5612, 5615];
const GROUPS = [{ id: 'refrigerant_circuit', name: P.FIXED_FOLDERS.refrigerant_circuit, codes: SCHEME }];
const MENU_USER = [3, 9]; // basic display + user menu
// registers holding secrets (service/expert passwords, session id, unlock code, SMT-ID) are never read or exposed
const SECRET_TYPES = /^(password_t|eightbytehash_t)$/;
const NEVER_WRITE = /IP_t|address|password|ssid|mac|eibpaddr|installation|country|language|devid|hash/i;
const BATCH = 80;
// actions that are safe to trigger from ioBroker (others like update/restart/reset only in write mode "all")
const SAFE_ACTIONS = [5693, 2126];

class Remko extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'remko' });
        this.db = null;
        this.client = null;
        this.fast = [];
        this.all = [];
        this.writable = new Set();
        this.timers = { keepAlive: null, full: null, watchdog: null };
        this.lastRx = 0;
        this.clientId = `SMT${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}I0000000000000000`;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const c = this.config;
        if (!c.host) {
            this.log.error('No IP address of the heat pump configured');
            return;
        }
        const base = `http://${c.host}`;

        // 1) credentials + topic from the web UI
        let creds = {
            username: '0000000000000000',
            password: c.password || null,
            topicPrefix: c.topicPrefix || null,
            version: null,
        };
        try {
            const js = await this.httpGet(`${base}/js/smt.min.js`);
            const found = P.parseSmtJs(js);
            creds = {
                username: found.username || creds.username,
                password: c.password || found.password,
                topicPrefix: c.topicPrefix || found.topicPrefix,
                version: found.version,
            };
            this.log.info(`Smart-Web Firmware ${found.version}, Topic ${creds.topicPrefix}`);
        } catch (e) {
            this.log.warn(`Cannot read smt.min.js (${e.message}) - using configuration`);
        }
        if (!creds.password || !creds.topicPrefix) {
            this.log.error('Could not determine MQTT password/topic - please enter them in the configuration');
            return;
        }
        await this.setStateAsync('info.firmware', creds.version || '', true);

        // 2) register database from the web UI (cached for offline start)
        const metaId = `${this.namespace}.files`;
        try {
            await this.setObjectNotExistsAsync('files', {
                type: 'meta',
                common: { name: 'REMKO Cache', type: 'meta.user' },
                native: {},
            });
        } catch (e) {
            this.log.debug(`meta object: ${e.message}`);
        }
        try {
            const [a, b] = await Promise.all([
                this.httpGet(`${base}/json/smt18.json`),
                this.httpGet(`${base}/json/smtmain.json`),
            ]);
            this.db = P.buildRegisterDb(JSON.parse(a), JSON.parse(b));
            try {
                await this.writeFileAsync(metaId, 'registerdb.json', JSON.stringify(this.db));
            } catch (e) {
                this.log.debug(`Cache not saved: ${e.message}`);
            }
        } catch (e) {
            this.log.warn(`Cannot load register database (${e.message}) - trying cache`);
            try {
                const f = await this.readFileAsync(metaId, 'registerdb.json');
                this.db = JSON.parse(f.file.toString());
            } catch {
                this.log.error('No register database available');
                return;
            }
        }
        this.log.info(`${Object.keys(this.db.regs).length} registers known`);

        // 3) which registers to poll / write
        const regs = this.db.regs;
        this.all = Object.keys(regs)
            .map(Number)
            .filter(n => !SECRET_TYPES.test(regs[n].typedef))
            .filter(n => c.includeMessages || !/^message|lasterror/.test(regs[n].typedef));
        this.allSet = new Set(this.all);
        const extra = String(c.fastRegisters || '')
            .split(/[\s,;]+/)
            .map(Number)
            .filter(n => regs[n]);
        this.fast = [...new Set([...FAST_DEFAULT, ...SCHEME].filter(n => regs[n] && this.allSet.has(n)).concat(extra))];
        this.userRegs = P.registersBelow(this.db.menus, regs, MENU_USER);
        for (const n of this.all) {
            const r = regs[n];
            if (c.writeMode === 'off' || NEVER_WRITE.test(r.typedef)) {
                continue;
            }
            if (r.typedef === 'action_t') {
                if (c.writeMode === 'all' || SAFE_ACTIONS.includes(n)) {
                    this.writable.add(n);
                }
                continue;
            }
            const isParam = n < 5000 || r.typedef === 'action_t';
            if (!isParam) {
                continue;
            }
            if (c.writeMode === 'all' || this.userRegs.has(n)) {
                this.writable.add(n);
            }
        }
        this.raw = {}; // code -> raw int (for display conditions)
        this.hex = {}; // code -> last hex value
        this.codeToId = new Map();
        this.idToCode = new Map();
        this.layoutDone = false;
        this.subscribeStates('*');

        // 4) MQTT
        this.connect(creds);
    }

    connect(creds) {
        const c = this.config;
        const ws = c.transport !== 'tcp';
        const url = ws ? `ws://${c.host}:${c.port || 9001}/mqtt` : `mqtt://${c.host}:${c.port || 1883}`;
        this.topicRx = `${creds.topicPrefix}/HOST2CLIENT`;
        this.topicTx = `${creds.topicPrefix}/CLIENT2HOST`;
        this.log.info(`Connecting to ${url} as ${this.clientId}`);
        this.client = mqtt.connect(url, {
            clientId: this.clientId,
            username: creds.username,
            password: creds.password,
            protocolVersion: 4,
            clean: true,
            reconnectPeriod: 10000,
            keepalive: 60,
        });
        this.client.on('connect', () => {
            this.log.info('MQTT connected');
            this.setState('info.connection', true, true);
            this.client.subscribe(this.topicRx, { qos: 0 });
            this.startPolling();
        });
        this.client.on('message', (topic, payload) => this.onMessage(payload));
        this.client.on('close', () => this.setState('info.connection', false, true));
        this.client.on('error', e => this.log.warn(`MQTT: ${e.message}`));
    }

    startPolling() {
        this.clearTimers();
        // setInterval overflows above 2^31-1 ms
        const MAX_TIMER = 2_147_483_647;
        const keepAliveMs = Math.min(Math.max(10, Number(this.config.keepAlive) || 30) * 1000, MAX_TIMER);
        const fullMs = Math.min(Math.max(1, Number(this.config.fullRefresh) || 15) * 60000, MAX_TIMER);
        this.fullRefresh();
        this.timers.keepAlive = this.setInterval(() => this.query(this.fast), keepAliveMs);
        this.timers.full = this.setInterval(() => this.fullRefresh(), fullMs);
        this.timers.watchdog = this.setInterval(() => {
            if (this.lastRx && Date.now() - this.lastRx > 3 * keepAliveMs) {
                this.log.warn('No data from heat pump - restarting query');
                this.lastRx = 0;
                this.query(this.fast);
            }
        }, keepAliveMs);
    }

    /** Query all registers in batches, then fall back to the fast list */
    async fullRefresh() {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;
        try {
            for (let i = 0; i < this.all.length; i += BATCH) {
                if (!this.client || !this.client.connected) {
                    break;
                }
                this.query(this.all.slice(i, i + BATCH));
                await this.delay(1500);
            }
            await this.delay(2000);
            await this.applyLayout();
        } catch (e) {
            this.log.error(`Refresh failed: ${e.message}`);
        } finally {
            this.refreshing = false;
            this.query(this.fast);
        }
    }

    query(list, values) {
        if (!this.client || !this.client.connected) {
            return;
        }
        const msg = { FORCE_RESPONSE: true, query_list: list, CLIENT_ID: this.clientId };
        if (values) {
            msg.values = values;
        }
        this.client.publish(this.topicTx, JSON.stringify(msg), { qos: 2, retain: false });
    }

    async onMessage(payload) {
        let j;
        try {
            j = JSON.parse(payload.toString());
        } catch {
            return;
        }
        if (!j || !j.values) {
            return;
        }
        this.lastRx = Date.now();
        for (const [code, hex] of Object.entries(j.values)) {
            const reg = this.db.regs[code];
            if (!reg || !this.allSet.has(reg.code)) {
                continue;
            }
            this.hex[code] = hex;
            this.raw[code] = P.rawInt(reg, hex);
            const id = this.codeToId.get(reg.code);
            if (!id) {
                continue;
            }
            const val = P.decode(reg, hex);
            if (val !== null) {
                // during the full refresh every value is re-published (fresh timestamp), so that
                // visualisations/caches started later also receive rarely changing settings
                if (this.refreshing) {
                    await this.setStateAsync(id, { val, ack: true });
                } else {
                    await this.setStateChangedAsync(id, { val, ack: true });
                }
            }
        }
    }

    /**
     * Create or replace an object. common is replaced completely (so outdated keys like min/max vanish),
     * user settings in common.custom and enums are kept.
     *
     * @param id object id (without namespace)
     * @param obj object definition
     * @param [previous] object of the same register under its old id (user settings are taken over)
     */
    async writeObject(id, obj, previous) {
        let old = await this.getObjectAsync(id);
        if (!old && previous) {
            // the object was renamed (e.g. new folder names) - take over the user settings of the old object
            old = previous;
        }
        if (old && old.common && old.common.custom) {
            obj.common.custom = old.common.custom;
        }
        await this.setObjectAsync(id, obj);
    }

    /** Decide (like the web UI) which registers are shown, create/remove objects accordingly */
    async applyLayout() {
        const c = this.config;
        const tops = c.menuLevel === 'service' ? [9, 405, 3, 10, 11, 4] : [9, 405, 3];
        const layout = P.layout(this.db, this.raw, { tops, all: !!c.showAll, always: this.fast, groups: GROUPS });
        const wanted = new Map(); // id -> object
        for (const [code, { path }] of layout) {
            if (!this.allSet.has(code)) {
                continue;
            }
            const reg = this.db.regs[code];
            if (reg.typedef === 'action_t' && !this.writable.has(code)) {
                continue; // actions are write-only buttons - only offer the allowed ones
            }
            let prefix = '';
            for (const seg of path) {
                prefix = prefix ? `${prefix}.${seg.id}` : seg.id;
                if (!wanted.has(prefix)) {
                    wanted.set(prefix, {
                        type: prefix.includes('.') ? 'channel' : 'folder',
                        common: { name: seg.name },
                        native: {},
                    });
                }
            }
            wanted.set(`${prefix}.${code}`, {
                type: 'state',
                common: P.commonFor(reg, this.writable.has(code)),
                native: { code, typedef: reg.typedef, userMenu: this.userRegs.has(code) },
            });
        }
        // existing state objects by register code (to take over user settings when an id changes)
        const ns = `${this.namespace}.`;
        const existing = await this.getAdapterObjectsAsync();
        const previousByCode = new Map();
        for (const obj of Object.values(existing)) {
            if (obj && obj.type === 'state' && obj.native && obj.native.code !== undefined) {
                previousByCode.set(Number(obj.native.code), obj);
            }
        }
        const newCodeToId = new Map();
        for (const [id, obj] of wanted) {
            if (obj.type === 'state') {
                newCodeToId.set(obj.native.code, id);
            }
        }
        for (const [id, obj] of wanted) {
            const known =
                obj.type === 'state'
                    ? this.codeToId.get(obj.native.code) === id
                    : !!(this.knownFolders && this.knownFolders.has(id));
            if (!known) {
                await this.writeObject(id, obj, obj.type === 'state' ? previousByCode.get(obj.native.code) : undefined);
            }
        }
        this.knownFolders = new Set([...wanted.keys()].filter(id => wanted.get(id).type !== 'state'));
        this.codeToId = newCodeToId;
        this.idToCode = new Map([...newCodeToId].map(([k, v]) => [v, k]));
        // remove objects that are no longer shown (incl. objects with old ids)
        let removed = 0;
        for (const fullId of Object.keys(existing)) {
            const id = fullId.startsWith(ns) ? fullId.slice(ns.length) : fullId;
            if (
                id === 'info' ||
                id.startsWith('info.') ||
                id === 'files' ||
                existing[fullId].type === 'meta' ||
                wanted.has(id)
            ) {
                continue;
            }
            await this.delObjectAsync(id);
            removed++;
        }
        for (const [code, id] of this.codeToId) {
            const hex = this.hex[code];
            if (hex === undefined) {
                continue;
            }
            const val = P.decode(this.db.regs[code], hex);
            if (val !== null) {
                await this.setStateChangedAsync(id, { val, ack: true });
            }
        }
        if (!this.layoutDone || removed) {
            this.log.info(
                `${this.codeToId.size} data points active${removed ? `, ${removed} obsolete objects removed` : ''}`,
            );
        }
        this.layoutDone = true;
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const code = this.idToCode ? this.idToCode.get(id.slice(this.namespace.length + 1)) : undefined;
        const reg = code !== undefined && this.db && this.db.regs[code];
        if (!reg) {
            return;
        }
        if (!this.writable.has(code)) {
            this.log.warn(`${code} (${P.textOf(reg.name)}) is not writable (write mode: ${this.config.writeMode})`);
            return;
        }
        if (reg.typedef === 'action_t' && !state.val) {
            return;
        }
        try {
            const hex = P.encode(reg, state.val);
            this.log.info(`Writing ${code} ${P.textOf(reg.name)} = ${state.val} (${hex})`);
            this.query([...new Set([...this.fast, code])], { [code]: hex });
        } catch (e) {
            this.log.error(`Write ${code} rejected: ${e.message}`);
        }
    }

    httpGet(url) {
        const http = require('node:http');
        return new Promise((resolve, reject) => {
            const req = http.get(url, { timeout: 15000 }, res => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        });
    }

    clearTimers() {
        for (const k of Object.keys(this.timers)) {
            if (this.timers[k]) {
                this.clearInterval(this.timers[k]);
            }
            this.timers[k] = null;
        }
    }

    onUnload(callback) {
        try {
            this.clearTimers();
            if (this.client) {
                this.client.end(true);
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Remko(options);
} else {
    new Remko();
}
