'use strict';
// Simulated Smart-Web: HTTP (smt.min.js + register JSON) and an authenticated MQTT broker
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const aedesFactory = require('aedes');
const { smt18, smtmain, values } = require('./fixture');

const PW = 'MOCKPASSWORD0001';
const vals = { ...values };
(async () => {
    const aedes = aedesFactory({
        authenticate: (client, u, p, cb) => cb(null, u === '0000000000000000' && String(p) === PW),
    });
    aedes.on('publish', (packet, client) => {
        if (!client || !packet.topic.endsWith('/CLIENT2HOST')) return;
        const j = JSON.parse(packet.payload.toString());
        if (j.values) Object.assign(vals, j.values);
        const out = {};
        for (const c of j.query_list || []) if (vals[c] !== undefined) out[c] = vals[c];
        aedes.publish({ topic: 'V04P28/SMTID/HOST2CLIENT', payload: JSON.stringify({ values: out, CLIENT_ID: j.CLIENT_ID, SMT_DEV: 236 }), qos: 0, retain: false }, () => {});
    });
    const broker = net.createServer(aedes.handle).listen(18830);
    const web = http.createServer((q, r) => {
        const body = { '/js/smt.min.js': `global.SMT_VERSION='4.28';global.MQTT_TOPIC=VERSION+"/SMTID",global.MQTT_USERNAME="0000000000000000",global.MQTT_PASSWORD="${PW}")`,
            '/json/smt18.json': JSON.stringify(smt18), '/json/smtmain.json': JSON.stringify(smtmain) }[q.url];
        r.writeHead(body ? 200 : 404); r.end(body || '');
    }).listen(18080);

    const run = a => new Promise(res => execFile('node', ['tools/probe.js', '127.0.0.1', '--tcp', '--port', '18830', '--http-port', '18080', ...a], (e, so, se) => res({ code: e ? e.code : 0, out: so + se })));
    let r = await run([]);
    console.log(r.out);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /^1082 .*\s45 °C/m);
    assert.match(r.out, /Automatik Eco \(1\)/);
    r = await run(['--write', '1082=47.5']);
    console.log(r.out);
    assert.match(r.out, /-> 01DB/);
    assert.match(r.out, /^1082 .*\s47\.5 °C/m);
    broker.close(); web.close(); aedes.close();
    console.log('mock heat pump test OK');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
