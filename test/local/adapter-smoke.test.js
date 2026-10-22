'use strict';
// Runs main.js against the mock heat pump with a fake adapter-core (no js-controller needed)
const assert = require('node:assert');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const states = {}; const objects = {}; const files = {}; const logs = [];
class FakeAdapter extends EventEmitter {
    constructor(o) { super(); this.namespace = `${o.name}.0`; this.config = FakeAdapter.config;
        this.log = { info: m => logs.push('I ' + m), warn: m => logs.push('W ' + m), error: m => logs.push('E ' + m), debug: () => {} };
        setImmediate(() => this.emit('ready')); FakeAdapter.instance = this; }
    async setStateAsync(id, v, ack) { states[id] = typeof v === 'object' && v !== null ? v : { val: v, ack }; }
    setState(id, v, ack) { this.setStateAsync(id, v, ack); }
    async setStateChangedAsync(id, s) { states[id] = s; }
    async extendObjectAsync(id, o) { objects[id] = o; }
    async getObjectAsync(id) { return objects[id] || null; }
    async setObjectAsync(id, o) { objects[id] = JSON.parse(JSON.stringify(o)); }
    async setForeignObjectNotExistsAsync(id, o) { if (!objects[id]) objects[id] = o; }
    async writeFileAsync(ns, f, d) { if (!objects[ns] || objects[ns].type !== 'meta') throw new Error(`${ns} is not an object of type "meta"`); files[f] = d; }
    async readFileAsync(ns, f) { return { file: Buffer.from(files[f]) }; }
    subscribeStates() {}
    async getAdapterObjectsAsync() { return Object.fromEntries(Object.entries(objects).map(([k, v]) => [`${this.namespace}.${k}`, v])); }
    async delObjectAsync(id) { delete objects[id]; delete states[id]; }
    setInterval(f, t) { return setInterval(f, t); } clearInterval(t) { clearInterval(t); }
    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}
FakeAdapter.config = { host: '127.0.0.1', transport: 'tcp', port: 18831, keepAlive: 30, fullRefresh: 15, writeMode: 'user' };
const origLoad = Module._load;
Module._load = function (req, ...a) { return req === '@iobroker/adapter-core' ? { Adapter: FakeAdapter } : origLoad.call(this, req, ...a); };

// mock heat pump with HTTP on port 80 is not possible -> patch httpGet base via host:port trick
const http = require('node:http'); const net = require('node:net');
const aedesFactory = require('aedes'); const { smt18, smtmain, values } = require('./fixture');
const PW = 'MOCKPASSWORD0001'; const vals = { ...values }; let writes = [];
const aedes = aedesFactory({ authenticate: (c, u, p, cb) => cb(null, u === '0000000000000000' && String(p) === PW) });
aedes.on('publish', (pk, cl) => { if (!cl || !pk.topic.endsWith('/CLIENT2HOST')) return; const j = JSON.parse(pk.payload.toString());
    if (j.values) { writes.push(j.values); Object.assign(vals, j.values); }
    const out = {}; for (const c of j.query_list || []) if (vals[c] !== undefined) out[c] = vals[c];
    aedes.publish({ topic: 'V04P28/SMTID/HOST2CLIENT', payload: JSON.stringify({ values: out, CLIENT_ID: j.CLIENT_ID }) }, () => {}); });
const broker = net.createServer(aedes.handle).listen(18831);
const web = http.createServer((q, r) => { const b = { '/js/smt.min.js': `global.SMT_VERSION='4.28';global.MQTT_USERNAME="0000000000000000",global.MQTT_PASSWORD="${PW}"`,
    '/json/smt18.json': JSON.stringify(smt18), '/json/smtmain.json': JSON.stringify(smtmain) }[q.url]; r.writeHead(b ? 200 : 404); r.end(b || ''); }).listen(18081);
FakeAdapter.config.httpPort = 18081;
objects['parameter.1082'] = { type: 'state', common: {}, native: {} };
objects['parameter'] = { type: 'folder', common: {}, native: {} };
const main = require('../../main.js');
// mqtt must go to 127.0.0.1 -> override connect url host
main({});

(async () => {
    await new Promise(r => setTimeout(r, 38000)); // full refresh: ~27 batches * 1.5 s
    const a = FakeAdapter.instance;
    console.log(logs.join('\n'));
    assert.strictEqual(states['info.connection'].val, true);
    assert.strictEqual(states['einstellungen.warmwasser.1082'].val, 45);
    assert.strictEqual(objects['einstellungen.warmwasser.1082'].common.write, true);
    assert.strictEqual(objects['information.warmwasser.5039'].common.write, false);
    assert.strictEqual(objects['einstellungen.warmwasser.1079'].common.states['2'], 'nur Solar / PV');
    assert.strictEqual(objects['information.warmwasser'].type, 'channel');
    assert.ok(!Object.keys(objects).some(k => k.endsWith('.5019')), 'solar collector hidden');
    assert.ok(!objects['parameter.1082'], 'old 0.1 object removed');
    assert.ok(objects['overview.5693'], 'action kept');
    assert.ok(!Object.keys(objects).some(k => /\.(5052|5182|5181|1935|1015)$/.test(k)), 'no secret registers');
    assert.strictEqual(objects['overview.5693'].common.write, true);
    const n = Object.keys(objects).length; console.log('Objekte:', n, 'beschreibbar:', Object.values(objects).filter(o => o.common.write).length);
    assert.ok(n > 300);
    // official ioBroker object structure check (same as in ioBroker.repositories PRs)
    let checkObjectStructure = null;
    try {
        ({ checkObjectStructure } = require('@iobroker/repochecker/lib/objectStructure'));
    } catch {
        console.log('SKIP object structure check (install @iobroker/repochecker globally or set NODE_PATH)');
    }
    const dump = { 'remko.0': { _id: 'remko.0', type: 'instance', common: { name: 'remko' }, native: {} } };
    for (const [k, v] of Object.entries(objects)) dump[`remko.0.${k}`] = { _id: `remko.0.${k}`, ...v };
    const res = checkObjectStructure ? checkObjectStructure(dump, 'remko') : { errors: [], warnings: [] };
    const summary = [...res.errors, ...res.warnings].map(e => `${e.code} ${e.message}`);
    console.log('object check:', res.errors.length, 'errors,', res.warnings.length, 'warnings');
    summary.slice(0, 15).forEach(l => console.log('  ' + l));
    assert.strictEqual(res.errors.length + res.warnings.length, 0, 'object structure check');
    assert.ok(files['registerdb.json'], 'cache written');
    assert.ok(!logs.some(l => l.startsWith('E ') && !/rejected/.test(l)), 'no errors');
    a.emit('stateChange', 'remko.0.einstellungen.warmwasser.1082', { val: 48, ack: false });
    a.emit('stateChange', 'remko.0.einstellungen.warmwasser.1082', { val: 99, ack: false }); // out of range -> rejected
    a.emit('stateChange', 'remko.0.information.warmwasser.5039', { val: 10, ack: false });   // read-only -> rejected
    a.emit('stateChange', 'remko.0.overview.5693', { val: true, ack: false });
    await new Promise(r => setTimeout(r, 1500));
    assert.deepStrictEqual(writes, [{ 1082: '01E0' }, { 5693: '01' }]);
    assert.strictEqual(states['einstellungen.warmwasser.1082'].val, 48);
    console.log(logs.slice(-3).join('\n'));
    a.emit('unload', () => {}); broker.close(); web.close(); aedes.close();
    console.log('adapter smoke test OK'); process.exit(0);
})().catch(e => { console.error(logs.join('\n')); console.error(e); process.exit(1); });
