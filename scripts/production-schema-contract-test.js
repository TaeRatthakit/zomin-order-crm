"use strict";

const fs = require("fs");
const path = require("path");
const { COMPOSITE_CONFLICTS } = require("../lib/db/supabase-adapter");
const {
  SCHEMA_METADATA_SQL,
  evaluateSchemaContract,
  readOnlySchemaMetadata
} = require("./production-schema-contract");

const migrationPath = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260820060000_customer_tags_upsert_arbiter.sql"
);
const migration = fs.readFileSync(migrationPath, "utf8").toLowerCase();

function fail(message) {
  throw new Error(`Production schema contract test failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function fixtureIndexes(overrides = {}) {
  return Object.entries(COMPOSITE_CONFLICTS).map(([table, target]) => ({
    table_name: table,
    index_name: `uniq_${table}`,
    constraint_name: "",
    is_unique: true,
    is_exclusion: false,
    is_partial: false,
    columns: target.split(","),
    ...overrides[table]
  }));
}

assert(migration.includes("create unique index if not exists uniq_customer_tags_tenant_customer_tag_upsert"), "migration must create the reviewed index");
assert(migration.includes("on public.customer_tags (tenant_id, customer_id, tag_name)"), "migration must match the application conflict target");
assert(migration.includes("having count(*) > 1"), "migration must fail closed on duplicate logical identities");
const migrationSql = migration.replace(/--[^\n]*/g, "");
assert(!/\b(drop|delete|truncate)\b/.test(migrationSql), "migration must not contain destructive operations");

let result = evaluateSchemaContract({ indexes: fixtureIndexes() });
assert(result.ok, "all matching non-partial arbiters should pass");

result = evaluateSchemaContract({ indexes: fixtureIndexes({ customer_tags: { is_partial: true } }) });
assert(!result.ok, "partial customer_tags arbiter should fail");
assert(result.unresolved.some(row => row.table === "customer_tags" && row.status === "PARTIAL/INCOMPATIBLE"), "partial result should identify customer_tags");

result = evaluateSchemaContract({ indexes: fixtureIndexes({ customer_tags: { columns: ["tenant_id", "customer_id"] } }) });
assert(!result.ok, "wrong conflict columns should fail");
assert(result.unresolved.some(row => row.table === "customer_tags" && row.status === "MISSING ARBITER"), "missing result should identify customer_tags");

let calls = 0;
const inspected = readOnlySchemaMetadata({
  env: { DATABASE_URL: "postgresql://redacted.example/db" },
  exec(command, args) {
    calls += 1;
    assert(command === "psql", "schema guard should use the configured read-only client");
    assert(args.includes("--no-psqlrc"), "schema guard should disable local psql config");
    const sql = args[args.indexOf("--command") + 1];
    assert(/^\s*select\b/i.test(sql), "schema guard SQL must be read-only");
    assert(!/\b(insert|update|delete|alter|drop|truncate|create)\b/i.test(sql), "schema guard SQL must not mutate");
    return "[]\n";
  }
});
assert(calls === 1 && Array.isArray(inspected), "schema guard should perform one metadata read");
assert(SCHEMA_METADATA_SQL.includes("pg_index") && SCHEMA_METADATA_SQL.includes("indpred"), "schema guard must inspect actual PostgreSQL indexes and partial predicates");

console.log("Production schema contract tests passed.");
