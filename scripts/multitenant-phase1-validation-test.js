const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  TENANT_CONTEXT_ERROR_CODES,
  assertTenantContext,
  createTenantContext,
  createTenantId,
  isValidTenantId,
  resolveSingleActiveMembership
} = require("../lib/tenant-context");
const {
  TENANT_OWNED_COLLECTIONS,
  TENANT_SCOPED_SETTINGS_KEYS,
  buildDefaultTenantBackfillPlan,
  defaultTenantNameFromSettings,
  tenantScopedStoragePath,
  validateTenantBackfillReadiness
} = require("../lib/db/tenant-primitives");
const jsonAdapter = require("../lib/db/json-adapter");

const ROOT = path.join(__dirname, "..");
const forwardSql = fs.readFileSync(path.join(ROOT, "supabase", "migration-tenancy-phase1.sql"), "utf8");
const rollbackSql = fs.readFileSync(path.join(ROOT, "supabase", "migration-tenancy-phase1-rollback.sql"), "utf8");

function assertThrowsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

const tenantId = createTenantId();
assert.ok(isValidTenantId(tenantId), "generated tenant ids are opaque UUIDs");
assert.strictEqual(isValidTenantId("ten_live_default"), false, "hard-coded legacy tenant ids are not valid");

assertThrowsCode(() => assertTenantContext(null), TENANT_CONTEXT_ERROR_CODES.REQUIRED);
assertThrowsCode(() => assertTenantContext({ tenantId: "ten_live_default" }), TENANT_CONTEXT_ERROR_CODES.INVALID);
assertThrowsCode(() => resolveSingleActiveMembership([]), TENANT_CONTEXT_ERROR_CODES.REQUIRED);
assertThrowsCode(() => resolveSingleActiveMembership([{ isActive: true }, { isActive: true }]), TENANT_CONTEXT_ERROR_CODES.AMBIGUOUS);

const context = createTenantContext({
  tenant: { id: tenantId, status: "active" },
  user: { id: "u_owner" },
  membership: { id: "membership_1", role: "Owner", isActive: true },
  permissions: { canExport: true }
});
assert.strictEqual(context.tenantId, tenantId);
assert.strictEqual(context.role, "Owner");

assert.strictEqual(defaultTenantNameFromSettings({ businessName: "  Test Shop  " }), "Test Shop");
assert.strictEqual(defaultTenantNameFromSettings({}), "Growup Pilot");

const planTenantId = "11111111-1111-4111-8111-111111111111";
const plan = buildDefaultTenantBackfillPlan({
  settings: { businessName: "Pilot Shop", staffCanExport: true },
  users: [
    { id: "u_owner", username: "owner", role: "Owner", isActive: true },
    { id: "u_staff", username: "staff", role: "Staff", isActive: false }
  ],
  customers: [{ id: "c1" }],
  orders: [{ id: "o1" }]
}, {
  tenantId: planTenantId,
  membershipIdForUser: user => `${planTenantId}:${user.id}`
});
assert.strictEqual(plan.execute, false, "backfill planning never mutates data");
assert.strictEqual(plan.tenant.name, "Pilot Shop");
assert.deepStrictEqual(plan.memberships.map(item => [item.userId, item.role, item.isActive]), [
  ["u_owner", "Owner", true],
  ["u_staff", "Staff", false]
]);
assert.deepStrictEqual(plan.tenantSettings.map(item => item.key), ["businessName", "staffCanExport"]);
assert.deepStrictEqual(plan.tenantRolePermissions.map(item => item.role), ["Owner", "Admin", "Staff"]);
assert.strictEqual(plan.counts.orders, 1);

const validDb = {
  users: [{ id: "u_owner", username: "owner", role: "Owner", isActive: true }],
  customers: [{ id: "c1", phone: "0811111111", assignedTo: "u_owner" }],
  orders: [{ id: "o1", customerId: "c1", createdBy: "u_owner" }],
  followUpRules: [{ id: "f1", jars: 1 }],
  tags: [{ id: "t1", name: "VIP" }],
  customerTags: [{ id: "ct1", customerId: "c1", tagName: "VIP" }],
  contactLogs: [{ id: "l1", customerId: "c1" }],
  notificationReads: [{ userId: "u_owner", notificationId: "n1" }],
  settings: {}
};
assert.strictEqual(validateTenantBackfillReadiness(validDb, { requireActiveOwner: true }).ok, true);

