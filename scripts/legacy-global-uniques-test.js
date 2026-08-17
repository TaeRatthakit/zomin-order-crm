const fs = require("fs");
const path = require("path");

const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20260817004000_drop_legacy_global_signup_uniques.sql");
const sql = fs.readFileSync(migrationPath, "utf8").toLowerCase();

[
  "alter table public.settings",
  "drop constraint if exists settings_key_key",
  "alter table public.follow_up_rules",
  "drop constraint if exists follow_up_rules_jars_key"
].forEach(token => {
  if (!sql.includes(token)) throw new Error(`missing token: ${token}`);
});

if (/drop\s+table|delete\s+from|truncate\s+table|drop\s+constraint\s+if\s+exists\s+users_username_key/i.test(sql)) {
  throw new Error("legacy uniqueness migration must not delete data or weaken user identity constraints");
}

console.log("Legacy global unique constraint migration checks passed.");
