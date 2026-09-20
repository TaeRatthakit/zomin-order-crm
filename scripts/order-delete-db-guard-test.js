"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260920000000_order_delete_db_guard.sql"),
  "utf8"
);

assert(migration.includes("create or replace function public.require_same_transaction_order_delete_audit()"));
assert(migration.includes("before delete on public.orders"));
assert(migration.includes("audit.tenant_id = old.tenant_id"));
assert(migration.includes("audit.order_id = old.id"));
assert(migration.includes("audit.action = 'order_delete'"));
assert(migration.includes("audit.xmin::text = txid_current()::text"));
assert(migration.includes("raise exception 'ORDER_DELETE_AUDIT_REQUIRED'"));
assert(!/^\s*(?:update|delete|truncate)\s+/im.test(migration), "guard migration must not mutate existing business rows");
assert(!/^\s*alter\s+table\s+public\.(?:orders|customers|settings)\b/im.test(migration), "guard migration must not rewrite business tables");

const deleteAuditMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260912000000_order_delete_audit.sql"),
  "utf8"
);
const destructiveMigration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260912010000_destructive_path_hardening.sql"),
  "utf8"
);

for (const sql of [deleteAuditMigration, destructiveMigration]) {
  const inserts = [...sql.matchAll(/insert into public\.order_deletion_audit/g)].map(match => match.index);
  const deletes = [...sql.matchAll(/delete from public\.orders/g)].map(match => match.index);
  assert(inserts.length > 0, "approved destructive path must write an order audit");
  assert(deletes.length > 0, "approved destructive path must contain an order delete");
  assert(Math.min(...inserts) < Math.min(...deletes), "audit must be written before order deletion");
}

const frontendDiff = require("child_process").execFileSync(
  "git",
  ["diff", "--name-only", "HEAD"],
  { cwd: root, encoding: "utf8" }
);
assert(!frontendDiff.split(/\r?\n/).some(file => /^(?:public\/|ui-baselines\/)/.test(file)), "frontend or Golden UI files changed");

console.log("Order delete DB guard tests passed.");
