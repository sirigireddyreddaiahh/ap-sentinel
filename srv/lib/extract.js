'use strict';
// Best-effort field extraction from text PDFs. Every field is shown to the user for review before any check.
const GSTIN_G = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;

const first = (text, re) => { const m = text.match(re); return m ? m[1].trim() : null; };
const money = (text, re) => { const v = first(text, re); return v === null ? undefined : Number(v.replace(/,/g, '')); };

function toIsoDate(s) {
  if (!s) return null;
  const dmy = s.match(/^(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function extractFields(text) {
  const t = text || '';
  const gstins = [...new Set(t.match(GSTIN_G) || [])];
  const fields = {
    supplierName: first(t, /(?:supplier|seller)\s*(?:name)?\s*[:\-]\s*(.+)/i),
    supplierGstin: gstins[0],
    buyerGstin: gstins[1],
    invoiceNo: first(t, /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i),
    invoiceDate: toIsoDate(first(t, /invoice\s*date\s*[:\-]\s*(\d{2}[\/\-.]\d{2}[\/\-.]\d{4}|\d{4}-\d{2}-\d{2})/i)),
    poNumber: first(t, /\bPO\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{6,12})\b/i),
    description: first(t, /description\s*[:\-]\s*(.{3,160})/i),
    hsn: first(t, /(?:HSN|SAC)\s*(?:code)?\s*[:\-]?\s*(\d{4,8})/i),
    taxable: money(t, /taxable\s*(?:value|amount)\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i),
    cgst: money(t, /cgst[^\n]*?([\d,]+\.\d{2})/i),
    sgst: money(t, /sgst[^\n]*?([\d,]+\.\d{2})/i),
    igst: money(t, /igst[^\n]*?([\d,]+\.\d{2})/i),
    total: money(t, /total\s*(?:amount|value|payable)?\s*[:\-]\s*(?:INR|Rs\.?)?\s*([\d,]+\.\d{2})/i),
    ifsc: first(t, /\b([A-Z]{4}0[A-Z0-9]{6})\b/),
    accountNo: first(t, /(?:a\/c|account)\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{9,18})/i),
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined || fields[k] === null) delete fields[k];
  return fields;
}

// Reads the PDF info dictionary as text. Best effort; compressed metadata may be missed.
function readPdfMeta(buf) {
  const s = buf.toString('latin1');
  const p = s.match(/\/Producer\s*\(([^)]*)\)/);
  const c = s.match(/\/Creator\s*\(([^)]*)\)/);
  return { producer: p ? p[1] : '', creator: c ? c[1] : '' };
}

module.exports = { extractFields, readPdfMeta, toIsoDate };
