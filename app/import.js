'use strict';
// S/4HANA extract import, the signed-in user in the header, and hidden fields the PDF reader can fill.
// Uses helpers from app.js: api, state, renderS4Table and $.
(async () => {
  try {
    const who = await api('whoami', null, 'GET');
    $('who').textContent = `Signed in as ${who.id} (${who.roles.join(', ') || 'no role'})`;
  } catch (e) {
    $('who').textContent = '';
  }
})();

// Hidden fields: the VAT amount and the buyer tax ID are read from the PDF, but the form does not show them.
for (const name of ['vat', 'buyerTaxId']) {
  if (!$('invForm').elements[name]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    $('invForm').appendChild(input);
  }
}

$('btnImport').addEventListener('click', async () => {
  const msg = $('s4Msg');
  const file = $('s4File').files[0];
  if (!file) { msg.className = 'msg error'; msg.textContent = 'Choose the extract file first.'; return; }
  msg.className = 'msg'; msg.textContent = 'Importing...';
  try {
    const out = await api('importS4Extract', { fileName: file.name, content: await file.text() });
    state.s4 = out.invoices;
    state.s4Results = [];
    $('btnCheckAll').disabled = false;
    msg.textContent = `${out.count} rows imported from ${file.name}. Press Check all.`;
    renderS4Table();
  } catch (e) {
    msg.className = 'msg error'; msg.textContent = e.message;
  }
});
