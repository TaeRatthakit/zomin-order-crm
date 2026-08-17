const fs = require("fs");
const path = require("path");

const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20260817001000_restore_signup_bootstrap_idempotency.sql");
const sql = fs.readFileSync(migrationPath, "utf8").toLowerCase();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

[
  "create table if not exists public.signup_bootstraps",
  "idempotency_key text primary key",
  "user_id text not null references public.users(id) on delete restrict",
  "tenant_id uuid not null references public.tenants(id) on delete restrict",
  "alter table public.signup_bootstraps enable row level security",
  "execute function public.set_updated_at()"
].forEach(token => assert(sql.includes(token), `missing token: ${token}`));

console.log("Signup bootstrap idempotency table migration checks passed.");
