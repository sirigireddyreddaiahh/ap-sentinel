'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const U = require('./rules/util');
const { runRules } = require('./rules/engine');
const { extractFields, readPdfMeta } = require('./lib/extract');
const { pdfText } = require('./lib/pdftext');
const { renderPages, findQrJwt } = require('./lib/pdfimage');
const { ocrImage } = require('./lib/ocr');
const { parseCsv, s4RowToInvoice } = require('./lib/csv');

const masters = require('../data/masters.json');
const s4Invoices = require('../data/s4-invoices.json');

const NUMERIC = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'total'];
const DECISIONS = ['CLEAR', 'CONFIRM', 'ESCALATE'];
const ROLES = ['APClerk', 'APController', 'Auditor'];

// IRP public key: environment variable first, then config/irp-public-key.pem if present.
function loadIrpKey() {
  if (process.env.IRP_PUBLIC_KEY_PEM) return process.env.IRP_PUBLIC_KEY_PEM;
  const f = path.join(__dirname, '..', 'config', 'irp-public-key.pem');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
}

// Accepts a JSON string or an object from the UI, and normalises it.
function parseInvoice(raw) {
  const inv = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };
  for (const k of NUMERIC) {
    if (inv[k] !== undefined && inv[k] !== null && inv[k] !== '') inv[k] = Number(String(inv[k]).replace(/,/g, ''));
    else delete inv[k];
  }
  if (inv.invoiceDate && /^\d{2}\/\d{2}\/\d{4}$/.test(inv.invoiceDate)) {
    const [d, m, y] = inv.invoiceDate.split('/');
    inv.invoiceDate = `${y}-${m}-${d}`;
  }
  if (inv.supplierGstin) inv.supplierGstin = String(inv.supplierGstin).trim().toUpperCase();
  if (inv.buyerGstin) inv.buyerGstin = String(inv.buyerGstin).trim().toUpperCase();
  return inv;
}

const publicView = (inv) => { const { pdfText: _text, ...rest } = inv; return rest; };

const isRecurring = (inv) => {
  const po = inv.poNumber ? (masters.purchaseOrders || []).find(p => String(p.po) === String(inv.poNumber)) : null;
  return !!(po && po.recurring);
};

