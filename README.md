# AP Sentinel: starter build

Invoice fraud and duplicate checks for Bluspring's accounts payable, built on SAP BTP (CAP, Node.js).
This is a **starter**. It runs locally with sample data. It has not yet been deployed to a BTP account.

## What is in this folder

| Folder / file | What it is |
|---|---|
| `srv/rules/` | The 14 rules from spec v2 (AP-01 to AP-14), the engine, and utilities. Pure functions, no database, no AI. |
| `srv/fraud-service.cds/.js` | The CAP service: fetch S/4 invoices, read a PDF, check, check all, post, review decisions, audit check. |
| `srv/lib/` | PDF text reading (pdf.js) and field extraction for text PDFs. |
| `db/schema.cds`, `db/data/` | Data model (Checks, Alerts, Posted, AuditLog) and the seed of posted invoices. |
| `app/` | The two screens (plain HTML and JavaScript, no build step). |
| `data/` | Sample masters and the mock S/4HANA invoice extract. Replace with Bluspring files. |
| `samples/` | Three sample PDFs for testing the upload screen. |
| `test/rules.test.js` | 12 unit tests for the rules. |
| `test/api_smoke.py` | 24 end-to-end checks against the running service (local). |
| `mta.yaml`, `xs-security.json`, `approuter/` | Cloud Foundry deployment files for BTP: service, HANA container, XSUAA login, approuter. |

## What has been tested

- **Rules:** 12 unit tests pass (`npm test`). They cover the GSTIN check character (checked against a published sample GSTIN), duplicates, arithmetic and GST split, look-alikes, splitting, bank collisions, the e-invoice QR signature (with a generated RSA key), and more.
- **Service:** 24 end-to-end checks pass against the running CAP server with a fresh SQLite database.
- **Production build:** `npx cds build --production` succeeds.
- **Not tested:** the BTP deployment itself, the approuter login flow, and clicking through the UI in a browser. These are the first things to check after you deploy.

## Run it locally

```bash
npm install
npm test                      # 12 rule tests
npm run watch                 # starts the server on http://localhost:4004 (delete db.sqlite to reset local data)
```

Open http://localhost:4004 and sign in with **reviewer / reviewer** (local login only). Then:

1. **Screen 1, Upload and check:** choose a PDF from `samples/`, press *Upload and read*, review the fields, press *Check*. Then *Post to ledger* if the result is not REJECT.
2. **Screen 2, Fetch from Bluspring (S/4HANA):** press *Fetch invoices*, then *Check all*. Click a row to see the reasons, and to record a review decision.

To run the end-to-end checks while the server is up: `python3 test/api_smoke.py`

## The rules (spec v2)

| ID | Rule | Outcome when it fires |
|---|---|---|
| AP-01 | e-Invoice QR signature and content | REJECT if the signature fails or the IRN is bound to another invoice. HOLD if content differs. |
| AP-02 | Exact duplicate (IRN, or GSTIN + financial year + normalised number) | REJECT |
| AP-03 | GSTIN format and check character; status from the status file | REJECT if invalid. HOLD if cancelled or suspended. FLAG if unknown. |
| AP-04 | Buyer GSTIN is a Bluspring entity | HOLD |
| AP-05 | Bank details match the vendor master | HOLD |
| AP-06 | Bank account used by a customer, employee, or another supplier | HOLD |
| AP-07 | PO exists, date order, goods receipt, service entry sheet | HOLD |
| AP-08 | Taxable plus tax equals total; intrastate and interstate split; rate from master | HOLD (FLAG if the rate is missing from the master) |
| AP-09 | Same supplier, same amount, similar description, within 90 days (not a recurring PO) | HOLD |
| AP-10 | Same supplier, same amount, similar number, within 10 days | HOLD |
| AP-11 | Three or more invoices just below an approval limit, totalling over it, within 14 days | HOLD |
| AP-12 | Instruction-like wording in the PDF text (possible prompt injection) | HOLD, routed to security |
| AP-13 | PDF produced by a design tool | FLAG only |
| AP-14 | Dated on a Sunday or a holiday in the file | FLAG only |

Overall status: REJECT beats HOLD, which beats FLAG, which beats PASS. A rule that throws an error becomes a HOLD for a person to check. It never passes silently.

## Going from sample data to Bluspring data

