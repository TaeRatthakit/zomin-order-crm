"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const migrationPath = fs.readdirSync(path.join(ROOT, "supabase", "migrations"))
  .map(name => path.join(ROOT, "supabase", "migrations", name))
  .find(name => name.endsWith("_order_delete_explicit_intent.sql"));
const migration = fs.readFileSync(migrationPath, "utf8");

function assertMigrationContract() {
  assert(migration.includes("create table if not exists public.order_delete_intents"));
  assert(migration.includes("EXPLICIT_USER_CONFIRMED_DELETE"));
  assert(migration.includes("session_fingerprint"));
  assert(migration.includes("expires_at > created_at"));
  assert(migration.includes("consumed_transaction_id"));
  assert(migration.includes("create_order_delete_intent"));
  assert(migration.includes("delete_order_with_confirmed_intent"));
  assert(migration.includes("ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED"));
  assert(migration.includes("IMPORT_CLEANUP_ORDER_DELETE_FORBIDDEN"));
  assert(migration.includes("confdeltype = 'c'"));
  assert(migration.includes("on delete restrict"));
  assert(migration.indexOf("insert into public.order_deletion_audit") < migration.indexOf("delete from public.orders"));
  assert(migration.indexOf("update public.order_delete_intents") < migration.indexOf("delete from public.orders"));
  assert(migration.includes("audit.delete_intent_id"));
  assert(migration.includes("intent.consumed_transaction_id = pg_catalog.txid_current()"));
  assert(migration.includes("UNEXPECTED_MISSING"));
}

function owner(id, tenantId) {
  return { id, username: id, name: id, role: "Owner", active: true, tenantId, tenantName: tenantId, tenantRole: "Owner" };
}

function fixture() {
  return {
    settings: {
      defaultJarPrice: 100,
      products: [{ id: "p_test", name: "Test Product", stockQuantity: 7, archived: false, salesPackages: [] }],
      rolePermissions: {}
    },
    users: [
      owner("owner-a", "tenant-a"),
      owner("owner-b", "tenant-b"),
      { ...owner("staff-a", "tenant-a"), role: "Staff", tenantRole: "Staff" }
    ],
    customers: [
      { id: "customer-a", name: "Customer A", phone: "0800000001", address: "A", tags: [], createdAt: "2026-09-20" },
      { id: "customer-b", name: "Customer B", phone: "0800000002", address: "B", tags: [], createdAt: "2026-09-20" }
    ],
    orders: [
      {
        id: "order-a-1", tenantId: "tenant-a", customerId: "customer-a", orderNumber: "A-1",
        customerName: "Customer A", phone: "0800000001", address: "A", date: "2026-09-20", time: "10:00",
        jars: 2, totalQuantityShipped: 2, amount: 200, items: "Test Product", productId: "p_test", source: "test",
        revenueSnapshot: 200, productCostSnapshot: 20, profitBeforeAdsSnapshot: 180
      },
      {
        id: "order-a-2", tenantId: "tenant-a", customerId: "customer-a", orderNumber: "A-2",
        customerName: "Customer A", phone: "0800000001", address: "A", date: "2026-09-21", time: "10:00",
        jars: 1, totalQuantityShipped: 1, amount: 100, items: "Test Product", productId: "p_test", source: "test"
      },
      {
        id: "order-b-1", tenantId: "tenant-b", customerId: "customer-b", orderNumber: "B-1",
        customerName: "Customer B", phone: "0800000002", address: "B", date: "2026-09-20", time: "10:00",
        jars: 1, totalQuantityShipped: 1, amount: 100, items: "Test Product", productId: "p_test", source: "test"
      }
    ],
    importJobs: [{ id: "job-with-order", type: "orders", importedOrderIds: ["order-a-1"], importedCustomerIds: [] }],
    tags: [], contactLogs: [], orderDeleteIntents: [], orderDeletionAudits: []
  };
}

function writeFixture(file) {
  fs.writeFileSync(file, `${JSON.stringify(fixture(), null, 2)}\n`);
}

