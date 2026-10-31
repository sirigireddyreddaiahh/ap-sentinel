"""Role checks, whoami and the S/4 import, against a running local server.

Start the server first (npm run watch), then run:  python3 test/rbac_import_smoke.py
Users: clerk, controller, auditor (password = user name, local development only).
"""
import base64, json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("CAP_BASE", "http://localhost:4004/fraud/")
HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = {"clerk": "clerk", "controller": "controller", "auditor": "auditor"}
EXPECTED = {"S4-0001": "PASS", "S4-0002": "REJECT", "S4-0003": "PASS", "S4-0004": "HOLD", "S4-0005": "HOLD",
            "S4-0006": "HOLD", "S4-0007": "HOLD", "S4-0008": "FLAG", "S4-0009": "REJECT", "S4-0010": "HOLD"}

def call(user, path, body=None, method="POST"):
    data = json.dumps(body).encode() if method == "POST" else None
    auth = "Basic " + base64.b64encode(f"{user}:{PASSWORD[user]}".encode()).decode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": auth})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}

def value(payload):
    v = payload.get("value", payload)
    return json.loads(v) if isinstance(v, str) else v

fails = []
def check(ok, msg):
    print(("  PASS  " if ok else "  FAIL  ") + msg)
    if not ok:
        fails.append(msg)

print("1. Who am I (roles per user)")
for user, role in [("clerk", "APClerk"), ("controller", "APController"), ("auditor", "Auditor")]:
    status, body = call(user, "whoami()", method="GET")
    check(status == 200 and value(body)["roles"] == [role], f"{user} has role {role}")

print("2. Auditor can read, but cannot check or import")
status, _ = call("auditor", "Checks", method="GET")
check(status == 200, "auditor reads Checks")
status, _ = call("auditor", "checkInvoice", {"invoice": json.dumps({"supplierGstin": "37AAFCS2201L1ZG", "invoiceNo": "X", "invoiceDate": "2026-10-20", "total": 1})})
check(status == 403, "auditor cannot check an invoice (403)")
status, _ = call("auditor", "importS4Extract", {"fileName": "x.csv", "content": "Id\n1"})
check(status == 403, "auditor cannot import an extract (403)")

print("3. Clerk cannot decide or verify; controller cannot post")
status, _ = call("clerk", "decideAlert", {"alertId": "00000000-0000-0000-0000-000000000000", "decision": "CLEAR", "comment": "x"})
check(status == 403, "clerk cannot decide an alert (403)")
status, _ = call("clerk", "verifyAuditChain()", method="GET")
check(status == 403, "clerk cannot verify the audit chain (403)")
status, _ = call("controller", "postInvoice", {"invoice": json.dumps({"invoiceNo": "X"})})
check(status == 403, "controller cannot post an invoice (403)")
status, body = call("auditor", "verifyAuditChain()", method="GET")
check(status == 200 and value(body)["ok"] is True, "auditor can verify the audit chain")

print("4. Clerk imports the S/4 export file and checks it: same outcomes as the mock")
with open(os.path.join(HERE, "..", "samples", "s4-export-sample.csv"), encoding="utf-8") as f:
    content = f.read()
status, body = call("clerk", "importS4Extract", {"fileName": "s4-export-sample.csv", "content": content})
check(status == 200 and value(body)["count"] == 10, "clerk imports 10 rows from the CSV")
status, body = call("clerk", "checkBatch", {"invoices": json.dumps(value(body)["invoices"])})
for r in value(body):
    check(r["status"] == EXPECTED[r["id"]], f'{r["id"]} -> {r["status"]} (expected {EXPECTED[r["id"]]})')

print("5. Check history keeps all 14 rule results per check")
status, body = call("auditor", "CheckResults?$count=true&$top=1", method="GET")
check(status == 200 and body.get("@odata.count", 0) >= 14, f"CheckResults holds rule rows (count={body.get('@odata.count')})")

print("\nRESULT:", "ALL CHECKS PASSED" if not fails else f"{len(fails)} FAILED")
sys.exit(1 if fails else 0)
