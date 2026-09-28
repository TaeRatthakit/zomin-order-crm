"use strict";

const assert = require("assert");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://order-performance-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-key";

const calls = [];
const rows = {
  tenant_memberships: [{ tenant_id: "tenant-test", user_id: "owner-test", is_active: true }],
  users: [{ id: "owner-test", username: "owner", name: "Owner", role: "Owner", is_active: true }],
  settings: [{ id: "tenant-test:rolePermissions", tenant_id: "tenant-test", key: "rolePermissions", value: {} }],
  subscriptions: [{ id: "subscription-test", tenant_id: "tenant-test", plan: "business", status: "active" }]
};

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  assert.strictEqual(url.hostname, "order-performance-test.supabase.co");
  const table = url.pathname.split("/").pop();
  const method = String(options.method || "GET").toUpperCase();
  calls.push({ method, table });
  if (method === "GET") {
    const selected = rows[table] || [];
    return new Response(JSON.stringify(table === "settings" && url.searchParams.has("key")
      ? selected.filter(row => row.key === "rolePermissions") : selected), { status: 200 });
  }
  if (method === "DELETE") return new Response(null, { status: 204 });
  if (method === "POST") return new Response("[]", { status: 200 });
  throw new Error(`Unexpected ${method} ${table}`);
};

const adapter = require("../lib/db/supabase-adapter");
const context = { tenantId: "tenant-test", userId: "owner-test", tenantRole: "Owner" };

(async () => {
  const readCounts = [];
  const priorWriteCounts = [];
  const optimizedWriteCounts = [];
  for (let index = 0; index < 5; index += 1) {
    calls.length = 0;
    const db = await adapter.withTenantContext(context, () => adapter.readOrderDeleteIntentDb());
    assert.strictEqual(db.users[0].id, "owner-test");
    assert.strictEqual(db.subscriptions[0].status, "active");
    assert.deepStrictEqual([...new Set(calls.map(call => call.table))].sort(),
      ["tenant_memberships", "users", "settings", "subscriptions"].sort());
    readCounts.push(calls.length);

    const mutation = {
      order: { id: `order-test-${index}`, customerId: "customer-test", orderNumber: `TEST-${index}`, date: "2026-09-28", jars: 1, amount: 100 },
      customers: [{ id: "customer-test", name: "Test Customer", phone: "0800000000", tags: [] }],
      affectedCustomerIds: ["customer-test"],
      tags: ["existing"]
    };
    calls.length = 0;
    await adapter.withTenantContext(context, () => adapter.persistOrderMutation(mutation, { products: [{ id: "product-test", stockQuantity: 10 }] }));
    priorWriteCounts.push(calls.length);

    calls.length = 0;
    await adapter.withTenantContext(context, () => adapter.persistOrderMutation({
      ...mutation,
      persistTagNames: [],
      persistCustomerTags: false
    }, null));
    assert.deepStrictEqual(calls.map(call => `${call.method} ${call.table}`).sort(), ["POST customers", "POST orders"]);
    optimizedWriteCounts.push(calls.length);
  }
  calls.length = 0;
  await adapter.withTenantContext(context, () => adapter.readDb());
  const fullReadCount = calls.length;
  assert(fullReadCount > Math.max(...readCounts));
  assert(priorWriteCounts.every(count => count > 2));
  console.log(`order-performance-write-test: PASS; intent reads ${fullReadCount} -> ${readCounts.join(",")}; unchanged Edit calls ${priorWriteCounts.join(",")} -> ${optimizedWriteCounts.join(",")}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
