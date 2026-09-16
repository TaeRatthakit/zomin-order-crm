"use strict";

const { execFileSync } = require("child_process");
const { COMPOSITE_CONFLICTS } = require("../lib/db/supabase-adapter");

const REVIEWED_PARTIAL_INDEXES = {
  subscriptions: {
    indexName: "uniq_subscriptions_initial_tenant",
    predicate: "(is_initial = true)"
  }
};

const SCHEMA_METADATA_SQL = `
select coalesce(json_agg(json_build_object(
  'table_name', table_name,
  'index_name', index_name,
  'constraint_name', constraint_name,
  'is_unique', is_unique,
  'is_exclusion', is_exclusion,
  'is_partial', is_partial,
  'predicate', predicate,
  'columns', columns
) order by table_name, index_name), '[]'::json)::text
from (
  select
    n.nspname as schema_name,
    c.relname as table_name,
    i.relname as index_name,
    con.conname as constraint_name,
    ix.indisunique as is_unique,
    ix.indisexclusion as is_exclusion,
    ix.indpred is not null as is_partial,
    pg_get_expr(ix.indpred, ix.indrelid) as predicate,
    array(
      select a.attname
      from unnest(ix.indkey) with ordinality as key(attnum, ord)
      left join pg_attribute a
        on a.attrelid = ix.indrelid
       and a.attnum = key.attnum
      order by key.ord
    ) as columns
  from pg_index ix
  join pg_class i on i.oid = ix.indexrelid
  join pg_class c on c.oid = ix.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_constraint con on con.conindid = ix.indexrelid
  where n.nspname = 'public'
    and (ix.indisunique or ix.indisexclusion)
) indexes;
`;

function normalizeColumns(value) {
  return Array.isArray(value) ? value.map(item => String(item || "").trim()) : [];
}

function normalizePredicate(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function expectedTargets(metadata = COMPOSITE_CONFLICTS) {
  return Object.entries(metadata || {}).map(([table, target]) => ({
    table,
    columns: String(target || "").split(",").map(item => item.trim()).filter(Boolean)
  }));
}

function evaluateSchemaContract({ indexes = [], conflicts = COMPOSITE_CONFLICTS } = {}) {
  const rows = Array.isArray(indexes) ? indexes : [];
  const results = expectedTargets(conflicts).map(({ table, columns }) => {
    const tableIndexes = rows.filter(row => String(row.table_name || "") === table);
    const matching = tableIndexes.filter(row => JSON.stringify(normalizeColumns(row.columns)) === JSON.stringify(columns));
    const reviewedPartial = REVIEWED_PARTIAL_INDEXES[table];
    const valid = matching.find(row => {
      if (row.is_unique !== true && row.is_exclusion !== true) return false;
      if (row.is_partial !== true) return true;
      return Boolean(
        reviewedPartial
        && row.is_unique === true
        && String(row.index_name || "") === reviewedPartial.indexName
        && normalizePredicate(row.predicate) === normalizePredicate(reviewedPartial.predicate)
      );
    });
    if (valid) {
      return {
        table,
        target: columns.join(","),
        status: "VALID ARBITER EXISTS",
        indexName: String(valid.index_name || ""),
        constraintName: String(valid.constraint_name || "")
      };
    }
    if (matching.some(row => row.is_partial === true)) {
      return { table, target: columns.join(","), status: "PARTIAL/INCOMPATIBLE" };
    }
    return { table, target: columns.join(","), status: "MISSING ARBITER" };
  });
  const unresolved = results.filter(row => row.status !== "VALID ARBITER EXISTS");
  return {
    ok: unresolved.length === 0,
    status: unresolved.length ? "BLOCKED / PRODUCTION SCHEMA CONTRACT NOT SATISFIED" : "PASS",
    results,
    unresolved
  };
}

function readOnlySchemaMetadata({ env = process.env, exec = execFileSync } = {}) {
  const databaseUrl = String(
    env.SUPABASE_DB_URL || env.DATABASE_URL || env.POSTGRES_URL || ""
  ).trim();
  if (!databaseUrl) {
    throw new Error("Production read-only schema inspection requires SUPABASE_DB_URL, DATABASE_URL, or POSTGRES_URL.");
  }
  const psql = String(env.PSQL_BIN || "psql").trim();
  const output = exec(psql, [
    "--no-psqlrc",
    "--no-align",
    "--tuples-only",
    "--set=ON_ERROR_STOP=1",
    `--dbname=${databaseUrl}`,
    "--command",
    SCHEMA_METADATA_SQL
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(String(output || "[]").trim() || "[]");
}

function main() {
  let indexes;
  try {
    indexes = readOnlySchemaMetadata();
  } catch (error) {
    console.error("BLOCKED / PRODUCTION SCHEMA CONTRACT NOT SATISFIED");
    console.error("- Read-only PostgreSQL schema inspection unavailable.");
    process.exitCode = 1;
    return;
  }
  const result = evaluateSchemaContract({ indexes });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(result.status);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  SCHEMA_METADATA_SQL,
  REVIEWED_PARTIAL_INDEXES,
  evaluateSchemaContract,
  expectedTargets,
  normalizeColumns,
  normalizePredicate,
  readOnlySchemaMetadata
};
