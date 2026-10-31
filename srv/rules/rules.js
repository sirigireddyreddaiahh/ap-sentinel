'use strict';
// AP Sentinel rule catalogue, spec v2.0 (AP-01 to AP-14).
// Each rule returns { tier, text } where tier is REJECT | HOLD | FLAG | PASS | SKIPPED.
// Rules are pure functions: no database, no network, no AI.
const crypto = require('crypto');
const U = require('./util');

const TOL_TOTAL = 1.0;      // INR, spec v2 AP-08
const TOL_RATE_PCT = 0.1;   // percentage points

const findVendor = (masters, inv) =>
  (masters.vendors || []).find(v => U.norm(v.gstin) === U.norm(inv.supplierGstin)) ||
  (masters.vendors || []).find(v => inv.supplierId && v.id === inv.supplierId);

const findPo = (masters, inv) =>
  inv.poNumber ? (masters.purchaseOrders || []).find(p => String(p.po) === String(inv.poNumber)) : undefined;

const sameSupplier = (a, b) => U.norm(a.supplierGstin || a.supplierId) === U.norm(b.supplierGstin || b.supplierId);

// Other invoices in the window: posted ledger plus the rest of the batch being checked.
const others = (inv, ctx) => [...(ctx.posted || []), ...((ctx.batch || []).filter(b => b !== inv))];

// Offline verification of an IRP signed QR payload (JWS, RS256 only).
function verifyIrpJwt(token, pem) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
  let header;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'unreadable header' }; }
  if (header.alg !== 'RS256') return { ok: false, reason: `algorithm ${header.alg} is not allowed` };
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(parts[0] + '.' + parts[1]);
  verifier.end();
  if (!verifier.verify(pem, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'signature does not match the IRP key' };
  try { return { ok: true, payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) }; }
  catch { return { ok: false, reason: 'unreadable payload' }; }
}

// ---------- AP-01 e-Invoice QR signature and content ----------
function ap01(inv, ctx) {
  if (!inv.qrJwt) return { tier: 'SKIPPED', text: 'No IRN QR code on the invoice. This check applies to e-invoiced B2B invoices only.' };
  if (!ctx.irpPublicKeyPem) return { tier: 'SKIPPED', text: 'QR code found, but the IRP public key is not configured, so the signature was not verified.' };
  const v = verifyIrpJwt(inv.qrJwt, ctx.irpPublicKeyPem);
  if (!v.ok) return { tier: 'REJECT', text: `QR signature check failed (${v.reason}). The invoice cannot be trusted as an e-invoice.` };
  const p = v.payload;
  const irn = p.Irn || inv.irn;
  const boundElsewhere = irn && (ctx.posted || []).find(x => x.irn === irn && U.normInvoiceNo(x.invoiceNo) !== U.normInvoiceNo(inv.invoiceNo));
  if (boundElsewhere) return { tier: 'REJECT', text: `IRN ${irn} is already bound to a different posted invoice (${boundElsewhere.invoiceNo}). Possible QR code reuse.` };
  const diffs = [];
  if (U.norm(p.SellerGstin) !== U.norm(inv.supplierGstin)) diffs.push('supplier GSTIN');
  if (U.norm(p.BuyerGstin) !== U.norm(inv.buyerGstin)) diffs.push('buyer GSTIN');
  if (U.normInvoiceNo(p.DocNo) !== U.normInvoiceNo(inv.invoiceNo)) diffs.push('invoice number');
  if (Math.abs(Number(p.TotInvVal) - U.num(inv.total)) > TOL_TOTAL) diffs.push('total value');
  if (diffs.length) return { tier: 'HOLD', text: `QR content does not match the invoice fields: ${diffs.join(', ')}. Check the printed invoice manually.` };
  return { tier: 'PASS', text: 'QR signature is valid and the QR content matches the invoice.' };
}

// ---------- AP-02 Exact duplicate (and blacklist note from spec) ----------
function ap02(inv, ctx) {
  const key = U.dupKeyOf(inv);
  const pool = [...(ctx.posted || []), ...(ctx.earlier || [])];
  const hit = pool.find(p => U.dupKeyOf(p) === key || (inv.irn && p.irn && p.irn === inv.irn));
  if (hit) {
    return { tier: 'REJECT', text: `Duplicate: invoice ${inv.invoiceNo} from ${inv.supplierGstin || inv.supplierId} already exists in FY ${U.fiscalYear(inv.invoiceDate)} as ${hit.invoiceNo} dated ${hit.invoiceDate}. Not posted.` };
  }
  const bl = (ctx.masters.blacklistGstins || []).map(U.norm);
  if (bl.includes(U.norm(inv.supplierGstin))) {
    return { tier: 'HOLD', text: `No duplicate, but supplier ${U.norm(inv.supplierGstin)} is on the internal blacklist. Tier for blacklist hits is a design point to confirm.` };
  }
  return { tier: 'PASS', text: 'No duplicate found for this supplier and financial year.' };
}

