"use strict";

const assert = require("node:assert/strict");

process.env.VERCEL_ENV = "preview";
process.env.DATABASE_PROVIDER = "json";
process.env.SUPABASE_URL = "https://preview-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only";

const adapter = require("../lib/db/supabase-adapter");
const tenantId = "tenant-billing-preview";
const actorId = "user-billing-owner";
const reads = [];
const rowsByTable = {
  tenant_memberships: [{ tenant_id: tenantId, user_id: actorId, is_active: true }],
  users: [{ id: actorId, username: "owner-preview", name: "Preview Owner", role: "Owner", is_active: true }],
  subscriptions: [{ id: "sub-preview", tenant_id: tenantId, plan: "business", status: "active", is_initial: true }],
  payments: [{ id: "pay-preview", tenant_id: tenantId, status: "pending", amount_minor: 1000 }]
};

global.fetch = async input => {
  const url = new URL(input);
  const table = url.pathname.split("/").pop();
  reads.push({ table, params: url.searchParams });
  return new Response(JSON.stringify(rowsByTable[table] || []), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

async function main() {
  const billingDb = await adapter.withTenantContext({ tenantId, userId: actorId }, () => adapter.readBillingDb());
  assert.deepEqual(reads.map(read => read.table).sort(), ["payments", "subscriptions", "tenant_memberships", "users"]);
  assert.equal(reads.find(read => read.table === "tenant_memberships").params.get("tenant_id"), `eq.${tenantId}`);
  assert.equal(reads.find(read => read.table === "subscriptions").params.get("tenant_id"), `eq.${tenantId}`);
  assert.equal(reads.find(read => read.table === "payments").params.get("tenant_id"), `eq.${tenantId}`);
  assert.equal(reads.find(read => read.table === "users").params.get("id"), `in.(${actorId})`);
  assert.equal(billingDb.users[0].role, "Owner");
  assert.equal(billingDb.subscriptions[0].plan, "business");
  assert.equal(billingDb.payments[0].id, "pay-preview");
  assert.deepEqual(billingDb.customers, []);
  assert.deepEqual(billingDb.orders, []);
  assert.deepEqual(billingDb.lineMessages, []);
  console.log("Billing targeted reads stay tenant-scoped and skip unrelated application tables.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