- `data/masters.json`: entities and GSTINs, vendors and bank details, customers and employees, group accounts, purchase orders, GSTIN status, rate master (HSN/SAC), approval levels (DoA), holidays, design-tool list, PO policy. Every value in the sample file is made up except the checksum logic.
- `data/s4-invoices.json`: the mock S/4 extract. Replace it with the real extract, or with the live connection once API access is agreed.
- `db/data/ap-Posted.csv`: the seed of already-posted invoices, used to test duplicates.
- `config/irp-public-key.pem` (or the `IRP_PUBLIC_KEY_PEM` variable): the IRP public key for AP-01.

## Deploy to SAP BTP (trial, Cloud Foundry)

I have not run these steps on your account. They follow the generated `mta.yaml`. Expect small fixes on the first run, and send me the error text if anything fails.

1. **Check the HANA Cloud instance is running** (`ap-sentinel-db`, in space `dev`). Trial instances stop when idle. Start it from the `tools` subscription if needed.
2. **Log in to Cloud Foundry.** Copy the API endpoint from the subaccount overview (Cloud Foundry Environment section), then:
   ```bash
   cf login -a <API endpoint> 
   cf target -s dev
   cf install-plugin multiapps    # if cf deploy is not already available
   npm install -g mbt             # if mbt is not already available
   ```
3. **Only if deployment reports several HANA instances or no database:** find the instance ID and add it to `mta.yaml`:
   ```bash
   cf service ap-sentinel-db --guid
   ```
   Then, under the `ap-sentinel-db` resource in `mta.yaml`, add:
   ```yaml
   parameters:
     service: hana
     service-plan: hdi-shared
     config:
       database_id: <GUID from the command above>
   ```
4. **Build:** `mbt build`. This creates `mta_archives/ap-sentinel_0.1.0.mtar`.
5. **Deploy:** `cf deploy mta_archives/ap-sentinel_0.1.0.mtar`.
6. **Open the app:** `cf apps` shows the route of the `ap-sentinel` approuter. Open it and sign in with your trial user.

Likely first-run issues: the XSUAA or HDI entitlements are missing from the trial subaccount (check Entitlements), or the approuter route needs a change. Send me the exact error and the output of `cf logs ap-sentinel-srv --recent`.

## Put the project in GitHub

Your repository is `sirigireddyreddaiahh/ap-sentinel` (private).

- **Without git:** unzip this folder on your computer. Open the repository page, press *Add file*, then *Upload files*, and drag in the contents. Do not upload `node_modules`. Commit.
- **With git:**
  ```bash
  git clone https://github.com/sirigireddyreddaiahh/ap-sentinel.git
  cd ap-sentinel
  # copy the contents of this folder into here
  git add .
  git commit -m "Starter: rules engine, two screens, BTP deployment files"
  git push
  ```
  For a private repository, GitHub asks for a personal access token in place of a password.

## Design points to confirm with Bluspring

These are decisions I made where the spec left the answer open:

- **Blacklist:** a blacklisted supplier gives HOLD. The spec does not say which tier to use.
- **HOLD invoices:** they are posted with a payment block, so they count as posted for duplicate checks.
- **PO policy:** a PO is required for every invoice by default (`policy.poRequired`).
- **Approval levels:** 1,00,000 and 5,00,000 are sample values only.
- **GST rates:** the rate master has two sample HSN/SAC codes at 18%. The cess list is empty.
- **Ledger scope:** the duplicate ledger covers all five entities together, as spec v2 requires.
- **Review decisions:** CLEAR, CONFIRM and ESCALATE are all recorded. A REJECT cannot be cleared.

## Known limits (be clear about these with stakeholders)

1. **No QR decoding from the PDF image yet.** AP-01 runs only when an IRN QR payload is supplied. For a PDF upload it shows SKIPPED. Reading the QR from the page needs image rendering and a QR decoder, and is the next technical step.
2. **Scanned PDFs are not read.** A PDF without a text layer gets a warning. Enter the fields by hand. OCR is a later phase.
3. **Field extraction is pattern-based** and is tuned to the sample layouts. Real invoices will need adjustments. Every field is shown for review before any check.
4. **Hidden text is not checked.** AP-12 reads the extracted text only, not zero-opacity text in the PDF.
5. **Access is not role-based yet.** Any signed-in user can use every screen. Reviewer and controller roles come next.
6. **The audit chain is stored in the same database.** Spec v2 asks for external anchoring (write-once storage), which is not built yet. The chain check (`verifyAuditChain`) only shows that the stored records are consistent with each other.
7. **Nothing is written back to S/4HANA.** The posted ledger is internal to this app.
8. **The UI is plain HTML and JavaScript, not Fiori.** It is good enough to test the flow. A Fiori List Report and Object Page can replace it later.
9. **PDFs are not stored.** The app keeps the extracted fields, the results, and the review decisions.

