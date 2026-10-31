using { ap } from '../db/schema';

// Roles. APClerk prepares and posts invoices. APController checks and decides holds. Auditor reads only.
@path: '/fraud'
@requires: ['APClerk', 'APController', 'Auditor']
service FraudService {
  @readonly entity Checks as projection on ap.Checks;
  @readonly entity CheckResults as projection on ap.CheckResults;
  @readonly entity Alerts as projection on ap.Alerts actions {
    @requires: 'APController'
    action decide(decision : String, comment : String) returns LargeString;
  };
  @readonly entity Posted as projection on ap.Posted;
  @readonly entity AuditLog as projection on ap.AuditLog;

  function whoami() returns LargeString;

  @requires: ['APClerk', 'APController'] function fetchS4Invoices() returns LargeString;
  @requires: ['APClerk', 'APController'] action importS4Extract(fileName : String, content : LargeString) returns LargeString;
  @requires: ['APClerk', 'APController'] action extractPdf(fileName : String, pdfBase64 : LargeString) returns LargeString;
  @requires: ['APClerk', 'APController'] action checkInvoice(invoice : LargeString) returns LargeString;
  @requires: ['APClerk', 'APController'] action checkBatch(invoices : LargeString) returns LargeString;
  @requires: 'APClerk' action postInvoice(invoice : LargeString) returns LargeString;
  @requires: 'APController' action decideAlert(alertId : String, decision : String, comment : String) returns LargeString;
  @requires: ['APController', 'Auditor'] function verifyAuditChain() returns LargeString;
}
