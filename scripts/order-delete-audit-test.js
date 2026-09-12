"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(ROOT, "supabase", "migrations", "20260912000000_order_delete_audit.sql"),
  "utf8"
);

function assertMigrationContract() {
  assert(migration.includes("tenant_id uuid not null references public.tenants(id)"));
  assert(migration.includes("actor_user_id text not null"));
  assert(migration.includes("order_snapshot jsonb not null"));
  assert(migration.includes("alter table public.order_deletion_audit enable row level security"));
  assert(migration.includes("revoke all on table public.order_deletion_audit from anon, authenticated"));
  assert(migration.includes("grant execute on function public.delete_order_with_audit"));
  assert(migration.indexOf("insert into public.order_deletion_audit") < migration.indexOf("delete from public.orders"));
  assert(migration.includes("where id = v_order.id\n    and tenant_id = p_tenant_id"));
}

function writeFixture(file, user) {
  fs.writeFileSync(file, `${JSON.stringify({
    settings: {
      defaultJarPrice: 10,
      products: [{ id: "p_test", name: "Test", costPerItem: 1, stockQuantity: 10, archived: false, salesPackages: [] }],
      rolePermissions: {}
    },
    users: [user],
    customers: [{
      id: "customer-test",
      name: "Delete Test",
      phone: "test-delete-phone",
      address: "Test",
      tags: [],
      createdAt: "2026-09-12"
    }],
    orders: [{
      id: "order-delete-test",
      customerId: "customer-test",
      customerName: "Delete Test",
      phone: "test-delete-phone",
      address: "Test",
      date: "2026-09-12",
      time: "10:00",
      jars: 1,
      amount: 10,
      items: "Test",
      source: "test"
    }],
    tags: [],
    contactLogs: [],
    orderDeletionAudits: []
  }, null, 2)}\n`);
}

function request(port, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/orders/order-delete-test",
      method: "DELETE",
      headers: { Cookie: cookie }
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function testJsonDelete() {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_PROVIDER = "json";
  process.env.SESSION_SECRET = "order-delete-audit-test-secret";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "growup-order-delete-audit-"));
  const dbFile = path.join(dir, "db.json");
  const user = {
    id: "owner-test",
    username: "owner-test",
    name: "Owner Test",
    role: "Owner",
    active: true,
    tenantId: "tenant-test",
    tenantName: "Test Tenant",
    tenantRole: "Owner"
  };
  writeFixture(dbFile, user);
  process.env.JSON_DB_PATH = dbFile;

  const { createSession } = require(path.join(ROOT, "lib", "auth"));
  const app = require(path.join(ROOT, "server"));
  const server = app.server;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const session = createSession(user);
    const result = await request(server.address().port, `zomin_session=${encodeURIComponent(session.token)}`);
    assert.strictEqual(result.status, 200);
    const after = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert(!after.orders.some(order => order.id === "order-delete-test"));
    assert.strictEqual(after.orderDeletionAudits.length, 1);
    assert.strictEqual(after.orderDeletionAudits[0].action, "order_delete");
    assert.strictEqual(after.orderDeletionAudits[0].orderSnapshot.id, "order-delete-test");
    assert.strictEqual(after.orderDeletionAudits[0].actorUserId, "owner-test");

    const staff = {
      id: "staff-test",
      username: "staff-test",
      name: "Staff Test",
      role: "Staff",
      active: true,
      tenantId: "tenant-test",
      tenantName: "Test Tenant",
      tenantRole: "Staff"
    };
    writeFixture(dbFile, staff);
    const staffSession = createSession(staff);
    const unauthorized = await request(server.address().port, `zomin_session=${encodeURIComponent(staffSession.token)}`);
    assert.strictEqual(unauthorized.status, 403, JSON.stringify(unauthorized));
    const unchanged = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    assert(unchanged.orders.some(order => order.id === "order-delete-test"));
    assert.strictEqual(unchanged.orderDeletionAudits.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testAuditFailureBlocksDelete() {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_PROVIDER = "supabase";
  process.env.SUPABASE_URL = "https://order-delete-audit-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  const adapter = require(path.join(ROOT, "lib", "db", "supabase-adapter"));
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/rpc/delete_order_with_audit")) {
      return { ok: false, status: 500, text: async () => "forced audit failure" };
    }
    return { ok: true, status: 204, text: async () => "" };
  };
  try {
    await assert.rejects(
      adapter.withTenantContext(
        { tenantId: "00000000-0000-0000-0000-000000000001", userId: "owner-test", tenantRole: "Owner" },
        () => adapter.persistOrderMutation({
          deletedOrderId: "order-delete-test",
          deletionAudit: {
            actorUserId: "owner-test",
            actorRole: "Owner",
            requestMetadata: { route: "/api/orders/order-delete-test", method: "DELETE", source: "test" }
          }
        }, {})
      ),
      /Supabase RPC delete_order_with_audit failed/
    );
    assert(calls.some(url => url.includes("/rpc/delete_order_with_audit")));
    assert(!calls.some(url => /\/rest\/v1\/orders\?/.test(url)));
  } finally {
    global.fetch = originalFetch;
  }
}

(async () => {
  assertMigrationContract();
  await testJsonDelete();
  await testAuditFailureBlocksDelete();
  console.log("order-delete-audit-test: PASS");
})().catch(error => {
  console.error(`order-delete-audit-test: FAIL: ${error.message}`);
  process.exitCode = 1;
});
