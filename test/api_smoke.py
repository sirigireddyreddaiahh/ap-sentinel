"""End-to-end check of the running CAP service (local only).

Start the server first:  npx cds deploy --to sqlite && npx cds serve --port 4004
Then run:                python3 test/api_smoke.py
Set CAP_BASE to test another URL. A deployed URL needs a login token, so this script is for local runs.
"""
import base64, json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("CAP_BASE", "http://localhost:4004/fraud/")
USER = os.environ.get("CAP_USER", "reviewer")
PASS = os.environ.get("CAP_PASS", "reviewer")
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "samples")

def call(name, body=None, method="POST"):
    data = json.dumps(body).encode() if method == "POST" else None
    req = urllib.request.Request(BASE + name + ("" if method == "POST" else "()"), data=data, method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": AUTH})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return {"HTTP": e.code, "body": e.read().decode()[:300]}

def val(p):
    v = p.get("value", p) if isinstance(p, dict) else p
    return json.loads(v) if isinstance(v, str) else v

fails = []
def check(ok, msg):
    print(("  PASS  " if ok else "  FAIL  ") + msg)
    if not ok: fails.append(msg)

def pdf_b64(name):
    return base64.b64encode(open(os.path.join(SAMPLES, name), "rb").read()).decode()

print("1. Fetch from S/4HANA (mock)")
s4 = val(call("fetchS4Invoices", method="GET"))
check(len(s4) == 10, f"10 invoices fetched (got {len(s4)})")

print("2. Check all and compare with expected outcomes")
expected = {"S4-0001": "PASS", "S4-0002": "REJECT", "S4-0003": "PASS", "S4-0004": "HOLD", "S4-0005": "HOLD",
            "S4-0006": "HOLD", "S4-0007": "HOLD", "S4-0008": "FLAG", "S4-0009": "REJECT", "S4-0010": "HOLD"}
for r in val(call("checkBatch", {"invoices": json.dumps(s4)})):
    check(r["status"] == expected[r["id"]], f'{r["id"]} -> {r["status"]} (expected {expected[r["id"]]})')

print("3. Upload a clean text PDF and read its fields")
ex = val(call("extractPdf", {"fileName": "sample-invoice-clean.pdf", "pdfBase64": pdf_b64("sample-invoice-clean.pdf")}))
f = ex["fields"]
check(f.get("invoiceNo") == "SSFS/2026/0412", f'invoice no: {f.get("invoiceNo")}')
check(f.get("invoiceDate") == "2026-10-20", f'date to ISO: {f.get("invoiceDate")}')
check(f.get("total") == 59000 and f.get("cgst") == 4500 and f.get("sgst") == 4500, "amounts read")
check(ex.get("warning") is None, "no scanned-PDF warning")

print("4. Check the reviewed invoice")
inv = dict(f, source="UPLOAD", fileName=ex["fileName"], pdfText=ex["pdfText"], pdfMeta=ex["pdfMeta"],
           category="services", sesDone=True)
res = val(call("checkInvoice", {"invoice": json.dumps(inv)}))
check(res["status"] == "PASS", f'uploaded clean invoice -> {res["status"]}')

print("5. Post it, then post it again (should be refused as a duplicate of itself)")
p1 = val(call("postInvoice", {"invoice": json.dumps(inv)}))
check(p1.get("posted") is True, "first post succeeds")
p2 = val(call("postInvoice", {"invoice": json.dumps(inv)}))
check(p2.get("posted") is False and p2.get("status") == "REJECT", f'second post refused ({p2.get("status")})')

print("6. Upload a duplicate-number invoice (matches the posted seed)")
ex2 = val(call("extractPdf", {"fileName": "sample-invoice-duplicate.pdf", "pdfBase64": pdf_b64("sample-invoice-duplicate.pdf")}))
inv2 = dict(ex2["fields"], source="UPLOAD", pdfText=ex2["pdfText"], pdfMeta=ex2["pdfMeta"], category="goods", grDone=True)
r2 = val(call("checkInvoice", {"invoice": json.dumps(inv2)}))
check(r2["status"] == "REJECT" and any(x["id"] == "AP-02" and x["tier"] == "REJECT" for x in r2["results"]), f'duplicate -> {r2["status"]} via AP-02')

print("7. Upload an arithmetic-error invoice")
ex3 = val(call("extractPdf", {"fileName": "sample-invoice-bad-total.pdf", "pdfBase64": pdf_b64("sample-invoice-bad-total.pdf")}))
inv3 = dict(ex3["fields"], source="UPLOAD", pdfText=ex3["pdfText"], pdfMeta=ex3["pdfMeta"], category="services", sesDone=True)
r3 = val(call("checkInvoice", {"invoice": json.dumps(inv3)}))
check(r3["status"] == "HOLD" and any(x["id"] == "AP-08" and x["tier"] == "HOLD" for x in r3["results"]), f'bad total -> {r3["status"]} via AP-08')
hold = next(x for x in r3["results"] if x["id"] == "AP-08" and x["tier"] == "HOLD")

print("8. Review decisions")
ok = call("decideAlert", {"alertId": hold["alertId"], "decision": "CONFIRM", "comment": "Total is wrong on the printed invoice; vendor asked to re-issue."})
check("HTTP" not in ok, "CONFIRM with a comment accepted")
check(call("decideAlert", {"alertId": hold["alertId"], "decision": "CLEAR", "comment": "   "}).get("HTTP") == 400, "decision without a comment refused (400)")
dup = next(x for x in r2["results"] if x["id"] == "AP-02")
check(call("decideAlert", {"alertId": dup["alertId"], "decision": "CLEAR", "comment": "looks fine"}).get("HTTP") == 409, "clearing a REJECT refused (409)")

print("9. Audit chain integrity")
v = val(call("verifyAuditChain", method="GET"))
check(v.get("ok") is True, f'audit chain intact ({v.get("entries")} entries)')

print("\nRESULT:", "ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED")
sys.exit(1 if fails else 0)
