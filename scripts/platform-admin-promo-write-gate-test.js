"use strict";

process.env.NODE_ENV = "test";

const { promoWriteGate } = require("../lib/platform-admin");

const PREVIEW_URL = "https://enwabsfsmwwcwwirdwok.supabase.co";
const PRODUCTION_URL = "https://mjnpzdmrqweugdnvlqwq.supabase.co";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decision(overrides = {}) {
  return promoWriteGate({
    environment: "production",
    datasourceUrl: PRODUCTION_URL,
    previewWriteFlag: "false",
    productionWriteFlag: "true",
    userId: "u_admin",
    authorizedIdentity: "u_admin",
    ...overrides
  });
}

assert(decision().allowed === true, "authorized Production gate must allow the mocked write path");
assert(decision({ environment: "preview", datasourceUrl: PREVIEW_URL, previewWriteFlag: "true" }).allowed === true, "approved Preview gate must remain enabled");

for (const [name, overrides] of [
  ["Production flag false", { productionWriteFlag: "false" }],
  ["Production flag missing", { productionWriteFlag: "" }],
  ["Production with Preview datasource", { datasourceUrl: PREVIEW_URL }],
  ["Preview with Production datasource", { environment: "preview", datasourceUrl: PRODUCTION_URL, previewWriteFlag: "true" }],
  ["Preview flag false", { environment: "preview", datasourceUrl: PREVIEW_URL, previewWriteFlag: "false" }],
  ["Preview flag missing", { environment: "preview", datasourceUrl: PREVIEW_URL, previewWriteFlag: "" }],
  ["Unknown Vercel environment", { environment: "development" }],
  ["Missing datasource", { datasourceUrl: "" }],
  ["Invalid user", { userId: "u_owner" }],
  ["Missing membership", { authorizedIdentity: "" }],
  ["Ambiguous membership", { authorizedIdentity: "" }],
  ["Unauthenticated identity", { userId: "" }]
]) {
  assert(decision(overrides).allowed === false, `${name} must fail closed`);
}

console.log("Platform Admin Promo Production write-gate checks passed.");
