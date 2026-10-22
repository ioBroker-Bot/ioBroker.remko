'use strict';
// Rebuild raw smt18/smtmain-like JSON from the compact export captured from the real WKF 100
let d;
try {
    d = require('./fixtures/remko-wkf100-register.json');
} catch {
    // The fixture is a capture of a real heat pump and is not part of the public repository.
    console.log('SKIP: test/fixtures/remko-wkf100-register.json missing (capture of a real installation, not part of the repository)');
    process.exit(0);
}
const F = d.fields;
const smt18 = { typedef: {}, rangemin: {}, rangemax: {}, step: {}, decimals: {}, issigned: {}, bytecount: {}, elemcount: {}, text: {}, display_list: {} };
const smtmain = { unit: {}, typedef_list: {}, parent_id: {} };
for (const [code, r] of Object.entries(d.regs)) {
    const o = Object.fromEntries(F.map((f, i) => [f, r[i]]));
    smt18.typedef[code] = o.typedef; smt18.rangemin[code] = o.min; smt18.rangemax[code] = o.max; smt18.step[code] = o.step;
    smt18.decimals[code] = o.decimals; smt18.issigned[code] = o.signed; smt18.bytecount[code] = o.bytecount; smt18.elemcount[code] = o.elemcount;
    smt18.text[code] = { de: o.de, en: o.en };
}
for (const [id, m] of Object.entries(d.menus)) { smt18.display_list[id] = m.d; smt18.text[id] = { de: m.t }; smtmain.parent_id[id] = m.p; }
for (const [k, v] of Object.entries(d.enums)) smtmain.typedef_list[k] = { de: v };
smtmain.unit = d.units;
smt18.display_condition = {};
for (const [id, m] of Object.entries(d.menus)) smt18.display_condition[id] = m.c;
// a few real register conditions (WKF 100, captured 2026-09-28)
Object.assign(smt18.display_condition, { 5019: 'ID(1952)==1', 5020: 'ID(1952)==1', 5693: '0', 1082: 'ID(1137)==1', 5039: 'ID(1137)==1', 1893: 'ID(1231)==0', 5006: 'ID(5998)!=5', 5359: 'ID(1857)!=0', 5105: 'ID(5855)==1' });
module.exports = { smt18, smtmain, values: d.values, meta: d.meta };
