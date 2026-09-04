"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { platformAdminPromoWriteStatus, platformAdminPromoStorageLabel } = require("../lib/platform-admin");

const root = path.join(__dirname, "..");
const production = "https://mjnpzdmrqweugdnvlqwq.supabase.co";
const preview = "https://enwabsfsmwwcwwirdwok.supabase.co";
const original = { VERCEL_ENV: process.env.VERCEL_ENV, SUPABASE_URL: process.env.SUPABASE_URL, PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED: process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED };
try {
  process.env.VERCEL_ENV = "production";
  process.env.SUPABASE_URL = production;
  delete process.env.PLATFORM_ADMIN_PROMO_PRODUCTION_WRITES_ENABLED;
  assert.equal(platformAdminPromoWriteStatus("u_admin").enabled, false);
  assert.equal(platformAdminPromoStorageLabel(), "production-supabase");
  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = preview;
  process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED = "true";
  assert.equal(platformAdminPromoWriteStatus("u_admin").enabled, true);
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete process.env.PLATFORM_ADMIN_PROMO_WRITES_ENABLED;
}

const http = fs.readFileSync(path.join(root, "lib/platform-admin-http.js"), "utf8");
const ui = fs.readFileSync(path.join(root, "public/platform-admin/platform-admin.js"), "utf8");
assert.match(http, /write:\s*platformAdminPromoWriteStatus\(currentUser\.id\)/);
assert.doesNotMatch(ui, /ข้อมูลจริงจาก Preview Supabase พร้อม Audit Log/);
assert.match(ui, /ข้อมูลจาก Production Supabase/);
assert.match(ui, /promoWriteEnabled/);
assert.match(ui, /หน้านี้เป็นแบบอ่านอย่างเดียว/);
console.log("Platform Admin Production Promo read-only UI/write-gate checks passed.");
