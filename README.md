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
