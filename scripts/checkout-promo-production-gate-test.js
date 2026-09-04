"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { checkoutPromoEnabled } = require("../lib/checkout-promo");

const preview = "https://enwabsfsmwwcwwirdwok.supabase.co";
const production = "https://mjnpzdmrqweugdnvlqwq.supabase.co";
const base = { VERCEL_ENV: "production", CHECKOUT_PROMO_ENABLED: "true", DATABASE_PROVIDER: "supabase", SUPABASE_URL: production };
assert.equal(checkoutPromoEnabled(base), true);
assert.equal(checkoutPromoEnabled({ ...base, SUPABASE_URL: preview }), false);
assert.equal(checkoutPromoEnabled({ ...base, CHECKOUT_PROMO_ENABLED: "false" }), false);
assert.equal(checkoutPromoEnabled({ ...base, DATABASE_PROVIDER: "json" }), false);
assert.equal(checkoutPromoEnabled({ ...base, VERCEL_ENV: "development" }), false);

const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const renderStart = source.indexOf("function renderSettingsSubscription");
const confirmStart = source.indexOf("async function beginSubscriptionCheckoutForUi", renderStart);
assert.ok(renderStart >= 0 && confirmStart > renderStart, "subscription payment renderer missing");
const renderSource = source.slice(renderStart, confirmStart);
assert.doesNotMatch(renderSource, /(?:fetch|api)\s*\([^)]*\/api\/billing\/(?:checkout|upgrade)/i, "rendering must not create a PaymentIntent");
assert.match(renderSource, /\/api\/billing\/promo\/quote/, "payment page must validate Promo through the quote endpoint");
assert.match(source, /promotionCode:\s*applied\?\.quote\?\.code\s*\|\|\s*""/, "explicit confirmation must pass the applied server quote");

console.log("Production consumer gate and no-preconfirm-PaymentIntent checks passed.");
