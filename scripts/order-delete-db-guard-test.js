"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const migrationName = fs.readdirSync(path.join(root, "supabase", "migrations"))
  .find(name => name.endsWith("_order_delete_explicit_intent.sql"));
const migration = fs.readFileSync(path.join(root, "supabase", "migrations", migrationName), "utf8");

assert(migration.includes("create table if not exists public.order_delete_intents"));
assert(migration.includes("create or replace function public.create_order_delete_intent"));
assert(migration.includes("create or replace function public.delete_order_with_confirmed_intent"));
assert(migration.includes("create or replace function public.require_same_transaction_order_delete_audit()"));
assert(migration.includes("before delete on public.orders") || fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260920000000_order_delete_db_guard.sql"), "utf8"
).includes("before delete on public.orders"));
assert(migration.includes("audit.delete_intent_id"));
assert(migration.includes("audit.deletion_proof = 'EXPLICIT_USER_CONFIRMED_DELETE'"));
assert(migration.includes("intent.consumed_transaction_id = pg_catalog.txid_current()"));
assert(migration.includes("raise exception 'ORDER_DELETE_EXPLICIT_USER_INTENT_REQUIRED'"));
assert(migration.includes("raise exception 'IMPORT_CLEANUP_ORDER_DELETE_FORBIDDEN'"));
assert(migration.includes("constraint_row.confdeltype = 'c'"));
assert(migration.includes("constraint orders_customer_id_fkey"));
assert(migration.includes("constraint customers_tenant_id_id_key unique (tenant_id, id)"));
assert(migration.includes("on delete restrict"));
assert(migration.indexOf("insert into public.order_deletion_audit") < migration.indexOf("delete from public.orders"));
assert(migration.indexOf("update public.order_delete_intents") < migration.indexOf("delete from public.orders"));

const changed = childProcess.execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/).filter(Boolean);
const publicChanges = changed.filter(file => file.startsWith("public/"));
assert.deepStrictEqual(publicChanges, ["public/app.js"], "only the non-visual delete handshake may change under public/");
assert(!changed.some(file => /^(?:ui-baselines\/|public\/styles\.css$|public\/index\.html$|public\/.*\.(?:png|jpe?g|webp|svg)$)/i.test(file)),
  "Golden UI layout, styles, baseline, or assets changed");

console.log("Order delete DB guard tests passed.");
