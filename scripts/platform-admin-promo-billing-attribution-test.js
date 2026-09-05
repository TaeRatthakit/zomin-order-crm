"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizePromoInput } = require("../lib/platform-admin");

const base = { code: "BILLING_TEST", type: "fixed_thb", value: 99, plans: ["business"], noExpiry: true };
assert.deepEqual(normalizePromoInput({ ...base, applicableBilling: ["monthly"] }).applicable_billing, ["monthly"]);
assert.deepEqual(normalizePromoInput({ ...base, applicableBilling: ["yearly"] }).applicable_billing, ["yearly"]);
assert.deepEqual(normalizePromoInput({ ...base, applicableBilling: ["monthly", "yearly"] }).applicable_billing, ["monthly", "yearly"]);
assert.deepEqual(normalizePromoInput(base).applicable_billing, ["monthly", "yearly"], "legacy input keeps both billing periods");
assert.equal(normalizePromoInput({ ...base, applicableBilling: ["monthly"], sourceCampaign: "OWNER_PRODUCTION_REVIEW" }).source_campaign, "OWNER_PRODUCTION_REVIEW");
assert.throws(() => normalizePromoInput({ ...base, applicableBilling: [] }), /ช่วงรอบบิลที่เลือกไม่ถูกต้อง/);
assert.throws(() => normalizePromoInput({ ...base, applicableBilling: ["weekly"] }), /ช่วงรอบบิลที่เลือกไม่ถูกต้อง/);

const ui = fs.readFileSync(path.join(__dirname, "../public/platform-admin/platform-admin.js"), "utf8");
assert.match(ui, /name="billing"/);
assert.match(ui, /Source \/ Campaign/);
assert.match(ui, /data\.applicableBilling = formData\.getAll\("billing"\)/);
assert.match(ui, /promoBillingLabel/);

const migration = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260905000000_promo_billing_attribution.sql"), "utf8");
assert.match(migration, /add column if not exists source_campaign text/);
assert.match(migration, /pc\.applicable_billing/);
assert.match(migration, /pc\.source_campaign/);
assert.match(migration, /v_billing/);
assert.match(migration, /v_source_campaign/);
assert.doesNotMatch(migration, /create or replace function public\.growup_begin_subscription_promo_checkout/);
assert.doesNotMatch(migration, /create or replace function public\.growup_quote_checkout_promotion/);

console.log("Platform Admin Promo billing/attribution tests passed.");