function request(port, { path: requestPath, method = "GET", cookie = "", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: requestPath, method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function cookieFor(createSession, user) {
  return `zomin_session=${encodeURIComponent(createSession(user).token)}`;
}

function explicitHeaders(port) {
  return {
    Origin: `http://127.0.0.1:${port}`,
    "Sec-Fetch-Site": "same-origin",
    "X-Requested-With": "GrowupPilot",
    "X-Growup-User-Action": "order-delete-confirmed"
  };
}

async function createIntent(port, cookie, orderId) {
  return request(port, {
    path: `/api/orders/${orderId}/delete-intent`, method: "POST", cookie, headers: explicitHeaders(port)
  });
}

async function deleteWithIntent(port, cookie, orderId, token) {
  return request(port, {
    path: `/api/orders/${orderId}?date=2026-09-21`, method: "DELETE", cookie,
    headers: { ...explicitHeaders(port), "X-Order-Delete-Intent": token }
  });
}

async function testExplicitDeleteFlow() {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_PROVIDER = "json";
  process.env.SESSION_SECRET = "order-delete-intent-test-secret";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "growup-order-delete-intent-"));
  const dbFile = path.join(dir, "db.json");
  process.env.JSON_DB_PATH = dbFile;
  writeFixture(dbFile);

  const { createSession } = require(path.join(ROOT, "lib", "auth"));
  const adapter = require(path.join(ROOT, "lib", "db", "json-adapter"));
  const app = require(path.join(ROOT, "server"));
  const server = app.server;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const [ownerA, ownerB, staffA] = fixture().users;
  const ownerACookie = cookieFor(createSession, ownerA);
  const ownerBCookie = cookieFor(createSession, ownerB);
  const staffCookie = cookieFor(createSession, staffA);
  try {
    const directOwner = await request(port, { path: "/api/orders/order-a-1", method: "DELETE", cookie: ownerACookie });
    assert.strictEqual(directOwner.status, 403);
    assert(JSON.parse(fs.readFileSync(dbFile)).orders.some(order => order.id === "order-a-1"));

    const directStaff = await request(port, { path: "/api/orders/order-a-1", method: "DELETE", cookie: staffCookie });
    assert.strictEqual(directStaff.status, 403);

    const staleFrontend = await request(port, {
      path: "/api/orders/order-a-1", method: "DELETE", cookie: ownerACookie, headers: explicitHeaders(port)
    });
    assert.strictEqual(staleFrontend.status, 409);

    const crossOrigin = await request(port, {
      path: "/api/orders/order-a-1/delete-intent", method: "POST", cookie: ownerACookie,
      headers: { ...explicitHeaders(port), Origin: "https://example.invalid" }
    });
    assert.strictEqual(crossOrigin.status, 403);

    assert.throws(() => adapter.deleteOrder("order-a-1"), error => error.code === "ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED");
    const omitted = adapter.readDb();
    omitted.orders = omitted.orders.filter(order => order.id !== "order-a-1");
    adapter.writeDb(omitted);
    assert(JSON.parse(fs.readFileSync(dbFile)).orders.some(order => order.id === "order-a-1"), "writeDb must preserve omitted orders");
    assert.throws(
      () => adapter.cleanupImportJob("job-with-order", { tenantId: "tenant-a", actorUserId: "owner-a", actorRole: "Owner" }),
      error => error.code === "IMPORT_CLEANUP_ORDER_DELETE_FORBIDDEN"
    );
    assert.strictEqual(adapter.deleteCustomer("customer-a", { tenantId: "tenant-a", actorUserId: "owner-a", actorRole: "Owner" }), false);

    const wrongOrderIntent = await createIntent(port, ownerACookie, "order-a-1");
    assert.strictEqual(wrongOrderIntent.status, 200);
    const wrongOrder = await deleteWithIntent(port, ownerACookie, "order-a-2", wrongOrderIntent.body.deleteIntent);
    assert.strictEqual(wrongOrder.status, 409);
    assert(JSON.parse(fs.readFileSync(dbFile)).orders.some(order => order.id === "order-a-2"));

    const wrongUser = await deleteWithIntent(port, ownerBCookie, "order-a-1", wrongOrderIntent.body.deleteIntent);
    assert.strictEqual(wrongUser.status, 409);
    assert(JSON.parse(fs.readFileSync(dbFile)).orders.some(order => order.id === "order-a-1"));

    const wrongSession = await deleteWithIntent(port, cookieFor(createSession, ownerA), "order-a-1", wrongOrderIntent.body.deleteIntent);
    assert.strictEqual(wrongSession.status, 409);

    const expiredIntent = await createIntent(port, ownerACookie, "order-a-1");
    assert.strictEqual(expiredIntent.status, 200);
    const expiredDb = JSON.parse(fs.readFileSync(dbFile));
    expiredDb.orderDeleteIntents.find(intent => expiredIntent.body.deleteIntent.startsWith(intent.id)).expiresAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(dbFile, `${JSON.stringify(expiredDb, null, 2)}\n`);
    const expired = await deleteWithIntent(port, ownerACookie, "order-a-1", expiredIntent.body.deleteIntent);
    assert.strictEqual(expired.status, 409);

    const validIntent = await createIntent(port, ownerACookie, "order-a-1");
    assert.strictEqual(validIntent.status, 200);
    assert(validIntent.body.deleteIntent && validIntent.body.expiresAt);
    const beforeDelete = JSON.parse(fs.readFileSync(dbFile));
    const storedIntent = beforeDelete.orderDeleteIntents.find(intent => validIntent.body.deleteIntent.startsWith(intent.id));
    assert(storedIntent.intentHash && !Object.values(storedIntent).includes(validIntent.body.deleteIntent));
    assert(Date.parse(storedIntent.expiresAt) - Date.parse(storedIntent.createdAt) <= 120500);

    const deleted = await deleteWithIntent(port, ownerACookie, "order-a-1", validIntent.body.deleteIntent);
    assert.strictEqual(deleted.status, 200, JSON.stringify(deleted));
    const after = JSON.parse(fs.readFileSync(dbFile));
    assert(!after.orders.some(order => order.id === "order-a-1"));
    assert(after.orders.some(order => order.id === "order-a-2"));
    assert(after.orders.some(order => order.id === "order-b-1"));
    assert.strictEqual(after.settings.products[0].stockQuantity, 9);
    const customer = after.customers.find(row => row.id === "customer-a");
    assert.strictEqual(customer.purchaseCount, 1);
    assert.strictEqual(customer.totalJars, 1);
    assert.strictEqual(customer.totalSpent, 100);
    assert.strictEqual(after.orderDeletionAudits.length, 1);
    const audit = after.orderDeletionAudits[0];
    assert.strictEqual(audit.orderSnapshot.id, "order-a-1");
    assert.strictEqual(audit.orderSnapshot.orderNumber, "A-1");
    assert.strictEqual(audit.orderSnapshot.revenueSnapshot, 200);
    assert.strictEqual(audit.actorUserId, "owner-a");
    assert.strictEqual(audit.deleteIntentId, storedIntent.id);
    assert.strictEqual(audit.deletionProof, "EXPLICIT_USER_CONFIRMED_DELETE");
    assert.strictEqual(audit.inventoryEffect.stock_before, 7);
    assert.strictEqual(audit.inventoryEffect.stock_after, 9);

    const replay = await deleteWithIntent(port, ownerACookie, "order-a-1", validIntent.body.deleteIntent);
    assert([404, 409].includes(replay.status));
    const afterReplay = JSON.parse(fs.readFileSync(dbFile));
    assert.strictEqual(afterReplay.orderDeletionAudits.length, 1);
    assert.strictEqual(afterReplay.settings.products[0].stockQuantity, 9);
    assert.strictEqual(afterReplay.orders.filter(order => order.id === "order-a-1").length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  assertMigrationContract();
  await testExplicitDeleteFlow();
  console.log("order-delete-audit-test: PASS");
})().catch(error => {
  console.error(`order-delete-audit-test: FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