module.exports = class FraudService extends cds.ApplicationService {
  async init() {
    // Database entities. Writes made by this code bypass the service-level read-only rules.
    const E = cds.entities('ap');

    const audit = async (action, checkId, detail) => {
      const last = await cds.run(SELECT.one.from(E.AuditLog).orderBy('idx desc'));
      const idx = last ? last.idx + 1 : 1;
      const prevHash = last ? last.hash : '';
      const ts = new Date().toISOString();
      const hash = U.auditHash(idx, ts, checkId || '', action, detail || '', prevHash);
      await cds.run(INSERT.into(E.AuditLog).entries({
        idx, ts, action, checkId: checkId || null, detail: String(detail || '').slice(0, 1000), prevHash, hash,
      }));
    };

    const persist = async (inv, result, source) => {
      const checkId = crypto.randomUUID();
      await cds.run(INSERT.into(E.Checks).entries({
        ID: checkId, source, fileName: inv.fileName || null, supplierName: inv.supplierName || null,
        supplierGstin: inv.supplierGstin || null, invoiceNo: inv.invoiceNo || null,
        invoiceDate: inv.invoiceDate || null, total: inv.total ?? null,
        status: result.status, resultJson: JSON.stringify(result),
      }));
      await cds.run(INSERT.into(E.CheckResults).entries(result.results.map(r => ({
        ID: crypto.randomUUID(), check_ID: checkId, ruleId: r.id, title: r.title, tier: r.tier, text: r.text,
      }))));
      const alerts = result.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier));
      for (const r of alerts) {
        r.alertId = crypto.randomUUID();
        await cds.run(INSERT.into(E.Alerts).entries({
          ID: r.alertId, check_ID: checkId, ruleId: r.id, title: r.title, tier: r.tier, text: r.text, decision: 'OPEN',
        }));
      }
      await audit('CHECK', checkId, `${result.status} ${inv.invoiceNo || ''}: ${alerts.map(a => a.id).join(', ') || 'no alerts'}`);
      return checkId;
    };

    const applyDecision = async (req, alertId, decision, comment) => {
      if (!DECISIONS.includes(decision)) return req.reject(400, 'Decision must be CLEAR, CONFIRM or ESCALATE');
      const text = String(comment || '').trim();
      if (!text) return req.reject(400, 'A comment is required for every decision');
      const alert = await cds.run(SELECT.one.from(E.Alerts).where({ ID: alertId }));
      if (!alert) return req.reject(404, 'Alert not found');
      if (alert.tier === 'REJECT' && decision === 'CLEAR') return req.reject(409, 'A REJECT is final and cannot be cleared');
      const who = (req.user && req.user.id) || 'reviewer';
      await cds.run(UPDATE(E.Alerts).set({ decision, comment: text, decidedBy: who, decidedAt: new Date().toISOString() }).where({ ID: alertId }));
      await audit('DECISION', alert.check_ID, `${alert.ruleId} ${decision} by ${who}: ${text}`);
      return JSON.stringify({ alertId, decision, decidedBy: who });
    };

    this.on('whoami', req => JSON.stringify({ id: req.user.id, roles: ROLES.filter(r => req.user.is(r)) }));

    this.on('fetchS4Invoices', () => JSON.stringify(s4Invoices));

    this.on('importS4Extract', async req => {
      const { fileName, content } = req.data;
      const text = String(content || '').replace(/^\uFEFF/, '').trim();
      if (!text) return req.reject(400, 'The file is empty');
      let list;
      try {
        list = text.startsWith('[') ? JSON.parse(text) : parseCsv(text).map(s4RowToInvoice);
      } catch (e) { return req.reject(400, 'The file could not be read: ' + e.message); }
      if (!Array.isArray(list) || !list.length) return req.reject(400, 'The file has no invoice rows');
      await audit('IMPORT', null, `${fileName || 'extract'}: ${list.length} rows`);
      return JSON.stringify({ fileName, count: list.length, invoices: list.map(i => ({ ...i, source: 'S4' })) });
    });

    this.on('extractPdf', async req => {
      const { fileName, pdfBase64 } = req.data;
      const buf = Buffer.from(pdfBase64 || '', 'base64');
      if (buf.length < 5 || buf.subarray(0, 4).toString('latin1') !== '%PDF') return req.reject(400, 'The file is not a PDF');
      let text = '';
      try { text = await pdfText(buf); } catch (e) { return req.reject(400, 'The PDF could not be read: ' + e.message); }

      let pages = [], qrJwt = null, warning = null, ocrUsed = false;
      try {
        pages = await renderPages(buf, { maxPages: 2, scale: 2 });
        qrJwt = findQrJwt(pages);
      } catch (e) { warning = `The page could not be rendered for QR reading (${e.message}).`; }

      if (!text && pages.length) {
        try {
          const parts = [];
          for (const pg of pages) parts.push(await ocrImage(pg.png));
          text = parts.join('\n').trim();
          ocrUsed = true;
          warning = text ? 'Read by OCR. Check every field against the scan before you check the invoice.'
            : 'OCR found no text. Enter the fields manually.';
        } catch (e) {
          warning = `No text layer, and OCR is unavailable (${e.message}). Enter the fields manually.`;
        }
      } else if (!text && !warning) {
        warning = 'No text layer found. Enter the fields manually.';
      }

      const fields = extractFields(text);
      if (qrJwt) fields.qrJwt = qrJwt;
      return JSON.stringify({ fileName, fields, pdfText: text, pdfMeta: readPdfMeta(buf), qrFound: !!qrJwt, ocrUsed, warning });
    });

    this.on('checkInvoice', async req => {
      const inv = parseInvoice(req.data.invoice);
      const posted = await cds.run(SELECT.from(E.Posted));
      const result = runRules(inv, { masters, posted, batch: [], earlier: [], irpPublicKeyPem: loadIrpKey() });
      const checkId = await persist(inv, result, inv.source || 'UPLOAD');
      return JSON.stringify({ checkId, ...result, invoice: publicView(inv) });
    });

    this.on('checkBatch', async req => {
      const list = JSON.parse(req.data.invoices).map(parseInvoice);
      const posted = await cds.run(SELECT.from(E.Posted));
      const key = loadIrpKey();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const inv = list[i];
        const result = runRules(inv, { masters, posted, batch: list, earlier: list.slice(0, i), irpPublicKeyPem: key });
        const checkId = await persist(inv, result, inv.source || 'S4');
        out.push({ id: inv.id, checkId, ...result, invoice: publicView(inv) });
      }
      return JSON.stringify(out);
    });

    this.on('postInvoice', async req => {
      const inv = parseInvoice(req.data.invoice);
      const posted = await cds.run(SELECT.from(E.Posted));
      const result = runRules(inv, { masters, posted, batch: [], earlier: [], irpPublicKeyPem: loadIrpKey() });
      if (result.results.some(r => r.id === 'INPUT')) return req.reject(400, 'Complete the invoice fields before posting');
      const checkId = await persist(inv, result, inv.source || 'UPLOAD');
      if (result.status === 'REJECT') {
        await audit('POST_BLOCKED', checkId, `Not posted (REJECT): ${inv.invoiceNo}`);
        return JSON.stringify({ posted: false, blocked: false, checkId, ...result });
      }
      const blocked = result.status === 'HOLD';
      await cds.run(INSERT.into(E.Posted).entries({
        invoiceNo: inv.invoiceNo, supplierGstin: inv.supplierGstin, invoiceDate: inv.invoiceDate,
        total: inv.total, description: inv.description || '', irn: inv.irn || null, blocked,
        recurringPo: isRecurring(inv), postedAt: new Date().toISOString(),
      }));
      await audit('POST', checkId, `Posted ${inv.invoiceNo}${blocked ? ' (payment blocked)' : ''}`);
      return JSON.stringify({ posted: true, blocked, checkId, ...result });
    });

    this.on('decideAlert', req => applyDecision(req, req.data.alertId, req.data.decision, req.data.comment));
    this.on('decide', 'Alerts', req => {
      const key = req.params[0];
      return applyDecision(req, typeof key === 'object' ? key.ID : key, req.data.decision, req.data.comment);
    });

    this.on('verifyAuditChain', async () => {
      const rows = await cds.run(SELECT.from(E.AuditLog).orderBy('idx asc'));
      let prev = '';
      for (const r of rows) {
        const expected = U.auditHash(r.idx, r.ts, r.checkId || '', r.action, r.detail || '', prev);
        if (r.prevHash !== prev || r.hash !== expected) return JSON.stringify({ ok: false, entries: rows.length, brokenAt: r.idx });
        prev = r.hash;
      }
      return JSON.stringify({ ok: true, entries: rows.length, brokenAt: null });
    });

    return super.init();
  }
};
