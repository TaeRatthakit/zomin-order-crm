"use strict";

process.env.NODE_ENV = "test";

const fs = require("fs");
const path = require("path");
const { normalizePromoInput } = require("../lib/platform-admin");

const ui = fs.readFileSync(path.join(__dirname, "..", "public", "platform-admin", "platform-admin.js"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function input(type, value, overrides = {}) {
  return {
    code: "VALUECHECK",
    type,
    value,
    plans: ["starter"],
    noExpiry: true,
    ...overrides
  };
}

function accepted(type, value, expectedDatabaseType) {
  const result = normalizePromoInput(input(type, value));
  assert(result.benefit_type === expectedDatabaseType, `${type} database mapping changed`);
  assert(result.benefit_value === value, `${type} value was reinterpreted`);
  return result;
}

function rejected(type, value, expectedMessage) {
  let error = null;
  try { normalizePromoInput(input(type, value)); } catch (caught) { error = caught; }
  assert(error && error.message === expectedMessage, `${type} value ${String(value)} must fail with the expected Thai message`);
}

accepted("percentage", 10, "percent_discount");
accepted("percentage", 100, "percent_discount");
rejected("percentage", 101, "กรุณาระบุส่วนลดมากกว่า 0 และไม่เกิน 100%");

accepted("fixed_thb", 500, "fixed_amount_discount");
rejected("fixed_thb", 0, "กรุณาระบุจำนวนเงินมากกว่า 0 บาท");

accepted("free_days", 1, "service_days");
const thirtyDays = accepted("free_days", 30, "service_days");
rejected("free_days", 0, "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");
rejected("free_days", 0.01, "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");
rejected("free_days", 1.5, "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");
rejected("free_days", -1, "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");
rejected("free_days", "text", "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน");

accepted("free_months", 1, "free_months");
accepted("free_months", 12, "free_months");
rejected("free_months", 0, "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน");
rejected("free_months", 0.5, "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน");
rejected("free_months", -1, "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน");
rejected("free_months", "text", "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน");

const datedDays = normalizePromoInput(input("free_days", 30, { noExpiry: false, startsAt: "2026-09-01", expiresAt: "2026-09-30" }));
assert(datedDays.benefit_value === thirtyDays.benefit_value, "validity dates must not change the free-day benefit");
assert(String(datedDays.starts_at).startsWith("2026-09-01") && String(datedDays.ends_at).startsWith("2026-09-30"), "Promo validity dates changed");

for (const token of [
  'label: "ส่วนลด (%)"',
  'placeholder: "เช่น 10"',
  'label: "ส่วนลด (บาท)"',
  'placeholder: "เช่น 500"',
  'label: "จำนวนวัน"',
  'placeholder: "เช่น 7"',
  'label: "จำนวนเดือน"',
  'placeholder: "เช่น 1"',
  "data-promo-value-label",
  "applyPromoValueFieldType",
  "setCustomValidity",
  "Number.isInteger"
]) assert(ui.includes(token), `Promo value UI is missing ${token}`);

console.log("Platform Admin Promo value-field UX/validation checks passed.");