// ---------- AP-03 GSTIN validity ----------
function ap03(inv, ctx) {
  const g = U.norm(inv.supplierGstin);
  if (!g) return { tier: 'HOLD', text: 'Supplier GSTIN is missing from the invoice.' };
  if (!U.isValidGstin(g)) return { tier: 'REJECT', text: `GSTIN ${g} is not valid (format or check character fails).` };
  const status = (ctx.masters.gstinStatus || {})[g];
  if (!status) return { tier: 'FLAG', text: `GSTIN ${g} is valid in format, but its status is not in the status file. Check the GST portal.` };
  if (String(status).toLowerCase() !== 'active') return { tier: 'HOLD', text: `GSTIN ${g} has status "${status}" in the status file. Verify before payment.` };
  return { tier: 'PASS', text: `GSTIN ${g} is valid and Active in the status file.` };
}

// ---------- AP-04 Addressee (buyer) check ----------
function ap04(inv, ctx) {
  const b = U.norm(inv.buyerGstin);
  if (!b) return { tier: 'HOLD', text: 'Buyer GSTIN is missing from the invoice.' };
  const ent = (ctx.masters.entities || []).find(e => (e.gstins || []).includes(b));
  if (!ent) return { tier: 'HOLD', text: `Buyer GSTIN ${b} is not one of the Bluspring entity GSTINs in the mapping table. Route to the tax team.` };
  return { tier: 'PASS', text: `Invoice is addressed to ${ent.name} (${ent.code}).` };
}

// ---------- AP-05 Bank details changed vs master (BEC) ----------
function ap05(inv, ctx) {
  if (!inv.ifsc && !inv.accountNo) return { tier: 'SKIPPED', text: 'No bank details on the invoice, so the bank check does not apply.' };
  const v = findVendor(ctx.masters, inv);
  if (!v) return { tier: 'HOLD', text: 'Supplier is not in the vendor master, so its bank details cannot be verified.' };
  if (inv.ifsc && !U.IFSC_RE.test(U.norm(inv.ifsc))) return { tier: 'HOLD', text: `IFSC ${inv.ifsc} on the invoice has an invalid format.` };
  const ifscDiff = inv.ifsc && U.norm(inv.ifsc) !== U.norm(v.ifsc);
  const accDiff = inv.accountNo && U.normAcct(inv.accountNo) !== U.normAcct(v.account);
  if (ifscDiff || accDiff) {
    const what = [ifscDiff ? 'IFSC' : '', accDiff ? 'account number' : ''].filter(Boolean).join(' and ');
    return { tier: 'HOLD', text: `Bank details on the invoice do not match the vendor master (${what}). Verify by call-back to the number already on file.` };
  }
  return { tier: 'PASS', text: 'Bank details match the vendor master.' };
}

// ---------- AP-06 Bank account collision ----------
function ap06(inv, ctx) {
  const acct = U.normAcct(inv.accountNo);
  if (!acct) return { tier: 'SKIPPED', text: 'No bank account on the invoice, so the collision check does not apply.' };
  if ((ctx.masters.groupAccounts || []).map(U.normAcct).includes(acct)) {
    return { tier: 'PASS', text: 'Account is an approved group account (excluded from the collision check).' };
  }
  const hits = [];
  (ctx.masters.customers || []).forEach(c => { if (U.normAcct(c.account) === acct) hits.push(`customer ${c.name}`); });
  (ctx.masters.employees || []).forEach(e => { if (U.normAcct(e.account) === acct) hits.push(`employee ${e.name}`); });
  (ctx.masters.vendors || []).forEach(v => {
    if (U.normAcct(v.account) === acct && U.norm(v.gstin) !== U.norm(inv.supplierGstin)) hits.push(`another supplier ${v.name}`);
  });
  if (hits.length) return { tier: 'HOLD', text: `Bank account is also used by ${hits.join(', ')}. Possible kickback or payment redirection. Review.` };
  return { tier: 'PASS', text: 'Bank account does not collide with customer, employee, or other supplier accounts.' };
}