## Security notes

- The service requires a signed-in user (`@requires: 'authenticated-user'`). In production, sign-in uses XSUAA through the approuter.
- The local login (`reviewer` / `reviewer`) applies only to `cds watch` and `cds serve` on your computer. It is not used in production.
- The IRP key and any HANA credentials stay out of GitHub. `.gitignore` excludes them.
# ap-sentinel

## Round 2 update

The original starter-build guide above is preserved. This section adds the round 2 capabilities and replaces the round 1 limitations where noted.

### What changed

| Round 1 limitation | Round 2 |
|---|---|
| QR codes were not read from PDFs, so AP-01 showed SKIPPED. | QR codes are read from the first two pages. An IRN JWS signature is verified offline, and AP-01 checks it against the invoice. |
| Scanned PDFs were not read. | Pages without a text layer are read by English OCR; the screen identifies fields sourced from OCR. |
| S/4HANA data was a mock. | Import an S/4HANA export as CSV using `data/s4-import-template.csv`. The mock remains available as the sample extract. |
| Every signed-in user could use every screen. | The service defines APClerk, APController and Auditor roles; see the role table below. |
| The UI was plain HTML only. | The review queue is a Fiori Elements app at `/alerts/index.html`; upload and import remain HTML. |

### Roles

| Role | Permissions |
|---|---|
| APClerk | Import and read extracts, upload PDFs, check invoices, and post to the ledger. |
| APController | Check invoices, read everything, and decide review items (Clear, Confirm, Escalate). |
| Auditor | Read checks, results, alerts, posted invoices and the audit log; verify the audit chain. |

Other calls are expected to receive 403. On BTP, create role collections from the APClerk, APController and Auditor role templates and assign them to users.

### Round 2 local run and smoke tests

```bash
npm install
npm test
npm run watch            # http://localhost:4004
```

With the server running:

```bash
python3 test/api_smoke.py
python3 test/rbac_import_smoke.py
```

Local development users are `reviewer` (all roles), `clerk`, `controller` and `auditor`; each user's password is the username.

Optional environment variables:

- `IRP_PUBLIC_KEY_PEM`: IRP public key in PEM format. Without it, AP-01 shows SKIPPED, not PASS. The key can also be placed at `config/irp-public-key.pem`.
- `TESSDATA_PATH`: directory containing `eng.traineddata`. Without it, tesseract.js downloads the model on first use, requiring internet access.

### Reading invoices and review queue

- **PDF upload:** the text layer is read first. The first two pages are rendered and checked for a QR code. Pages without text are processed by OCR. Extracted fields remain editable for review before checking.
- **S/4HANA extract:** import the CSV and press Check all. Splits and look-alikes are checked across the batch.
- Receipts use Y or N (GR for goods, SES for services). Dates accept YYYY-MM-DD or DD/MM/YYYY.
- `/alerts/index.html` is a Fiori Elements List Report and Object Page generated from `srv/annotations.cds`. Its Decide action is bound to each alert. UI5 is loaded from ui5.sap.com, so the browser needs internet access.

### Round 2 deployment notes

- Keep the round 2 `package-lock.json` aligned with `package.json`; for reproducible builds, run `npm install` in Business Application Studio and commit the lock file.
- Set the IRP key on the service with `cf set-env ap-sentinel-srv IRP_PUBLIC_KEY_PEM "<PEM text>"`, then restart the app.
- OCR needs `eng.traineddata`. Include it in the app and set `TESSDATA_PATH`, or allow outbound access for the default model download.

### Round 2 known limits

