"use strict";

process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://company-count-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "company-count-test-key";

const assert = require("assert");
const { platformAdminSnapshot } = require("../lib/platform-admin");

const tenants = [
  { id: "real", name: "Growup Pilot Production", status: "active", metadata: { source: "public_signup" } },
  { id: "preview", name: "Preview Tenant", status: "active", metadata: { environment: "preview" } },
  { id: "test", name: "Test Tenant", status: "active", metadata: { is_test: true } },
  { id: "fixture", name: "Fixture Tenant", status: "active", metadata: { source: "fixture" } },
  { id: "migration", name: "Migration Tenant", status: "active", metadata: { source: "migration" } },
  { id: "legacy-dev", name: "Legacy Development", status: "active", metadata: {} },
  { id: "internal", name: "Internal System", status: "active", metadata: { internal: true } },
  { id: "platform", name: "Platform Admin", status: "active", metadata: { platform_admin: true } },
  { id: "inactive", name: "Inactive Account", status: "inactive", metadata: { source: "public_signup" } },
  { id: "no-owner", name: "No Owner", status: "active", metadata: { source: "public_signup" } },
  { id: "inactive-owner", name: "Inactive Owner", status: "active", metadata: { source: "public_signup" } },
  { id: "orphan", name: "Orphan Tenant", status: "active", metadata: {} },
  { id: "legacy-test", name: "Legacy Test", status: "active", metadata: {} },
  { id: "dev", name: "Dev Tenant", status: "active", metadata: {} },
  { id: "system", name: "System Tenant", status: "active", metadata: {} },
  { id: "phase-qa", name: "Phase45 Platform Candidate", status: "active", metadata: {} },
  { id: "full-e2e", name: "Full E2E 1787297656850", status: "active", metadata: {} },
  { id: "usage-a", name: "Usage A 1787298516548", status: "active", metadata: {} }
];
const users = [
  { id: "real-owner", username: "real-owner", name: "Real Owner", role: "Owner", is_active: true },
  { id: "preview-owner", username: "preview-owner", name: "Preview Owner", role: "Owner", is_active: true },
  { id: "test-owner", username: "test-owner", name: "Test Owner", role: "Owner", is_active: true },
  { id: "fixture-owner", username: "fixture-owner", name: "Fixture Owner", role: "Owner", is_active: true },
  { id: "migration-owner", username: "migration-owner", name: "Migration Owner", role: "Owner", is_active: true },
  { id: "legacy-owner", username: "legacy-owner", name: "Legacy Owner", role: "Owner", is_active: true },
  { id: "internal-owner", username: "internal-owner", name: "Internal Owner", role: "Owner", is_active: true },
  { id: "platform-owner", username: "platform-owner", name: "Platform Owner", role: "Owner", is_active: true },
  { id: "inactive-owner", username: "inactive-owner", name: "Inactive Owner", role: "Owner", is_active: false }
];
const tenant_memberships = [
  ...tenants.slice(0, 8).map((tenant, index) => ({ tenant_id: tenant.id, user_id: users[index].id, role: "Owner", is_active: true })),
  { tenant_id: "inactive", user_id: "real-owner", role: "Owner", is_active: true },
  { tenant_id: "inactive-owner", user_id: "inactive-owner", role: "Owner", is_active: true },
  { tenant_id: "orphan", user_id: "real-owner", role: "Admin", is_active: true },
  { tenant_id: "legacy-test", user_id: "legacy-owner", role: "Owner", is_active: true },
  { tenant_id: "dev", user_id: "legacy-owner", role: "Owner", is_active: true },
  { tenant_id: "system", user_id: "internal-owner", role: "Owner", is_active: true },
  { tenant_id: "phase-qa", user_id: "real-owner", role: "Owner", is_active: true },
  { tenant_id: "full-e2e", user_id: "real-owner", role: "Owner", is_active: true },
  { tenant_id: "usage-a", user_id: "real-owner", role: "Owner", is_active: true }
];
const signup_bootstraps = [{ tenant_id: "real" }];
const subscriptions = [{ tenant_id: "real", status: "active", plan: "starter", amount_due_minor: 49000 }];
const customers = [{ tenant_id: "real", id: "customer-1" }];
const orders = [{ tenant_id: "real", id: "order-1" }];
const line_messages = [];
const empty = [];
const tables = { tenants, tenant_memberships, users, signup_bootstraps, subscriptions, customers, orders, line_messages, payments: empty, payment_transactions: empty, tenant_subscriptions: empty, activity_logs: empty, user_activity: empty, system_health_events: empty };

global.fetch = async input => {
  const table = new URL(String(input)).pathname.split("/").filter(Boolean).at(-1);
  if (!(table in tables)) return new Response("[]", { status: 200 });
  return new Response(JSON.stringify(tables[table]), { status: 200 });
};

(async () => {
  const snapshot = await platformAdminSnapshot({ start: "2026-08-01", end: "2026-08-31" });
  assert.strictEqual(snapshot.companies.length, 1);
  assert.strictEqual(snapshot.home.companies.total, 1);
  assert.strictEqual(snapshot.home.companies.active, 1);
  assert.strictEqual(snapshot.plans.total, 1);
  assert.strictEqual(snapshot.companies[0].id, "real");
  console.log("Platform Admin company count filter checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
