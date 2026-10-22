'use strict';
const assert = require('node:assert');
const P = require('../../lib/protocol');
const { smt18, smtmain, values } = require('./fixture');

const db = P.buildRegisterDb(smt18, smtmain);
const R = db.regs;
assert.ok(Object.keys(R).length > 2000, 'register count');

// real values captured from the WKF 100 on 2026-09-23
const dec = c => P.decode(R[c], values[c]);
assert.strictEqual(dec(1082), 45);          // WW Soll-Temp 01C2
assert.strictEqual(dec(1079), 1);           // Automatik Eco
assert.strictEqual(R[1079].states['1'], 'Automatik Eco');
assert.ok(dec(5032) > -30 && dec(5032) < 45); // outside temperature plausible
assert.ok(dec(5039) > 20 && dec(5039) < 70);  // WW Ist plausibel
assert.strictEqual(dec(5359), 8.8);         // PV-Leistung kW
assert.strictEqual(dec(5105), 8960);        // el. Energie kWh
assert.strictEqual(typeof dec(1081), 'string'); // Zeitprogramm raw hex

// negative temperatures
assert.strictEqual(P.decode(R[5032], 'FF9C'), -10);
// encode
assert.strictEqual(P.encode(R[1082], 50), '01F4');
assert.strictEqual(P.encode(R[1082], 47.5), '01DB');
assert.strictEqual(P.encode(R[1079], 3), '03');
assert.strictEqual(P.encode(R[5693], true), '01');
assert.strictEqual(P.decode(R[5693], '00'), false);
assert.deepStrictEqual([P.commonFor(R[5693], true).type, P.commonFor(R[5693], true).role], ['boolean', 'button']);
assert.strictEqual(P.commonFor(R[5911], false).role, 'value');
assert.strictEqual(P.commonFor(R[5359], false).role, 'value.power');
assert.throws(() => P.encode(R[1082], 70), /out of range/);
assert.strictEqual(P.encode(R[1946], -2.5), 'FFE7');
assert.strictEqual(P.decode(R[1946], 'FFE7'), -2.5);

// common
const c = P.commonFor(R[1082], true);
assert.deepStrictEqual([c.type, c.role, c.unit, c.min, c.max, c.step], ['number', 'level.temperature', '°C', 40, 60, 0.5]);

// user menu contains the relevant user settings
const user = P.registersBelow(db.menus, R, [3, 9]);
for (const n of [1079, 1082, 1893, 1894, 1936]) assert.ok(user.has(n), `user menu ${n}`);

// smt.min.js parsing
const js = 'x;global.SMT_VERSION=\'4.28\';y;global.MQTT_TOPIC=VERSION+"/SMTID",global.MQTT_USERNAME="0000000000000000",global.MQTT_PASSWORD="TESTPASSWORD1234");';
assert.deepStrictEqual(P.parseSmtJs(js), { username: '0000000000000000', password: 'TESTPASSWORD1234', version: '4.28', topicPrefix: 'V04P28/SMTID' });
console.log('protocol tests OK');
