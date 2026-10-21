-- Local DB as written by @humanagencyp/erp-mcp 0.9.5 (pre-snapshot schema).
-- Generated once with the 0.9.5 code; archive paths use __DATA_DIR__ as placeholder.
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE local_customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address_lines TEXT NOT NULL,
  country TEXT NOT NULL,
  uid TEXT,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE local_numbers (
  number TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('invoice', 'credit_note')),
  document_id TEXT NOT NULL,
  issued_at TEXT NOT NULL
);
CREATE TABLE local_invoices (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES local_customers(id),
  status TEXT CHECK(status IN ('issued','partially_credited','credited')) NOT NULL DEFAULT 'issued',
  currency TEXT NOT NULL,
  net_total REAL NOT NULL,
  vat_total REAL NOT NULL,
  gross_total REAL NOT NULL,
  credited_total REAL NOT NULL DEFAULT 0,
  tax_mode TEXT CHECK(tax_mode IN ('normal','reverse_charge','kleinunternehmer')) NOT NULL,
  payment_term_days INTEGER NOT NULL DEFAULT 14,
  service_period_from TEXT NOT NULL,
  service_period_to TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  due_date TEXT NOT NULL,
  memo TEXT,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_fingerprint TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  ticket_id TEXT
);
CREATE TABLE local_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES local_invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  line_net REAL NOT NULL,
  line_vat REAL NOT NULL,
  line_gross REAL NOT NULL
);
CREATE TABLE local_credit_notes (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  invoice_id TEXT NOT NULL REFERENCES local_invoices(id),
  invoice_number TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES local_customers(id),
  currency TEXT NOT NULL,
  net_total REAL NOT NULL,
  vat_total REAL NOT NULL,
  gross_total REAL NOT NULL,
  reason TEXT NOT NULL,
  service_period_from TEXT NOT NULL,
  service_period_to TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  template_fingerprint TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  ticket_id TEXT
);
CREATE TABLE local_credit_note_lines (
  id TEXT PRIMARY KEY,
  credit_note_id TEXT NOT NULL REFERENCES local_credit_notes(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price REAL NOT NULL,
  vat_rate REAL NOT NULL,
  line_net REAL NOT NULL,
  line_vat REAL NOT NULL,
  line_gross REAL NOT NULL
);
INSERT INTO local_customers (id, name, address_lines, country, uid, email, created_at) VALUES ('c-at-0001', 'Drautal Maschinenbau GmbH', '["Industriestraße 12","9800 Spittal an der Drau","Österreich"]', 'AT', 'ATU12345678', 'buchhaltung@drautal.example', '2026-10-21 10:16:46');
INSERT INTO local_customers (id, name, address_lines, country, uid, email, created_at) VALUES ('c-de-0001', 'Kessler Anlagenbau GmbH', '["Hafenstraße 4","20457 Hamburg","Deutschland"]', 'DE', 'DE123456789', 'ap@kessler.example', '2026-10-21 10:16:46');
INSERT INTO local_customers (id, name, address_lines, country, uid, email, created_at) VALUES ('c-at-0002', 'Huber Werbetechnik e.U.', '["Hauptplatz 3","4020 Linz","Österreich"]', 'AT', NULL, 'huber@werbetechnik.example', '2026-10-21 10:16:46');
INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES ('F-2026-001', 'invoice', '0956683f-f041-4505-a75a-9f2f2cef7698', '2026-10-21T00:00:00.000Z');
INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES ('F-2026-002', 'invoice', 'c8cb97ad-d180-4fab-a11e-f9e890de12b1', '2026-10-21T00:00:00.000Z');
INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES ('F-2026-003', 'invoice', '7202e28a-f190-4f43-b435-55b5dbcdc653', '2026-10-21T00:00:00.000Z');
INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES ('F-2026-004', 'credit_note', 'd387b7a5-b405-4549-a656-68a0b3afa2b2', '2026-10-21T00:00:00.000Z');
INSERT INTO local_numbers (number, kind, document_id, issued_at) VALUES ('F-2026-005', 'credit_note', '595141c9-50f0-4b40-a173-cdaeb3c0a00a', '2026-10-21T00:00:00.000Z');
INSERT INTO local_invoices (id, number, customer_id, status, currency, net_total, vat_total, gross_total, credited_total, tax_mode, payment_term_days, service_period_from, service_period_to, issued_at, due_date, memo, template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id) VALUES ('0956683f-f041-4505-a75a-9f2f2cef7698', 'F-2026-001', 'c-at-0001', 'partially_credited', 'EUR', 320, 64, 384, 80, 'normal', 14, '2026-10-06', '2026-10-24', '2026-10-21T00:00:00.000Z', '2026-11-04T00:00:00.000Z', 'fixture', 'rechnung-de', '4', '1ac700d6eb37a605a7ea744c512a706e59143913cc899e9d419b70ae0821f1a9', '__DATA_DIR__/erp-local-archive/2026/F-2026-001.pdf', 'd6dfba774987f73daf697df7479c0890ba924fadc1ebf4fafee729c18899cfe7', NULL);
INSERT INTO local_invoices (id, number, customer_id, status, currency, net_total, vat_total, gross_total, credited_total, tax_mode, payment_term_days, service_period_from, service_period_to, issued_at, due_date, memo, template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id) VALUES ('c8cb97ad-d180-4fab-a11e-f9e890de12b1', 'F-2026-002', 'c-de-0001', 'credited', 'EUR', 1500, 0, 1500, 1500, 'reverse_charge', 14, '2026-10-06', '2026-10-24', '2026-10-21T00:00:00.000Z', '2026-11-04T00:00:00.000Z', NULL, 'rechnung-de', '4', '1ac700d6eb37a605a7ea744c512a706e59143913cc899e9d419b70ae0821f1a9', '__DATA_DIR__/erp-local-archive/2026/F-2026-002.pdf', 'e108ab91f6a945e8a5334755445c919bde5dd101c925064b15ced2ccb00fe99d', NULL);
INSERT INTO local_invoices (id, number, customer_id, status, currency, net_total, vat_total, gross_total, credited_total, tax_mode, payment_term_days, service_period_from, service_period_to, issued_at, due_date, memo, template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id) VALUES ('7202e28a-f190-4f43-b435-55b5dbcdc653', 'F-2026-003', 'c-at-0002', 'issued', 'EUR', 150, 30, 180, 0, 'normal', 14, '2026-10-06', '2026-10-24', '2026-10-21T00:00:00.000Z', '2026-11-04T00:00:00.000Z', NULL, 'rechnung-de', '4', '1ac700d6eb37a605a7ea744c512a706e59143913cc899e9d419b70ae0821f1a9', '__DATA_DIR__/erp-local-archive/2026/F-2026-003.pdf', '4151df235f03d8aa6b83a36b09ced2dafb2cfd554d5e7c89cf46db1f10d9325c', NULL);
INSERT INTO local_invoice_lines (id, invoice_id, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross) VALUES ('e8f34503-9a42-4b8e-9d45-c8b1b4e3a4bc', '0956683f-f041-4505-a75a-9f2f2cef7698', 'Beratung', 2, 'Std.', 120, 20, 240, 48, 288);
INSERT INTO local_invoice_lines (id, invoice_id, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross) VALUES ('5bb18a1f-1751-4cc4-bb1f-d3eaed3fcb7a', '0956683f-f041-4505-a75a-9f2f2cef7698', 'Reise', 1, 'Stk.', 80, 20, 80, 16, 96);
INSERT INTO local_invoice_lines (id, invoice_id, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross) VALUES ('6510d563-2341-4a10-8321-abd127220757', 'c8cb97ad-d180-4fab-a11e-f9e890de12b1', 'Workshop', 1, 'Stk.', 1500, 0, 1500, 0, 1500);
INSERT INTO local_invoice_lines (id, invoice_id, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross) VALUES ('1a6aa472-2789-4f53-9397-12ade17b5a95', '7202e28a-f190-4f43-b435-55b5dbcdc653', 'Plakat', 3, 'Stk.', 50, 20, 150, 30, 180);
INSERT INTO local_credit_notes (id, number, invoice_id, invoice_number, customer_id, currency, net_total, vat_total, gross_total, reason, service_period_from, service_period_to, issued_at, template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id) VALUES ('d387b7a5-b405-4549-a656-68a0b3afa2b2', 'F-2026-004', '0956683f-f041-4505-a75a-9f2f2cef7698', 'F-2026-001', 'c-at-0001', 'EUR', 80, 16, 96, 'Reise nicht angefallen', '2026-10-06', '2026-10-24', '2026-10-21T00:00:00.000Z', 'rechnung-de', '4', '1ac700d6eb37a605a7ea744c512a706e59143913cc899e9d419b70ae0821f1a9', '__DATA_DIR__/erp-local-archive/2026/F-2026-004.pdf', '203375fff525a1591f2572392d96c1c3138527fe2b14259fd94ef3351f775633', NULL);
INSERT INTO local_credit_notes (id, number, invoice_id, invoice_number, customer_id, currency, net_total, vat_total, gross_total, reason, service_period_from, service_period_to, issued_at, template_id, template_version, template_fingerprint, archive_path, archive_sha256, ticket_id) VALUES ('595141c9-50f0-4b40-a173-cdaeb3c0a00a', 'F-2026-005', 'c8cb97ad-d180-4fab-a11e-f9e890de12b1', 'F-2026-002', 'c-de-0001', 'EUR', 1500, 0, 1500, 'Storno', '2026-10-06', '2026-10-24', '2026-10-21T00:00:00.000Z', 'rechnung-de', '4', '1ac700d6eb37a605a7ea744c512a706e59143913cc899e9d419b70ae0821f1a9', '__DATA_DIR__/erp-local-archive/2026/F-2026-005.pdf', 'c810499f47731cc1c42ee68f9fbd87078ee4addd81932e3c8d2e359b55f2d4fd', NULL);
INSERT INTO local_credit_note_lines (id, credit_note_id, description, qty, unit, unit_price, vat_rate, line_net, line_vat, line_gross) VALUES ('3221c26d-fd1b-43ed-93f9-04bd9a3d5403', 'd387b7a5-b405-4549-a656-68a0b3afa2b2', 'Reise', 1, 'Stk.', 80, 20, 80, 16, 96);
COMMIT;
