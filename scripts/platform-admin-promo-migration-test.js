"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260827000000_platform_admin_promo_preview.sql"), "utf8");
const foundation = fs.readFileSync(path.join(root, "supabase", "migrations", "20260812000000_promotion_codes.sql"), "utf8");
const core = fs.readFileSync(path.join(root, "lib", "platform-admin.js"), "utf8");
const http = fs.readFileSync(path.join(root, "lib", "platform-admin-http.js"), "utf8");
const ui = fs.readFileSync(path.join(root, "public", "platform-admin", "platform-admin.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  "add column if not exists description",
  "add column if not exists new_customer_only",
  "created_by_user_id",
  "updated_by_user_id",
  "growup_require_single_platform_super_admin",
  "growup_platform_admin_promo_list",
  "growup_platform_admin_promo_audit",
  "growup_platform_admin_save_promotion_code",
  "growup_platform_admin_set_promotion_status",
  "promotion_code.redeem",
  "growup_audit_promotion_redemption",
  "growup_validate_promotion_code",
  "PROMOTION_CODE_NEW_CUSTOMERS_ONLY",
  "for update"
]) assert(migration.toLowerCase().includes(token.toLowerCase()), `Promo migration missing ${token}`);

assert(foundation.includes("uniq_promotion_codes_normalized_code") && foundation.includes("upper(trim(code))"), "normalized unique Promo code foundation missing");

assert(/v_benefit_type = 'percent_discount' and v_benefit_value > 100/i.test(migration), "percentage upper bound missing");
assert(/v_benefit_type in \('extra_trial_days', 'free_months'\).*trunc/i.test(migration), "integer free-period validation missing");
assert(/v_count <> 1/i.test(migration), "exactly-one active super_admin guard missing");
assert(/revoke execute[\s\S]+from public, anon, authenticated/i.test(migration), "Promo RPC public grants are not revoked");
assert(/grant execute[\s\S]+to service_role/i.test(migration), "Promo RPC service-role grants missing");
assert(!/insert\s+into\s+public\.promotion_codes[\s\S]+values\s*\(\s*'[^']+/i.test(migration), "migration must not seed Promo records");
assert(!core.includes("PLATFORM_ADMIN_PROMO_STORE_PATH") && !core.includes("readPromoStore") && !core.includes("writePromoStore"), "local-file Promo store remains in Platform Admin runtime");
assert(core.includes("PLATFORM_ADMIN_PROMO_WRITES_ENABLED") && core.includes("PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED"), "environment-specific Promo write flags missing");
assert(core.includes("PREVIEW_SUPABASE_HOST") && core.includes("PRODUCTION_SUPABASE_HOST") && core.includes("environment_denied"), "fail-closed environment/datasource gate missing");
assert(core.includes("assertPlatformAdminPromoWriteAccess") && core.includes("resolveAuthorizedIdentity"), "server-side identity/membership write gate missing");
assert(http.includes("platformAdminPromoStorageLabel") && http.includes("assertSameOrigin"), "environment-aware Supabase source or same-origin write guard missing");
assert(ui.includes('loadCachedEndpoint("promos:0"') && ui.includes('loadCachedEndpoint("promo-audit:0"'), "Promo and audit requests must load independently");
assert(ui.includes("limit=25&offset=0") && ui.includes("limit=20&offset=0"), "Promo and audit initial pages must be bounded");
assert(ui.includes("setTimeout(loadAudit, 0)"), "Audit request must be deferred until after the initial Promo shell task");
assert(ui.includes("data-promo-load-more") && ui.includes("data-promo-audit-load-more"), "Promo and audit pagination controls missing");
assert(ui.includes("state.routeController?.abort()") && ui.includes("token !== state.routeToken"), "Promo stale-request cancellation guard missing");

console.log("Platform Admin Promo migration/architecture test passed.");
