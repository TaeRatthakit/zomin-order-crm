"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(ROOT, "supabase", "migration-promotion-codes.sql"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const signupHtml = fs.readFileSync(path.join(ROOT, "public", "signup.html"), "utf8");
const signupStart = app.indexOf("function renderSignup()");
const signupEnd = app.indexOf("function clearSignupUsernameError", signupStart);
const signupRenderer = app.slice(signupStart, signupEnd);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const token of [
  "create table if not exists public.promotion_codes",
  "create table if not exists public.promotion_redemptions",
  "percent_discount",
  "fixed_amount_discount",
  "extra_trial_days",
  "free_months",
  "max_redemptions",
  "max_redemptions_per_tenant",
  "growup_validate_promotion_code",
  "growup_normalize_promotion_code",
  "for update"
]) {
  assert(migration.includes(token), `promotion migration missing ${token}`);
}

assert(migration.includes("upper(trim(code))"), "promotion code uniqueness must be case-insensitive");
assert(!/insert\s+into\s+public\.promotion_codes/i.test(migration), "promotion migration must not seed public promotion codes");
assert(server.includes('"/api/signup/promotion-code"'), "promotion validation API route missing");
assert(server.includes("validatePromotionCode") && server.includes("safePromotionError"), "server-side promotion validation must be authoritative and safe");
assert(server.includes("promotionCode: normalized.promotionCode") && !server.includes("clientDiscountValue"), "signup must pass only code and plan intent, not browser discounts");
assert(app.includes("มีโค้ดโปรโมชั่น?") && app.includes("data-signup-validate-promotion-code"), "signup promotion UI missing");
assert(signupHtml.includes("มีโค้ดโปรโมชั่น?") && signupHtml.includes("data-signup-validate-promotion-code"), "raw signup shell promotion UI missing");
assert(signupRenderer.indexOf("ยืนยันรหัสผ่าน") < signupRenderer.indexOf("signupPromotionHtml()"), "signup promo UI must follow confirm password in renderer");
assert(signupHtml.indexOf("ยืนยันรหัสผ่าน") < signupHtml.indexOf("มีโค้ดโปรโมชั่น?"), "signup promo UI must follow confirm password in raw shell");

console.log("Promotion code foundation checks passed.");
