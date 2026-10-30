'use strict';
// Plain JavaScript UI, no build step. All server text is written with textContent (no innerHTML).
const state = { pdf: null, fileName: null, s4: [], s4Results: [], lastInvoice: null };

// Calls a CAP action or function under /fraud and returns the parsed result.
async function api(action, body, method = 'POST') {
  const opts = { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (method === 'POST') opts.body = JSON.stringify(body || {});
  const url = '/fraud/' + action + (method === 'GET' ? '()' : '');
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || ('Request failed (' + r.status + ')'));
  const v = data.value !== undefined ? data.value : data;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
const money = (n) => (n === undefined || n === null || n === '') ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
}));

// ---------- screen 1: upload and check ----------
const form = $('invForm');

function readForm() {
  const f = new FormData(form);
  const inv = {};
  for (const [k, v] of f.entries()) {
    if (k === 'receipt' || k === 'category') continue;
    if (String(v).trim() !== '') inv[k] = String(v).trim();
  }
  const category = f.get('category');
  inv.category = category;
  const r = f.get('receipt');
  const received = r === 'yes' ? true : r === 'no' ? false : undefined;
  if (received !== undefined) {
    if (category === 'goods') inv.grDone = received; else inv.sesDone = received;
  }
  if (state.pdf) Object.assign(inv, state.pdf);
  inv.source = state.pdf ? 'UPLOAD' : 'MANUAL';
  inv.fileName = state.fileName || null;
  return inv;
}

function fillForm(fields) {
  for (const [k, v] of Object.entries(fields)) {
    const input = form.elements[k];
    if (input && input.tagName !== 'SELECT') input.value = v;
  }
}

$('btnExtract').addEventListener('click', async () => {
  const msg = $('extractMsg');
  const file = $('pdfFile').files[0];
  msg.className = 'msg';
  if (!file) { msg.textContent = 'Choose a PDF file first.'; msg.className = 'msg error'; return; }
  msg.textContent = 'Reading PDF...';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.readAsDataURL(file);
    });
    const out = await api('extractPdf', { fileName: file.name, pdfBase64: b64 });
    state.fileName = out.fileName;
    state.pdf = { pdfText: out.pdfText, pdfMeta: out.pdfMeta };
    fillForm(out.fields);
    msg.textContent = out.warning ? out.warning : 'Fields read from the PDF. Review them, then press Check.';
    if (out.warning) msg.className = 'msg error';
    $('btnPostUpload').disabled = true;
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg error';
  }
});

$('btnCheck').addEventListener('click', async () => {
  try {
    const inv = readForm();
    const res = await api('checkInvoice', { invoice: JSON.stringify(inv) });
    state.lastInvoice = inv;
    renderResult($('resultUpload'), res, 'Invoice ' + (inv.invoiceNo || ''), { canPost: true, postBtn: $('btnPostUpload') });
  } catch (e) {
    alert(e.message);
  }
});

$('btnPostUpload').addEventListener('click', async () => {
  if (!state.lastInvoice) return;
  try {
    const out = await api('postInvoice', { invoice: JSON.stringify(state.lastInvoice) });
    const note = out.posted ? (out.blocked ? 'Posted with a payment block (HOLD).' : 'Posted to the ledger.') : 'Not posted: this is a REJECT.';
    alert(note);
  } catch (e) {
    alert(e.message);
  }
});

// ---------- screen 2: S/4HANA fetch and batch check ----------
$('btnFetch').addEventListener('click', async () => {
  const msg = $('s4Msg');
  msg.className = 'msg'; msg.textContent = 'Fetching...';
  try {
    state.s4 = await api('fetchS4Invoices', null, 'GET');
    state.s4Results = [];
    msg.textContent = state.s4.length + ' invoices fetched. Press Check all.';
    $('btnCheckAll').disabled = false;
    renderS4Table();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg error';
  }
});