1. QR reading was tested with a test signing key, not a real IRP-signed invoice.
2. A live S/4HANA OData connection is not built; CSV file import is the current route.
3. OCR was tested on clean rendered text; real scans still need testing.
4. The screens do not hide buttons by role. The server is expected to enforce permissions, so unauthorized actions should return 403.
5. The Fiori review queue has not been rendered in a browser. Fiori check-history and upload apps are not built.
6. Field patterns in `srv/lib/extract.js` match sample invoices; real layouts will need adjustments.
7. Hidden text in PDFs is not checked; AP-12 reads only extracted text.
8. The audit chain is stored in the same database; external anchoring is not built.
9. Nothing is written back to S/4HANA; the posted ledger is internal.

### Round 2 files

New: `srv/annotations.cds`, `srv/lib/pdfimage.js`, `srv/lib/ocr.js`, `srv/lib/csv.js`, `app/import.js`, `app/alerts/` (`index.html`, `Component.js`, `manifest.json`), `test/qr.test.js`, `test/csv.test.js`, `test/rbac_import_smoke.py`, `samples/s4-export-sample.csv`, and `data/s4-import-template.csv`.

Changed: `package.json`, `package-lock.json`, `mta.yaml`, `xs-security.json`, `db/schema.cds`, `srv/fraud-service.cds`, `srv/fraud-service.js`, `app/index.html`, and `README.md`.

## Round 3 update

This section records the round 3 additions; where it differs from the round 2 notes above, this is the current status.

### What's in place

- **PDF reading:** the text layer is read first, followed by QR decoding (with offline IRN signature verification) and OCR for scanned pages. In the 100-PDF batch described below, extraction matched the ground truth for eight fields on all 100 invoices.
- **AP-08 tax check:** VAT-style invoices are held as "not GST". Indian B2B invoices need CGST and SGST, or IGST.
- **S/4HANA import:** import a CSV using `data/s4-import-template.csv`; the sample extract is for demos.
- **Role enforcement:** APClerk can prepare and post, APController can check and decide holds, and Auditor is read-only. The server enforces roles.
- **Fiori apps:** the review queue is at `/alerts/index.html`; check history, including all 14 rule results for each check, is at `/checks/index.html`.

### Batch-checking PDFs

Run the batch script with a folder of PDFs and a CSV containing expected values:

```bash
npm run batch -- "path/to/pdfs" "path/to/batch_1.csv" --out report.json
```

The script reports read errors, statuses, rule hits and field accuracy. Keep test PDFs out of the repository if they contain real data.

### Round 3 batch results

The 100-PDF batch had no read errors, and extraction matched the ground truth for invoice number, invoice date, supplier name, supplier GSTIN, total, taxable value, VAT and buyer tax ID on all 100 invoices. The live upload/check flow succeeded for all 100. All were REJECT because the seller GSTIN check character was invalid; AP-04, AP-07 and AP-08 also held all invoices. These invoices used VAT rather than Indian GST, had no buyer GSTIN, and had no PO reference. This batch had no QR codes and needed no OCR, so it does not validate AP-01 against real IRN codes or OCR on scans. See `docs/batch-test-report.md` for scope and rule details.

### Round 3 local run and deployment

```bash
npm install
npm test
npm run watch            # http://localhost:4004
```

With the server running, run `python3 test/api_smoke.py` and `python3 test/rbac_import_smoke.py` for the end-to-end and role/import checks. Local development users are `reviewer` (all roles), `clerk`, `controller` and `auditor`; each user's password is the username.

For reproducible builds, run `npm install` in Business Application Studio and commit the resulting `package-lock.json`; the lock file described by the round 3 archive predates round 2. Set `IRP_PUBLIC_KEY_PEM` on the service and create role collections from the APClerk, APController and Auditor role templates.

### Round 3 known limits

1. The batch used no QR codes, so AP-01 was not exercised on real IRP invoices. QR tests use a test signing key.
2. Line items are not extracted; the rules do not use them except for the description used by AP-09.
3. A live S/4HANA OData connection is not built; CSV import is the current route.
4. The screens do not hide buttons by role; the server enforces permissions.
5. The Fiori apps have not been rendered in a browser.
6. Extraction patterns are tuned to the tested layouts; new supplier layouts may need new patterns.
7. Hidden text in PDFs is not checked; AP-12 reads extracted text.
8. The audit chain is stored in the same database; external anchoring is not built.
9. Nothing is written back to S/4HANA; the posted ledger is internal.
