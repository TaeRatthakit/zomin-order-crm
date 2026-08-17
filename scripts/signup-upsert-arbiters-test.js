const fs = require("fs");
const path = require("path");

const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20260817003000_signup_bootstrap_upsert_arbiters.sql");
const sql = fs.readFileSync(migrationPath, "utf8").toLowerCase();

[
  "create unique index if not exists uniq_settings_tenant_key_upsert",
  "on public.settings (tenant_id, key)",
  "create unique index if not exists uniq_follow_up_rules_tenant_jars_upsert",
  "on public.follow_up_rules (tenant_id, jars)"
].forEach(token => {
  if (!sql.includes(token)) throw new Error(`missing token: ${token}`);
});

if (sql.includes(" where ")) {
  throw new Error("upsert arbiter indexes must not be partial");
}

console.log("Signup upsert arbiter migration checks passed.");
