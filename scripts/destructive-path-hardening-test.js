"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "growup-destructive-path-"));
const dataFile = path.join(tempDir, "db.json");
const migrationFile = path.join(__dirname, "..", "supabase", "migrations", "20260912010000_destructive_path_hardening.sql");

function fixture() {
  return {
    settings: {},
    customers: [
      { id: "customer-pre-existing", name: "Existing", phone: "0800000001", tags: [] },
      { id: "customer-imported", name: "Imported", phone: "0800000002", tags: [] },
      { id: "customer-orphan", name: "Omitted", phone: "0800000003", tags: [] }
    ],
    orders: [
      { id: "order-pre-existing", customerId: "customer-pre-existing", customerName: "Existing", phone: "0800000001", date: "2026-09-12", jars: 1, amount: 100 },
      { id: "order-imported", importJobId: "job-test-1", customerId: "customer-imported", customerName: "Imported", phone: "0800000002", date: "2026-09-12", jars: 1, amount: 200 }
    ],
    importJobs: [{
      id: "job-test-1",
      type: "orders",
      importedOrderIds: ["order-imported"],
      importedCustomerIds: ["customer-imported"]
    }],
    contactLogs: [],
    orderDeletionAudits: [],
    customerDeletionAudits: []
  };
}

function writeFixture(value) {
  fs.writeFileSync(dataFile, JSON.stringify(value, null, 2) + "\n", "utf8");
}

process.env.JSON_DB_PATH = dataFile;
const adapter = require("../lib/db/json-adapter");

writeFixture(fixture());
const initial = adapter.readDb();
assert(initial.customers.some(customer => customer.id === "customer-orphan"), "orphan customer should be readable");

const omittedProjection = adapter.readDb();
omittedProjection.customers = omittedProjection.customers.filter(customer => customer.id !== "customer-orphan");
adapter.writeDb(omittedProjection);
let afterProjection = adapter.readDb();
assert(afterProjection.customers.some(customer => customer.id === "customer-orphan"), "writeDb must preserve omitted persisted customer");

assert.throws(
  () => adapter.deleteCustomer("customer-orphan"),
  error => error.code === "CUSTOMER_DELETE_AUDIT_CONTEXT_REQUIRED"
);

assert.strictEqual(adapter.deleteCustomer("customer-orphan", {
  tenantId: "tenant-preview-a",
  actorUserId: "user-preview-a",
  actorRole: "Owner",
  requestMetadata: { route: "/api/customers/customer-orphan", method: "DELETE", source: "test" }
}), true);
afterProjection = adapter.readDb();
assert(!afterProjection.customers.some(customer => customer.id === "customer-orphan"), "explicit delete should still delete the target customer");
assert.strictEqual(afterProjection.customerDeletionAudits.at(-1).customerId, "customer-orphan");

writeFixture(fixture());
const cleanup = adapter.cleanupImportJob("job-test-1", {
  tenantId: "tenant-preview-a",
  actorUserId: "user-preview-a",
  actorRole: "Owner",
  requestMetadata: { route: "/api/import-jobs/job-test-1/cleanup", method: "POST" }
});
assert.strictEqual(cleanup.deletedOrders, 1);
const afterCleanup = adapter.readDb();
assert(!afterCleanup.orders.some(order => order.id === "order-imported"), "exact imported order should be removed");
assert(afterCleanup.orders.some(order => order.id === "order-pre-existing"), "pre-existing order must survive cleanup");
assert(afterCleanup.customers.some(customer => customer.id === "customer-pre-existing"), "pre-existing customer must survive cleanup");
assert(afterCleanup.customers.some(customer => customer.id === "customer-imported"), "import cleanup must not auto-delete customers");
assert.strictEqual(afterCleanup.orderDeletionAudits.at(-1).orderId, "order-imported");

writeFixture(fixture());
const mismatched = adapter.readDb();
mismatched.importJobs[0].importedOrderIds = ["order-pre-existing"];
adapter.writeDb(mismatched);
const beforeFailedCleanup = JSON.parse(fs.readFileSync(dataFile, "utf8"));
assert.throws(
  () => adapter.cleanupImportJob("job-test-1", {
    tenantId: "tenant-preview-a",
    actorUserId: "user-preview-a",
    actorRole: "Owner"
  }),
  error => error.code === "IMPORT_CLEANUP_ORDER_PROVENANCE_MISMATCH"
);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(dataFile, "utf8")), beforeFailedCleanup, "provenance failure must not persist a mutation");

const migration = fs.readFileSync(migrationFile, "utf8");
assert(migration.includes("create table if not exists public.customer_deletion_audit"));
assert(migration.includes("create or replace function public.delete_customer_with_audit"));
assert(migration.includes("create or replace function public.cleanup_import_job_with_audit"));
assert(migration.includes("order_row.tenant_id = p_tenant_id"));
const cleanupSql = migration.slice(migration.indexOf("create or replace function public.cleanup_import_job_with_audit"));
assert(!cleanupSql.includes("delete from public.customers"), "import cleanup SQL must not auto-delete customers");

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("Destructive path hardening tests passed.");
