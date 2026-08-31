"use strict";
// Hard-pinned Preview transaction rehearsal. No external Stripe/LINE call.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { hashPassword, verifyPassword } = require("../lib/auth");
const root = path.resolve(__dirname, "..");
const project = "enwabsfsmwwcwwirdwok";
const mode = process.argv[2];
if (!["--rehearse-preview", "--verify-preview"].includes(mode)) throw new Error("Explicit Preview mode required");
const password = crypto.randomBytes(32).toString("base64url");
const hash = hashPassword(password);
if (!verifyPassword(password, hash)) throw new Error("Fixture hash verification failed");
const migration = mode === "--rehearse-preview"
  ? fs.readFileSync(path.join(root,"supabase/migrations/20260901000000_checkout_promo_reservations.sql"),"utf8")
    .replace(/^begin;\s*$/m,"").replace(/^commit;\s*$/m,"") : "";
const sql = `begin; set local statement_timeout='45s';
  select set_config('growup.test_password_hash','${hash}',true);
  select set_config('growup.test_project','${project}',true);
  ${migration}
  ${mode === "--rehearse-preview" ? fs.readFileSync(path.join(root,"scripts/promo-service-entitlement-preview.sql"),"utf8") : ""}
  ${fs.readFileSync(path.join(root,"scripts/checkout-promo-preview.sql"),"utf8")}
  ${mode === "--rehearse-preview" ? fs.readFileSync(path.join(root,"supabase/migrations/20260901010000_zero_payment_promo_entitlements.sql"),"utf8").replace(/^begin;\s*$/m,"").replace(/^commit;\s*$/m,"") : ""}
  ${fs.readFileSync(path.join(root,"scripts/zero-payment-promo-preview.sql"),"utf8")}
  rollback;`;
const result = spawnSync("npx",["--no-install","supabase","db","query","--linked","--project-ref",project,"--file","/dev/stdin"],
  {cwd:root,input:sql,encoding:"utf8",timeout:90000,maxBuffer:4*1024*1024});
const redact = value => String(value || "").split(hash).join("[REDACTED]").split(password).join("[REDACTED]");
if (result.status !== 0) { console.error(redact([result.stderr,result.stdout,result.error?.message].filter(Boolean).join("\n"))); process.exit(1); }
console.log(redact(result.stdout));
console.log(`Checkout Promo ${mode} passed; all fixtures/rehearsal DDL rolled back in ${project}.`);
