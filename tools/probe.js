#!/usr/bin/env node
'use strict';
/**
 * Stand-alone test: reads the REMKO heat pump without installing the adapter.
 *   node tools/probe.js <ip-of-heat-pump>              (WebSocket 9001, like the web UI)
 *   node tools/probe.js <ip-of-heat-pump> --tcp        (MQTT TCP 1883)
 *   node tools/probe.js <ip-of-heat-pump> --write 1082=46   (writes one register, then shows it)
 */
const http = require('node:http');
const mqtt = require('mqtt');
const P = require('../lib/protocol');

const args = process.argv.slice(2);
const host = args.find(a => !a.startsWith('--') && !/=/.test(a));
const opt = n => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined;
};
if (!host) {
    console.log(
        'usage: node tools/probe.js <ip> [--tcp] [--port N] [--http-port N] [--write CODE=VALUE] [--codes 1,2,3]',
    );
    process.exit(1);
}
const tcp = !!opt('tcp');
const port = Number(opt('port')) || (tcp ? 1883 : 9001);
const httpBase = `http://${host}${opt('http-port') ? `:${opt('http-port')}` : ''}`;
const SHOW = String(
    opt('codes') ||
        '1079,1082,1088,1951,5001,5006,5032,5034,5039,5049,5105,5119,5132,5174,5190,5205,5320,5321,5359,5581,5911',
)
    .split(',')
    .map(Number);

// English name of a register (falls back to the German controller text if there is no English one)
const name = r => (r.name.en && !/^Register \d+$/.test(r.name.en) ? r.name.en : r.name.de) || `Register ${r.code}`;

const get = url =>
    new Promise((res, rej) =>
        http
            .get(url, { timeout: 15000 }, r => {
                if (r.statusCode !== 200) {
                    r.resume();
                    return rej(new Error(`${url}: HTTP ${r.statusCode}`));
                }
                const c = [];
                r.on('data', d => c.push(d));
                r.on('end', () => res(Buffer.concat(c).toString()));
            })
            .on('error', rej),
    );

(async () => {
    const creds = P.parseSmtJs(await get(`${httpBase}/js/smt.min.js`));
    console.log(
        `Firmware ${creds.version}, topic ${creds.topicPrefix}, password ${creds.password ? `found (${creds.password.length} characters)` : 'NOT found'}`,
    );
    const db = P.buildRegisterDb(
        JSON.parse(await get(`${httpBase}/json/smt18.json`)),
        JSON.parse(await get(`${httpBase}/json/smtmain.json`)),
    );
    console.log(`${Object.keys(db.regs).length} registers in the database`);

    const url = tcp ? `mqtt://${host}:${port}` : `ws://${host}:${port}/mqtt`;
    const clientId = `SMT${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}I0000000000000000`;
    const c = mqtt.connect(url, {
        clientId,
        username: creds.username,
        password: creds.password,
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 10000,
    });
    const got = {};
    const fail = setTimeout(() => {
        console.error('Timeout - no response');
        process.exit(2);
    }, 30000);
    c.on('error', e => {
        console.error('MQTT error:', e.message);
        process.exit(2);
    });
    c.on('connect', () => {
        console.log(`MQTT connected (${url})`);
        c.subscribe(`${creds.topicPrefix}/HOST2CLIENT`);
        const msg = { FORCE_RESPONSE: true, query_list: SHOW, CLIENT_ID: clientId };
        const w = opt('write');
        if (typeof w === 'string') {
            const [code, val] = w.split('=');
            msg.values = { [code]: P.encode(db.regs[code], Number(val)) };
            if (!SHOW.includes(Number(code))) {
                msg.query_list.push(Number(code));
            }
            console.log(`WRITE ${code} (${name(db.regs[code])}) = ${val} -> ${msg.values[code]}`);
        }
        c.publish(`${creds.topicPrefix}/CLIENT2HOST`, JSON.stringify(msg), { qos: 2 });
    });
    c.on('message', (t, p) => {
        let j;
        try {
            j = JSON.parse(p.toString());
        } catch {
            return;
        }
        Object.assign(got, j.values || {});
        if (SHOW.every(n => got[n] !== undefined)) {
            clearTimeout(fail);
            for (const n of SHOW) {
                const r = db.regs[n];
                const v = P.decode(r, got[n]);
                const txt =
                    r.states && r.states[v] !== undefined ? `${P.textOf(r.states[v])} (${v})` : `${v} ${r.unit || ''}`;
                console.log(`${String(n).padEnd(5)} ${name(r).padEnd(28)} ${txt}`);
            }
            c.end(true, () => process.exit(0));
        }
    });
})().catch(e => {
    console.error(e.message);
    process.exit(1);
});
