"use strict";

// Explicit opt-in only: real SQL against the single approved Preview project.
// Transactions always ROLLBACK, including a migration rehearsal. No HTTP request
// to Stripe/LINE, no Production access, no password/hash on disk or argv/logs.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { hashPassword, verifyPassword } = require("../lib/auth");
const root = path.resolve(__dirname, "..");
const project = "enwabsfsmwwcwwirdwok";
const mode = process.argv[2];
if (!["--rehearse-preview", "--verify-preview"].includes(mode)) {
  throw new Error("Explicit --rehearse-preview or --verify-preview required; no other datasource is allowed");
}
const password = crypto.randomBytes(32).toString("base64url");
const hash = hashPassword(password);
if (!verifyPassword(password, hash)) throw new Error("Disposable credential self-check failed");
const migration = mode === "--rehearse-preview"
  ? fs.readFileSync(path.join(root, "supabase/migrations/20260831000000_promo_service_entitlement.sql"), "utf8")
    .replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "")
  : "";
const tests = fs.readFileSync(path.join(root, "scripts/promo-service-entitlement-preview.sql"), "utf8");
const sql = `begin; set local statement_timeout='45s';
  select set_config('growup.test_project','${project}',true);
  select set_config('growup.test_password_hash','${hash}',true);
  ${migration}\n${tests}\nrollback;`;
const result = spawnSync("npx", ["--no-install", "supabase", "db", "query", "--linked", "--project-ref", project, "--file", "/dev/stdin"], {
  cwd: root, input: sql, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024
});
const redact = value => String(value || "").split(hash).join("[REDACTED]").split(password).join("[REDACTED]");
if (result.status !== 0) {
  console.error(redact([result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")));
  process.exit(1);
}
console.log(redact(result.stdout));
console.log(`Preview ${mode} passed; fixture data and rehearsal DDL rolled back.`);