// ---------- AP-07 PO and receipt control ----------
function ap07(inv, ctx) {
  const problems = [];
  const poRequired = (ctx.masters.policy || {}).poRequired !== false;
  if (!inv.poNumber) {
    if (poRequired) problems.push('no purchase order reference on the invoice');
  } else {
    const po = findPo(ctx.masters, inv);
    if (!po) problems.push(`PO ${inv.poNumber} is not in the PO extract`);
    else {
      const hoursBefore = (Date.parse(po.date + 'T00:00:00Z') - Date.parse(inv.invoiceDate + 'T00:00:00Z')) / 3600000;
      if (hoursBefore > 48) problems.push(`invoice dated ${inv.invoiceDate} is more than 48 hours before PO ${po.po} (dated ${po.date})`);
    }
  }
  if (inv.category === 'goods' && inv.grDone === false) problems.push('no goods receipt against the PO');
  if (inv.category === 'services' && inv.sesDone === false) problems.push('no service entry sheet against the PO');
  if (problems.length) return { tier: 'HOLD', text: `PO or receipt check failed: ${problems.join('; ')}.` };
  return { tier: 'PASS', text: 'PO and receipt checks passed (or receipt status was not supplied).' };
}

// ---------- AP-08 Arithmetic and GST tax ----------
function ap08(inv, ctx) {
  const taxable = U.num(inv.taxable), cgst = U.num(inv.cgst), sgst = U.num(inv.sgst);
  const igst = U.num(inv.igst), cess = U.num(inv.cess), vat = U.num(inv.vat), total = U.num(inv.total);
  const issues = [];
  const computed = taxable + cgst + sgst + igst + cess + vat;
  if (Math.abs(computed - total) > TOL_TOTAL) issues.push(`taxable plus tax is ${computed.toFixed(2)} but total is ${total.toFixed(2)}`);
  if (vat > 0) issues.push(`tax is shown as VAT (${vat.toFixed(2)}), not GST. Indian B2B invoices need CGST and SGST, or IGST`);
  const intra = U.stateOf(inv.supplierGstin) === U.stateOf(inv.buyerGstin);
  if (intra) {
    if (igst > 0) issues.push('intrastate invoice shows IGST');
    if (Math.abs(cgst - sgst) > TOL_TOTAL) issues.push('CGST and SGST differ');
  } else if (cgst > 0 || sgst > 0) {
    issues.push('interstate invoice shows CGST or SGST instead of IGST');
  }
  let rateNote = null;
  if (taxable > 0 && inv.hsn) {
    const rate = (ctx.masters.rates || {})[String(inv.hsn)];
    if (rate === undefined) rateNote = `HSN/SAC ${inv.hsn} is not in the rate master`;
    else {
      const eff = (cgst + sgst + igst) / taxable * 100;
      if (Math.abs(eff - rate) > TOL_RATE_PCT) issues.push(`effective tax rate ${eff.toFixed(2)}% differs from ${rate}% for HSN/SAC ${inv.hsn}`);
    }
  }
  if (cess > 0 && !(ctx.masters.cessApplicable || []).includes(String(inv.hsn))) issues.push('cess applied but HSN/SAC is not on the cess list');
  if (issues.length) return { tier: 'HOLD', text: `Tax or arithmetic check failed: ${issues.join('; ')}.` };
  if (rateNote) return { tier: 'FLAG', text: `Totals are consistent, but ${rateNote}. Tax team to confirm the rate.` };
  return { tier: 'PASS', text: 'Totals and tax split are consistent with the rate master.' };
}

// ---------- AP-09 Recurring look-alike ----------
function ap09(inv, ctx) {
  const po = findPo(ctx.masters, inv);
  if (po && po.recurring) return { tier: 'PASS', text: `Matched to recurring contract PO ${po.po}. Look-alike check skipped.` };
  const hit = others(inv, ctx).find(h =>
    sameSupplier(h, inv) &&
    U.num(h.total) === U.num(inv.total) &&
    U.daysBetween(h.invoiceDate, inv.invoiceDate) <= 90 &&
    U.normInvoiceNo(h.invoiceNo) !== U.normInvoiceNo(inv.invoiceNo) &&
    U.similarity(h.description, inv.description) >= 0.9);
  if (hit) return { tier: 'HOLD', text: `Same supplier, same amount and similar description within 90 days (${hit.invoiceNo} dated ${hit.invoiceDate}). Not matched to a recurring contract PO.` };
  return { tier: 'PASS', text: 'No similar invoice from this supplier within 90 days.' };
}

// ---------- AP-10 Lookalike resubmission ----------
function ap10(inv, ctx) {
  const a = U.normInvoiceNo(inv.invoiceNo);
  const hit = others(inv, ctx).find(h => {
    if (!sameSupplier(h, inv)) return false;
    if (Math.abs(U.num(h.total) - U.num(inv.total)) > 1.5) return false;
    if (U.daysBetween(h.invoiceDate, inv.invoiceDate) > 10) return false;
    const b = U.normInvoiceNo(h.invoiceNo);
    return b !== a && (b.startsWith(a) || a.startsWith(b) || U.similarity(a, b) >= 0.8);
  });
  if (hit) return { tier: 'HOLD', text: `Possible resubmission: same supplier and amount, with a similar invoice number (${hit.invoiceNo} dated ${hit.invoiceDate}) within 10 days.` };
  return { tier: 'PASS', text: 'No lookalike resubmission found.' };
}

