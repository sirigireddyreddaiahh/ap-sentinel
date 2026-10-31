#!/usr/bin/env node
'use strict';
// Batch check over a folder of PDFs: text extraction, field accuracy against a ground-truth CSV, and the AP rules.
// Usage: node scripts/batch-check.js <folder> [ground-truth.csv] [--out report.json]
const fs = require('fs');
const path = require('path');
const { pdfText } = require('../srv/lib/pdftext');
const { renderPages, findQrJwt } = require('../srv/lib/pdfimage');
const { extractFields, readPdfMeta } = require('../srv/lib/extract');
const { parseCsv } = require('../srv/lib/csv');
const { runRules } = require('../srv/rules/engine');
const masters = require('../data/masters.json');

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const outFile = outAt >= 0 ? argv[outAt + 1] : null;
const positional = argv.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const [folder, truthFile] = positional;
if (!folder) {
  console.error('usage: node scripts/batch-check.js <folder> [ground-truth.csv] [--out report.json]');
  process.exit(2);
}

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(String(v).replace(/,/g, '')));
const dmyToIso = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const same = (a, b) => (a === undefined || a === null || b === undefined || b === null)
  ? false : String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

(async () => {
  const truth = {};
  if (truthFile) {
    for (const row of parseCsv(fs.readFileSync(truthFile, 'utf8'))) {
      try { truth[row.filename] = JSON.parse(row.json_data); } catch (e) { /* skip rows without valid JSON */ }
    }
  }

  // 1. Read every PDF and extract its fields.
  const files = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  const items = [];
  for (const file of files) {
    const item = { file, error: null, hasText: false, qr: false, fields: {}, inv: null };
    try {
      const buf = fs.readFileSync(path.join(folder, file));
      const text = await pdfText(buf);
      item.hasText = text.length > 20;
      const pages = await renderPages(buf, { maxPages: 2, scale: 2 });
      const qrJwt = findQrJwt(pages);
      item.qr = !!qrJwt;
      item.fields = extractFields(text);
      if (qrJwt) item.fields.qrJwt = qrJwt;
      item.inv = { ...item.fields, source: 'BATCH', fileName: file, pdfText: text, pdfMeta: readPdfMeta(buf) };
    } catch (e) {
      item.error = e.message;
    }
    items.push(item);
  }

  // 2. Run the AP rules. The batch gives the duplicate and split context, as in the app.
  const batch = items.filter(i => i.inv).map(i => i.inv);
  batch.forEach((inv, i) => {
    const res = runRules(inv, {
      masters, posted: [], batch, earlier: batch.slice(0, i), irpPublicKeyPem: process.env.IRP_PUBLIC_KEY_PEM,
    });
    const item = items.find(x => x.inv === inv);
    item.status = res.status;
    item.triggered = res.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier))
      .map(r => ({ id: r.id, tier: r.tier, text: r.text }));
  });

  // 3. Field accuracy against the ground truth.
  const fieldNames = ['invoiceNo', 'invoiceDate', 'supplierName', 'supplierGstin', 'total', 'taxable', 'vat', 'buyerTaxId'];
  const acc = Object.fromEntries(fieldNames.map(f => [f, { correct: 0, found: 0, total: 0 }]));
  for (const item of items) {
    const t = truth[item.file];
    if (!t) continue;
    const f = item.fields;
    const checks = {
      invoiceNo: same(f.invoiceNo, t.invoice_no),
      invoiceDate: f.invoiceDate === dmyToIso(t.date_of_issue),
      supplierName: same(f.supplierName, t.seller && t.seller.name),
      supplierGstin: same(f.supplierGstin, t.seller && t.seller.gstin),
      total: Math.abs(f.total - num(t.summary && t.summary.gross_worth)) < 0.005,
      taxable: Math.abs(f.taxable - num(t.summary && t.summary.net_worth)) < 0.005,
      vat: Math.abs(f.vat - num(t.summary && t.summary.vat_amount)) < 0.005,
      buyerTaxId: same(f.buyerTaxId, t.client && t.client.tax_id),
    };
    item.accuracy = checks;
    for (const k of fieldNames) {
      acc[k].total++;
      if (f[k] !== undefined) acc[k].found++;
      if (checks[k]) acc[k].correct++;
    }
  }

  // 4. Summary.
  const count = (fn) => items.filter(fn).length;
  const statuses = {};
  for (const i of items) if (i.status) statuses[i.status] = (statuses[i.status] || 0) + 1;
  const ruleHits = {};
  for (const i of items) for (const r of (i.triggered || [])) {
    if (r.tier !== 'FLAG' || true) ruleHits[`${r.id} ${r.tier}`] = (ruleHits[`${r.id} ${r.tier}`] || 0) + 1;
  }
  console.log(`PDFs: ${items.length} | read errors: ${count(i => i.error)} | with text layer: ${count(i => i.hasText)} | with QR code: ${count(i => i.qr)}`);
  console.log('Overall status:', JSON.stringify(statuses));
  console.log('Rule hits (invoices):');
  for (const [k, v] of Object.entries(ruleHits).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(14)} ${v}`);
  if (truthFile) {
    console.log('Field accuracy against ground truth (correct / found / total):');
    for (const k of fieldNames) {
      const a = acc[k];
      const pct = a.total ? Math.round(100 * a.correct / a.total) : 0;
      console.log(`  ${k.padEnd(14)} ${String(a.correct).padStart(4)} / ${String(a.found).padStart(4)} / ${a.total}   (${pct}% correct)`);
    }
  }
  if (outFile) {
    const report = items.map(({ inv, ...rest }) => rest);
    fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), statuses, ruleHits, accuracy: acc, items: report }, null, 2));
    console.log('report written:', outFile);
  }
})().catch(e => { console.error(e); process.exit(1); });
