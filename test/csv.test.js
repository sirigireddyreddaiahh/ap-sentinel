'use strict';
// An S/4HANA export, imported from CSV, must give the same outcome for every invoice as the mock extract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCsv, s4RowToInvoice } = require('../srv/lib/csv');
const { runRules } = require('../srv/rules/engine');
const masters = require('../data/masters.json');

const expected = {
  'S4-0001': 'PASS', 'S4-0002': 'REJECT', 'S4-0003': 'PASS', 'S4-0004': 'HOLD', 'S4-0005': 'HOLD',
  'S4-0006': 'HOLD', 'S4-0007': 'HOLD', 'S4-0008': 'FLAG', 'S4-0009': 'REJECT', 'S4-0010': 'HOLD',
};

test('CSV parser handles quoted commas and doubled quotes', () => {
  const rows = parseCsv('A,B\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }]);
});

test('imported S/4 export gives the same outcome as the mock extract', () => {
  const text = fs.readFileSync(path.join(__dirname, '../samples/s4-export-sample.csv'), 'utf8');
  const list = parseCsv(text).map(s4RowToInvoice);
  assert.equal(list.length, 10);
  const posted = [
    { invoiceNo: 'GVF-INV-0456', supplierGstin: list[1].supplierGstin, invoiceDate: '2026-09-15', total: 118000, description: 'Bulk food supplies - September', irn: null, recurringPo: false },
    { invoiceNo: 'TMC-AMC-SEP26', supplierGstin: list[2].supplierGstin, invoiceDate: '2026-09-30', total: 59000, description: 'Monthly AMC HVAC maintenance', irn: null, recurringPo: false },
  ];
  list.forEach((inv, i) => {
    const out = runRules(inv, { masters, posted, batch: list, earlier: list.slice(0, i), irpPublicKeyPem: undefined });
    assert.equal(out.status, expected[inv.id], `${inv.id}`);
  });
});
