# Batch test report: invoice PDFs (Batch 1)

Run on 31 Oct 2026 with `scripts/batch-check.js` and against the live upload endpoint.

## Scope

- 100 PDFs (the archive holds 100 files, not 150).
- Every file has one page and a text layer. No file contains a QR code, and no OCR was needed.
- Ground truth: a CSV with the expected fields and line items for each PDF.
- All 100 invoices come from one seller. The seller's GSTIN has the right format but a wrong check character.

## Results

| Check | Result |
|---|---|
| PDFs read | 100 of 100, no read errors |
| Live upload endpoint (extract, then check) | 100 of 100 succeeded, no server errors, 100 check records stored |
| Fields matched to ground truth | 100% on invoice number, invoice date, supplier name, supplier GSTIN, total, taxable value, VAT, buyer tax ID |
| Overall status as delivered | REJECT on all 100 |

Rules that fired (invoices affected):

| Rule | Tier | Count | Why |
|---|---|---|---|
| AP-03 GSTIN validity | REJECT | 100 | Check character fails. The GSTIN ends in 5; the checksum requires Q. |
| AP-04 Addressee | HOLD | 100 | No buyer GSTIN on the invoice. The buyer has a tax ID in a non-GST format. |
| AP-07 PO and receipt | HOLD | 100 | No PO reference. |
| AP-08 Arithmetic and GST | HOLD | 100 | Tax is shown as VAT (10%), not CGST and SGST or IGST. |
| AP-14 Calendar | FLAG | 16 | Dated on a Sunday or a holiday. |

## What the same invoices would show with a valid GSTIN

Replacing only the check character (a what-if, not a change to the PDFs): all 100 move from REJECT to HOLD. The blocking rules are AP-04, AP-07 and AP-08, as above.

## Not exercised by this batch

- AP-01 (QR signature): no QR codes in the batch.
- AP-05 and AP-06 (bank checks): the invoices carry no bank details, so these rules are skipped.
- AP-02, AP-09, AP-10, AP-11 (duplicates and patterns): they ran, and none fired.
- AP-12 (hidden text): ran, and nothing was found.

## Reading the results

- The application runs without errors on this set, and its field extraction matches the ground truth.
- The invoices are not valid Indian GST tax invoices, so the application is right to reject or hold them. The data looks synthetic: one seller, VAT at 10%, buyer tax IDs in a US-style format.
- To test the PASS path, use GST invoices from Bluspring's real suppliers, with buyer GSTINs, POs, and vendor bank details in the masters.
- Line items are not extracted. The rules do not use them, except the description for AP-09.
