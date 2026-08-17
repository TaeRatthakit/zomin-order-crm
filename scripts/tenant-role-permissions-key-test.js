const fs = require("fs");
const path = require("path");

const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20260817002000_tenant_role_permissions_unique_key.sql");
const sql = fs.readFileSync(migrationPath, "utf8").toLowerCase();

if (!sql.includes("create unique index if not exists uniq_tenant_role_permissions_tenant_role")) {
  throw new Error("tenant role permissions unique index migration is missing");
}
if (!sql.includes("on public.tenant_role_permissions (tenant_id, role)")) {
  throw new Error("tenant role permissions unique index columns are wrong");
}

console.log("Tenant role permissions unique key migration checks passed.");