$('btnCheckAll').addEventListener('click', async () => {
  const msg = $('s4Msg');
  msg.className = 'msg'; msg.textContent = 'Checking...';
  try {
    state.s4Results = await api('checkBatch', { invoices: JSON.stringify(state.s4) });
    msg.textContent = 'Checked ' + state.s4Results.length + ' invoices. Click a row for the reasons.';
    renderS4Table();
  } catch (e) {
    msg.textContent = e.message; msg.className = 'msg error';
  }
});

function renderS4Table() {
  const tbody = document.querySelector('#s4Table tbody');
  tbody.textContent = '';
  state.s4.forEach((inv, i) => {
    const res = state.s4Results.find(r => r.id === inv.id);
    const tr = document.createElement('tr');
    tr.append(el('td', inv.id), el('td', inv.supplierName), el('td', inv.invoiceNo), el('td', inv.invoiceDate),
      el('td', money(inv.total), 'num'), el('td', inv.poNumber || '-'));
    const st = document.createElement('td');
    st.append(res ? el('span', res.status, 'badge ' + res.status) : el('span', 'not checked', ''));
    tr.append(st);
    const reasons = res ? res.results.filter(r => ['REJECT', 'HOLD', 'FLAG'].includes(r.tier)).map(r => r.id).join(', ') : '';
    tr.append(el('td', reasons || '-'));
    tr.addEventListener('click', () => {
      if (!res) { $('s4Msg').textContent = 'Press Check all first.'; return; }
      state.lastInvoice = inv;
      renderResult($('resultS4'), res, 'Invoice ' + inv.invoiceNo, { canPost: true, postBtn: null, invoice: inv });
      $('resultS4').scrollIntoView({ behavior: 'smooth' });
    });
    tbody.append(tr);
  });
}

// ---------- shared result panel ----------
function renderResult(container, res, title, opts = {}) {
  container.classList.remove('hidden');
  container.textContent = '';
  const head = el('div', null, 'row');
  head.append(el('h2', title + '  '), el('span', res.status, 'badge ' + res.status));
  container.append(head);

  if (res.posted === true) container.append(el('p', res.blocked ? 'Posted with a payment block.' : 'Posted to the ledger.', 'hint'));
  if (res.posted === false) container.append(el('p', 'Not posted. A REJECT cannot be posted.', 'hint'));

  const list = el('ul', null, 'results');
  for (const r of res.results) {
    const li = document.createElement('li');
    li.append(el('div', r.id, 'rid'), el('div', r.title, 'rtitle'));
    li.append(el('div', r.text, 'rtext'));
    li.append(el('span', r.tier, 'badge ' + r.tier));
    if (['REJECT', 'HOLD', 'FLAG'].includes(r.tier) && r.alertId) li.append(decisionBox(r));
    list.append(li);
  }
  container.append(list);

  if (opts.canPost && res.status !== 'REJECT') {
    const b = el('button', 'Post to ledger', 'primary');
    b.style.marginTop = '10px';
    b.addEventListener('click', async () => {
      try {
        const inv = opts.invoice || state.lastInvoice;
        const out = await api('postInvoice', { invoice: JSON.stringify(inv) });
        container.append(el('p', out.posted ? (out.blocked ? 'Posted with a payment block.' : 'Posted to the ledger.') : 'Not posted.', 'hint'));
        b.disabled = true;
      } catch (e) { alert(e.message); }
    });
    container.append(b);
  }
}

function decisionBox(r) {
  const wrap = el('div', null, 'decide');
  const input = el('input', null, 'comment');
  input.placeholder = 'Comment (required)';
  const make = (label, decision) => {
    const b = el('button', label);
    b.addEventListener('click', async () => {
      const comment = input.value.trim();
      if (!comment) { input.focus(); input.placeholder = 'Type a comment first'; return; }
      try {
        const out = await api('decideAlert', { alertId: r.alertId, decision, comment });
        wrap.textContent = '';
        wrap.append(el('span', 'Recorded: ' + out.decision + ' by ' + out.decidedBy, 'done'));
      } catch (e) { alert(e.message); }
    });
    return b;
  };
  if (r.tier !== 'REJECT') wrap.append(make('Clear', 'CLEAR'));
  wrap.append(make('Confirm', 'CONFIRM'), make('Escalate', 'ESCALATE'), input);
  return wrap;
}