const duplicateDb = {
  users: [
    { id: "u1", username: "owner", role: "Owner" },
    { id: "u2", username: "OWNER", role: "Staff" }
  ],
  customers: [
    { id: "c1", phone: "0811111111" },
    { id: "c2", phone: "0811111111" }
  ],
  orders: [{ id: "o1", customerId: "missing" }],
  followUpRules: [{ id: "f1", jars: 1 }, { id: "f2", jars: 1 }],
  tags: [{ id: "t1", name: "VIP" }, { id: "t2", name: "vip" }],
  notificationReads: [
    { userId: "u1", notificationId: "n1" },
    { userId: "u1", notificationId: "n1" }
  ]
};
const duplicateResult = validateTenantBackfillReadiness(duplicateDb);
assert.strictEqual(duplicateResult.ok, false);
assert.deepStrictEqual(duplicateResult.errors.map(error => error.code), [
  "DUPLICATE_GLOBAL_USERNAMES",
  "DUPLICATE_CUSTOMER_PHONES",
  "DUPLICATE_TAG_NAMES",
  "DUPLICATE_FOLLOW_UP_RULE_JARS",
  "DUPLICATE_NOTIFICATION_READS",
  "ORPHAN_TENANT_RECORDS"
]);

const incompleteResult = validateTenantBackfillReadiness(validDb, { requireCompleteBackfill: true });
assert.strictEqual(incompleteResult.ok, false);
assert.ok(incompleteResult.errors.some(error => error.code === "INCOMPLETE_TENANT_BACKFILL"));

assert.strictEqual(tenantScopedStoragePath(planTenantId, "products/a.png"), `tenants/${planTenantId}/products/a.png`);
assert.throws(() => tenantScopedStoragePath(planTenantId, "../secret.png"));

assert.ok(TENANT_OWNED_COLLECTIONS.includes("orders"));
assert.ok(TENANT_SCOPED_SETTINGS_KEYS.includes("staffCanExport"));
assert.strictEqual(jsonAdapter.tenantPrimitives.validateTenantBackfillReadiness(validDb).ok, true);

for (const table of ["tenants", "tenant_memberships", "tenant_settings", "tenant_role_permissions"]) {
  assert.ok(forwardSql.includes(`create table if not exists public.${table}`), `forward migration creates ${table}`);
  assert.ok(rollbackSql.includes(`drop table if exists public.${table}`), `rollback migration drops ${table}`);
}
assert.ok(/users\s*\(\s*id text primary key,[\s\S]*username text not null unique/.test(fs.readFileSync(path.join(ROOT, "supabase", "schema.sql"), "utf8")), "users.username remains globally unique in base schema");
assert.ok(/unique \(tenant_id, user_id\)/.test(forwardSql), "tenant memberships are unique per tenant and user");
assert.ok(!/ten_live_default/.test(forwardSql), "migration does not hard-code tenant ids");

for (const table of ["customers", "orders", "line_messages", "follow_up_rules", "settings", "tags", "customer_tags", "contact_logs", "notification_reads"]) {
  assert.ok(forwardSql.includes(`alter table public.${table} add column if not exists tenant_id uuid`), `${table} has nullable tenant_id`);
  assert.ok(rollbackSql.includes(`alter table public.${table} drop column if exists tenant_id`), `${table} tenant_id rollback exists`);
}

assert.ok(/where tenant_id is not null/.test(forwardSql), "tenant uniqueness preparation is non-destructive while tenant_id is nullable");
assert.ok(!/alter table public\.\w+ add column if not exists tenant_id uuid not null/i.test(forwardSql), "Phase 1 does not enforce NOT NULL tenant ownership");
assert.ok(/alter table public\.tenants enable row level security/.test(forwardSql), "tenant tables have RLS enabled");

console.log("multitenant phase 1 validation passed");
