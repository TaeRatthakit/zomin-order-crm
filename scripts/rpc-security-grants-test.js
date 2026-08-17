"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const migrationPath = path.join(ROOT, "supabase", "migrations", "20260817000000_rpc_execute_grants.sql");
const migration = fs.readFileSync(migrationPath, "utf8").replace(/\s+/g, " ").toLowerCase();

const functions = [
  "growup_activate_zero_amount_subscription_payment(uuid, text, text)",
  "growup_begin_subscription_payment(uuid, text, text, text)",
  "growup_normalize_promotion_code(text)",
  "growup_payment_period_end(timestamptz, text)",
  "growup_platform_admin_overview(text)",
  "growup_platform_admin_payments(text, text, integer, integer)",
  "growup_platform_admin_promotion_codes(text)",
  "growup_platform_admin_role(text)",
  "growup_platform_admin_tenant_detail(text, uuid)",
  "growup_platform_admin_tenants(text, text, integer, integer)",
  "growup_platform_admin_upsert_promotion_code(text, jsonb)",
  "growup_promotion_benefit_description(text, numeric)",
  "growup_record_provider_payment_status(text, text, uuid, text, integer, text, text, jsonb)",
  "growup_record_provider_payment_success(text, text, uuid, text, integer, text, jsonb)",
  "growup_require_platform_admin(text)",
  "growup_set_payment_provider_reference(uuid, uuid, text, text, text, jsonb)",
  "growup_signup_bootstrap(text, text, text, text, text, text, jsonb, text, text, text)",
  "growup_subscription_base_amount_minor(text, text)",
  "growup_validate_promotion_code(text, text, text, uuid)"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const signature of functions) {
  const functionName = `public.${signature}`;
  assert(
    migration.includes(`revoke execute on function ${functionName} from public, anon, authenticated;`),
    `missing public/anon/authenticated revoke for ${functionName}`
  );
  assert(
    migration.includes(`grant execute on function ${functionName} to service_role;`),
    `missing service_role grant for ${functionName}`
  );
}

for (const forbidden of [
  "grant execute on function public.growup_",
  " to anon",
  " to authenticated",
  " to public"
]) {
  if (forbidden === "grant execute on function public.growup_") continue;
  assert(!migration.includes(forbidden), `unexpected grant target found: ${forbidden}`);
}

console.log("RPC security grant migration checks passed.");
