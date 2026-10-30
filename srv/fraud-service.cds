using { ap } from '../db/schema';

// Any signed-in user can call the service. Role-based restrictions come later (for example Reviewer, AP Clerk).
@path: '/fraud'
@requires: 'authenticated-user'
service FraudService {
  @readonly entity Checks   as projection on ap.Checks;
  @readonly entity Alerts   as projection on ap.Alerts;
  @readonly entity Posted   as projection on ap.Posted;
  @readonly entity AuditLog as projection on ap.AuditLog;

  // Screen 2: invoices from the S/4HANA extract (mock data in this starter)
  function fetchS4Invoices() returns LargeString;

  // Screen 1: read a PDF and return the fields it can find (text PDFs only)
  action extractPdf(fileName : String, pdfBase64 : LargeString) returns LargeString;

  // Both screens: run the rules
  action checkInvoice(invoice : LargeString) returns LargeString;
  action checkBatch(invoices : LargeString) returns LargeString;

  // Post to the ledger if not REJECT; HOLD posts with a payment block
  action postInvoice(invoice : LargeString) returns LargeString;

  // Reviewer decision on one alert. Comment is mandatory. REJECT cannot be cleared.
  action decideAlert(alertId : String, decision : String, comment : String) returns LargeString;

  // Recompute the audit hash chain and report whether it is intact
  function verifyAuditChain() returns LargeString;
}
