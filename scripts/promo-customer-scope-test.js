"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizePromoInput } = require("../lib/platform-admin");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20260906000000_promo_customer_scope_signup.sql"), "utf8");
const admin = fs.readFileSync(path.join(ROOT, "lib/platform-admin.js"), "utf8");
const adminUi = fs.readFileSync(path.join(ROOT, "public/platform-admin/platform-admin.js"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");

assert.match(migration, /add column if not exists customer_scope text/);
assert.match(migration, /customer_scope in \('new', 'existing', 'both'\)/);
assert.match(migration, /new_customer_only then 'new' else 'both'/);
assert.match(migration, /PROMOTION_CODE_EXISTING_CUSTOMERS_ONLY/);
assert.match(migration, /PROMOTION_CODE_NEW_CUSTOMERS_ONLY/);
assert.match(migration, /growup_quote_signup_promotion/);
assert.match(migration, /growup_enforce_signup_promo_scope/);
assert.match(migration, /promotion_redemptions_signup_scope/);
assert.doesNotMatch(migration, /delete\s+from\s+public\.(users|tenants|promotion_codes|promotion_redemptions)/i);
assert.doesNotMatch(migration, /insert\s+into\s+public\.(users|tenants|promotion_redemptions)/i);

const base = { code: "SCOPE_TEST", type: "fixed_thb", value: 99, plans: ["starter", "business", "enterprise"], applicableBilling: ["monthly", "yearly"] };
assert.equal(normalizePromoInput({ ...base, customerScope: "new" }).customer_scope, "new");
assert.equal(normalizePromoInput({ ...base, customerScope: "existing" }).customer_scope, "existing");
assert.equal(normalizePromoInput({ ...base, customerScope: "both" }).customer_scope, "both");
assert.equal(normalizePromoInput({ ...base, newCustomersOnly: true }).customer_scope, "new");
assert.equal(normalizePromoInput({ ...base, newCustomersOnly: false }).customer_scope, "both");
assert.equal(normalizePromoInput({ ...base, customerScope: "existing" }).new_customer_only, false);

assert.match(admin, /customer_scope: customerScope/);
assert.match(admin, /customerScope: promotionCustomerScope/);
assert.match(adminUi, /name="customerScope"/);
assert.match(adminUi, /ลูกค้าใหม่เท่านั้น/);
assert.match(adminUi, /ลูกค้าเดิมเท่านั้น/);
assert.match(adminUi, /ลูกค้าใหม่และลูกค้าเดิม/);
assert.match(server, /quoteSignupPromotion/);
assert.match(server, /PROMOTION_CODE_NEW_CUSTOMERS_ONLY/);
assert.match(server, /PROMOTION_CODE_EXISTING_CUSTOMERS_ONLY/);
assert.match(app, /baseAmountMinor/);
assert.match(app, /amountDueMinor/);

const prices = {
  starter: { monthly: 49000, yearly: 490000 },
  business: { monthly: 99000, yearly: 990000 },
  enterprise: { monthly: 199000, yearly: 1990000 }
};

function accepts(scope, customer) {
  return scope === "both" || scope === customer;
}
for (const scope of ["new", "existing", "both"]) {
  assert.equal(accepts(scope, "new"), scope !== "existing", `${scope} signup eligibility`);
  assert.equal(accepts(scope, "existing"), scope !== "new", `${scope} existing-customer eligibility`);
}
for (const [plan, billingPrices] of Object.entries(prices)) {
  for (const [billing, baseMinor] of Object.entries(billingPrices)) {
    assert.equal(Math.max(0, baseMinor - 9900), baseMinor - 9900, `${plan}/${billing} fixed discount quote`);
  }
}

console.log("Promo customer-scope and signup contract checks passed.");