// ---------- AP-11 Threshold splitting ----------
function ap11(inv, ctx) {
  const levels = ((ctx.masters.doa || {}).levels || []).slice().sort((x, y) => x - y);
  const WINDOW = 14, PROXIMITY = 0.05, MIN_COUNT = 3;
  const pool = [...(ctx.posted || []), ...(ctx.batch || [])];
  if (!pool.includes(inv)) pool.push(inv);
  const same = pool.filter(h => sameSupplier(h, inv) && U.daysBetween(h.invoiceDate, inv.invoiceDate) <= WINDOW);
  for (const limit of levels) {
    const band = same.filter(h => U.num(h.total) >= limit * (1 - PROXIMITY) && U.num(h.total) < limit);
    if (band.includes(inv) && band.length >= MIN_COUNT) {
      const sum = band.reduce((s, h) => s + U.num(h.total), 0);
      if (sum >= limit) {
        return { tier: 'HOLD', text: `Possible split: ${band.length} invoices from this supplier within ${WINDOW} days, each just below the approval limit of ${limit}, totalling ${sum.toFixed(2)}.` };
      }
    }
  }
  return { tier: 'PASS', text: 'No split pattern against the approval limits.' };
}

// ---------- AP-12 Hidden or adversarial text (text-level check only) ----------
const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous |prior |above )?(instructions|constraints|rules)/i,
  /auto[- ]?approve/i,
  /do not (flag|reject|hold|report)/i,
  /(system|developer) prompt/i,
];
function ap12(inv) {
  if (!inv.pdfText) return { tier: 'SKIPPED', text: 'No PDF text available (manual entry or S/4HANA extract).' };
  if (INJECTION_PATTERNS.some(r => r.test(inv.pdfText))) {
    return { tier: 'HOLD', text: 'Instruction-like wording found in the document text (possible prompt injection). Route to security review. The document was not passed to any automated approver.' };
  }
  return { tier: 'PASS', text: 'No instruction-like wording in the extracted text. Zero-opacity hidden-text detection is not in this starter.' };
}

// ---------- AP-13 PDF metadata signal (FLAG only) ----------
function ap13(inv, ctx) {
  if (!inv.pdfMeta || (!inv.pdfMeta.producer && !inv.pdfMeta.creator)) return { tier: 'SKIPPED', text: 'No PDF metadata available.' };
  const s = `${inv.pdfMeta.producer} ${inv.pdfMeta.creator}`.toLowerCase();
  const tool = (ctx.masters.pdfDesignTools || []).find(t => s.includes(t.toLowerCase()));
  if (tool) return { tier: 'FLAG', text: `PDF was produced with "${tool}". Many legitimate vendors use design tools. Informational only.` };
  return { tier: 'PASS', text: 'PDF metadata shows no design-tool producer.' };
}

// ---------- AP-14 Calendar anomaly (FLAG only) ----------
function ap14(inv, ctx) {
  const notes = [];
  if (U.isSunday(inv.invoiceDate)) notes.push('dated on a Sunday');
  if ((ctx.masters.holidays || []).includes(inv.invoiceDate)) notes.push('dated on a holiday in the holiday file');
  if (notes.length) return { tier: 'FLAG', text: `Invoice is ${notes.join(' and ')}. Informational only.` };
  return { tier: 'PASS', text: 'Invoice date is a working day.' };
}

const RULES = [
  { id: 'AP-01', title: 'e-Invoice QR signature and content', run: ap01 },
  { id: 'AP-02', title: 'Exact duplicate', run: ap02 },
  { id: 'AP-03', title: 'GSTIN validity', run: ap03 },
  { id: 'AP-04', title: 'Addressee (buyer) check', run: ap04 },
  { id: 'AP-05', title: 'Bank details changed vs master', run: ap05 },
  { id: 'AP-06', title: 'Bank account collision', run: ap06 },
  { id: 'AP-07', title: 'PO and receipt control', run: ap07 },
  { id: 'AP-08', title: 'Arithmetic and GST tax', run: ap08 },
  { id: 'AP-09', title: 'Recurring look-alike', run: ap09 },
  { id: 'AP-10', title: 'Lookalike resubmission', run: ap10 },
  { id: 'AP-11', title: 'Threshold splitting', run: ap11 },
  { id: 'AP-12', title: 'Hidden or adversarial text in PDF', run: ap12 },
  { id: 'AP-13', title: 'PDF metadata signal', run: ap13 },
  { id: 'AP-14', title: 'Calendar anomaly', run: ap14 },
];

module.exports = { RULES, verifyIrpJwt, findVendor };
