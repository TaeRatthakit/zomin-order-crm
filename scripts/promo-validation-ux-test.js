"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkoutPromoError } = require("../lib/checkout-promo");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const migrationSource = fs.readFileSync(path.join(root, "supabase/migrations/20260905000000_checkout_promo_validation_reasons.sql"), "utf8");

const cases = [
  ["PROMOTION_CODE_NOT_FOUND", "ไม่พบโค้ดนี้ กรุณาตรวจสอบแล้วลองอีกครั้ง"],
  ["PROMOTION_CODE_DISABLED", "โค้ดนี้ไม่สามารถใช้งานได้"],
  ["PROMOTION_CODE_EXPIRED", "โค้ดนี้หมดอายุแล้ว"],
  ["PROMOTION_CODE_EXHAUSTED", "โค้ดนี้ถูกใช้ครบจำนวนแล้ว"],
  ["PROMOTION_CODE_PLAN_INELIGIBLE", "โค้ดนี้ไม่สามารถใช้กับแพ็กเกจที่เลือกได้"]
];

for (const [code, message] of cases) {
  assert.equal(checkoutPromoError(new Error(code)).error, message, `${code} message`);
}
assert.equal(checkoutPromoError(new Error("ETIMEDOUT while calling Supabase")), null, "network errors are not promo-invalid");
assert.match(appSource, /app\.checkoutPromotionError = "กรุณากรอกโค้ดโปรโมชั่น"/);
assert.match(appSource, /app\.checkoutPromotionError \|\| promoFeedback/);
assert.match(appSource, /const promoFeedback = appliedPromo \? `ใช้โค้ดสำเร็จ \$\{promoBenefit\}`/);
assert.match(appSource, /: appliedPromo \? `ลด ฿/);
assert.doesNotMatch(appSource, /ระบบโค้ดโปรโมชั่นกำลังเตรียมพร้อมใช้งาน/);
assert.match(serverSource, /PROMOTION_VALIDATION_UNAVAILABLE/);
assert.match(serverSource, /ไม่สามารถตรวจสอบโค้ดได้ กรุณาลองใหม่อีกครั้ง/);
assert.match(migrationSource, /PROMOTION_CODE_NOT_FOUND/);
assert.match(migrationSource, /PROMOTION_CODE_DISABLED/);
assert.match(migrationSource, /PROMOTION_CODE_PLAN_INELIGIBLE/);
assert.match(migrationSource, /growup_require_promo_capacity/);
assert.match(serverSource, /beginSubscriptionCheckout\([\s\S]*promotionCode/);

console.log("Promo validation UX messages, loading/error boundary, authoritative quote, and checkout revalidation contracts passed.");
