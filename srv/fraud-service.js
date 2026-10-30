'use strict';
const cds = require('@sap/cds');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pdfText } = require('./lib/pdftext');
const U = require('./rules/util');
const { runRules } = require('./rules/engine');
const { extractFields, readPdfMeta } = require('./lib/extract');

const masters = require('../data/masters.json');
const s4Invoices = require('../data/s4-invoices.json');

const NUMERIC = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'total'];

// IRP public key: from an environment variable, or from config/irp-public-key.pem if present.
function loadIrpKey() {
  if (process.env.IRP_PUBLIC_KEY_PEM) return process.env.IRP_PUBLIC_KEY_PEM;
  const f = path.join(__dirname, '..', 'config', 'irp-public-key.pem');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
}

// Accepts a JSON string or object from the UI and normalises it.
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

const publicView = (inv) => { const { pdfText, ...rest } = inv; return rest; };

function isRecurring(inv) {
  const po = inv.poNumber ? (masters.purchaseOrders || []).find(p => String(p.po) === String(inv.poNumber)) : null;
  return !!(po && po.recurring);
}

module.exports = class FraudService extends cds.ApplicationService {
  async init() {
    const { Checks, Alerts, Posted, AuditLog } = this.entities;

    const audit = async (action, checkId, detail) => {
      const last = await cds.run(SELECT.one.from(AuditLog).orderBy('idx desc'));
      const idx = last ? last.idx + 1 : 1;
      const prevHash = last ? last.hash : '';
      const ts = new Date().toISOString();
      const hash = U.auditHash(idx, ts, checkId || '', action, detail || '', prevHash);
      await cds.run(INSERT.into(AuditLog).entries({
        idx, ts, action, checkId: checkId || null, detail: String(detail || '').slice(0, 1000), prevHash, hash,
      }));
    };

    const persist = async (inv, result, source) => {
      const checkId = crypto.randomUUID();
      await cds.run(INSERT.into(Checks).entries({
        ID: checkId, source, fileName: inv.fileName || null, supplierName: inv.supplierName || null,
        supplierGstin: inv.supplierGstin || null, invoiceNo: inv.invoiceNo || null,
        invoiceDate: inv.invoiceDate || null, total: inv.total ?? null,
        status: result.status, resultJson: JSON.stringify(result),
      }));
      const alerts = result.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier));
      for (const r of alerts) {
        r.alertId = crypto.randomUUID();
        await cds.run(INSERT.into(Alerts).entries({
          ID: r.alertId, check_ID: checkId, ruleId: r.id, title: r.title, tier: r.tier, text: r.text, decision: 'OPEN',
        }));
      }
      await audit('CHECK', checkId, `${result.status} ${inv.invoiceNo || ''}: ${alerts.map(a => a.id).join(', ') || 'no alerts'}`);
      return checkId;
    };

    this.on('fetchS4Invoices', () => JSON.stringify(s4Invoices));

    this.on('extractPdf', async req => {
      const { fileName, pdfBase64 } = req.data;
      const buf = Buffer.from(pdfBase64 || '', 'base64');
      if (buf.length < 5 || buf.subarray(0, 4).toString('latin1') !== '%PDF') return req.reject(400, 'The file is not a PDF');
      let text;
      try { text = await pdfText(buf); }
      catch (e) { return req.reject(400, 'The PDF could not be read: ' + e.message); }
      return JSON.stringify({
        fileName,
        fields: extractFields(text),
        pdfText: text,
        pdfMeta: readPdfMeta(buf),
        warning: text ? null : 'No text layer found. This looks like a scanned PDF. OCR is a Phase 2 item; enter the fields manually.',
      });
    });

    this.on('checkInvoice', async req => {
      const inv = parseInvoice(req.data.invoice);
      const posted = await cds.run(SELECT.from(Posted));
      const result = runRules(inv, { masters, posted, batch: [], earlier: [], irpPublicKeyPem: loadIrpKey() });
      const checkId = await persist(inv, result, inv.source || 'UPLOAD');
      return JSON.stringify({ checkId, ...result, invoice: publicView(inv) });
    });

    this.on('checkBatch', async req => {
      const list = JSON.parse(req.data.invoices).map(parseInvoice);
      const posted = await cds.run(SELECT.from(Posted));
      const key = loadIrpKey();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const inv = list[i];
        const result = runRules(inv, { masters, posted, batch: list, earlier: list.slice(0, i), irpPublicKeyPem: key });
        const checkId = await persist(inv, result, 'S4');
        out.push({ id: inv.id, checkId, ...result, invoice: publicView(inv) });
      }
      return JSON.stringify(out);
    });

    this.on('postInvoice', async req => {
      const inv = parseInvoice(req.data.invoice);
      const posted = await cds.run(SELECT.from(Posted));
      const result = runRules(inv, { masters, posted, batch: [], earlier: [], irpPublicKeyPem: loadIrpKey() });
      if (result.results.some(r => r.id === 'INPUT')) return req.reject(400, 'Complete the invoice fields before posting');
      const checkId = await persist(inv, result, inv.source || 'UPLOAD');
      if (result.status === 'REJECT') {
        await audit('POST_BLOCKED', checkId, `Not posted (REJECT): ${inv.invoiceNo}`);
        return JSON.stringify({ posted: false, blocked: false, checkId, ...result });
      }
      const blocked = result.status === 'HOLD';
      await cds.run(INSERT.into(Posted).entries({
        invoiceNo: inv.invoiceNo, supplierGstin: inv.supplierGstin, invoiceDate: inv.invoiceDate,
        total: inv.total, description: inv.description || '', irn: inv.irn || null, blocked,
        recurringPo: isRecurring(inv), postedAt: new Date().toISOString(),
      }));
      await audit('POST', checkId, `Posted ${inv.invoiceNo}${blocked ? ' (payment blocked)' : ''}`);
      return JSON.stringify({ posted: true, blocked, checkId, ...result });
    });

    this.on('decideAlert', async req => {
      const { alertId, decision, comment } = req.data;
      if (!['CLEAR', 'CONFIRM', 'ESCALATE'].includes(decision)) return req.reject(400, 'Decision must be CLEAR, CONFIRM or ESCALATE');
      if (!comment || !String(comment).trim()) return req.reject(400, 'A comment is required for every decision');
      const alert = await cds.run(SELECT.one.from(Alerts).where({ ID: alertId }));
      if (!alert) return req.reject(404, 'Alert not found');
      if (alert.tier === 'REJECT' && decision === 'CLEAR') return req.reject(409, 'A REJECT is final and cannot be cleared');
      const who = (req.user && req.user.id) || 'reviewer';
      const text = String(comment).trim();
      await cds.run(UPDATE(Alerts).set({ decision, comment: text, decidedBy: who, decidedAt: new Date().toISOString() }).where({ ID: alertId }));
      await audit('DECISION', alert.check_ID, `${alert.ruleId} ${decision} by ${who}: ${text}`);
      return JSON.stringify({ alertId, decision, decidedBy: who });
    });

    this.on('verifyAuditChain', async () => {
      const rows = await cds.run(SELECT.from(AuditLog).orderBy('idx asc'));
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
