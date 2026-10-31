'use strict';
// Best-effort field extraction from text PDFs. Every field is shown for review before any check.
const GSTIN_G = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const first = (text, re) => { const m = text.match(re); return m ? m[1].trim() : null; };
const money = (text, re) => { const v = first(text, re); return v === null ? undefined : Number(v.replace(/,/g, '')); };
const num = (s) => Number(String(s).replace(/,/g, ''));

// Dates: 03/07/2023 (day first), 3-7-2023, 3.7.2023, 2023-07-03, 3 Jul 2023
function toIsoDate(s) {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  const mon = m && MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

const DATE_RE = /(?:invoice\s*date|date\s*of\s*issue|date\s*of\s*invoice|date)\s*[:\-]\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})/i;
// Tax summary row of a VAT-style invoice: rate, net, VAT, gross
const SUMMARY_RE = /(\d{1,2}(?:\.\d+)?)\s*%\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})/;

function extractFields(text) {
  const t = text || '';
  const gstins = [...new Set(t.match(GSTIN_G) || [])];
  const taxIds = [...t.matchAll(/tax\s*id\s*[:\-]\s*([A-Za-z0-9\-\/]+)/gi)].map(m => m[1]);
  const isVatStyle = /\bVAT\b/i.test(t) && !/\b(CGST|SGST|IGST)\b/i.test(t);
  const sum = isVatStyle ? t.match(SUMMARY_RE) : null;
  const fields = {
    supplierName: first(t, /(?:supplier|seller)\s*(?:name)?\s*[:\-]\s*(.+)/i),
    supplierGstin: gstins[0],
    buyerGstin: gstins[1],
    buyerTaxId: taxIds.find(id => id !== gstins[0]),
    invoiceNo: first(t, /invoice\s*(?:no\.?|number|#)\s*[:\-]?\s*([A-Za-z0-9\/\-]+)/i),
    invoiceDate: toIsoDate(first(t, DATE_RE)),
    poNumber: first(t, /\bPO\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{6,12})\b/i),
    description: first(t, /description\s*[:\-]\s*(.{3,160})/i),
    hsn: first(t, /(?:HSN|SAC)\s*(?:code)?\s*[:\-]?\s*(\d{4,8})/i),
    taxable: sum ? num(sum[2]) : money(t, /taxable\s*(?:value|amount)\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.?\d*)/i),
    vat: sum ? num(sum[3]) : undefined,
    cgst: money(t, /cgst[^\n]*?([\d,]+\.\d{2})/i),
    sgst: money(t, /sgst[^\n]*?([\d,]+\.\d{2})/i),
    igst: money(t, /igst[^\n]*?([\d,]+\.\d{2})/i),
    total: sum ? num(sum[4])
      : (money(t, /(?:grand\s*total|total\s*amount\s*payable|amount\s*payable|gross\s*(?:worth|total|amount))\s*[:\-]?\s*(?:INR|Rs\.?)?\s*([\d,]+\.\d{2})/i)
        ?? money(t, /total\s*(?:amount|value)?\s*[:\-]\s*(?:INR|Rs\.?)?\s*([\d,]+\.\d{2})/i)),
    ifsc: first(t, /\b([A-Z]{4}0[A-Z0-9]{6})\b/),
    accountNo: first(t, /(?:a\/c|account)\s*(?:no\.?|number)?\s*[:\-]?\s*(\d{9,18})/i),
  };
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined || fields[k] === null || Number.isNaN(fields[k])) delete fields[k];
  }
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
