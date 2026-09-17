"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { COMPOSITE_CONFLICTS } = require("../lib/db/supabase-adapter");
const {
  SCHEMA_METADATA_SQL,
  REVIEWED_PARTIAL_INDEXES,
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

function assertThrows(callback, message) {
  try {
    callback();
  } catch {
    return;
  }
  fail(message);
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

result = evaluateSchemaContract({ indexes: fixtureIndexes({
  subscriptions: {
    index_name: REVIEWED_PARTIAL_INDEXES.subscriptions.indexName,
    is_partial: true,
    predicate: REVIEWED_PARTIAL_INDEXES.subscriptions.predicate
  }
}) });
assert(result.ok, "exact reviewed initial-subscription partial index should pass");

result = evaluateSchemaContract({ indexes: fixtureIndexes({
  subscriptions: {
    index_name: REVIEWED_PARTIAL_INDEXES.subscriptions.indexName,
    is_partial: true,
    predicate: "(status = 'active')"
  }
}) });
assert(!result.ok, "wrong subscriptions partial predicate should fail");

result = evaluateSchemaContract({ indexes: fixtureIndexes({
  subscriptions: {
    index_name: "unreviewed_subscriptions_index",
    is_partial: true,
    predicate: REVIEWED_PARTIAL_INDEXES.subscriptions.predicate
  }
}) });
assert(!result.ok, "unreviewed subscriptions partial index name should fail");

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
assert(SCHEMA_METADATA_SQL.includes("pg_index") && SCHEMA_METADATA_SQL.includes("indpred") && SCHEMA_METADATA_SQL.includes("pg_get_expr"), "schema guard must inspect actual PostgreSQL indexes and partial predicates");

const validCliIndexes = fixtureIndexes({
  subscriptions: {
    index_name: REVIEWED_PARTIAL_INDEXES.subscriptions.indexName,
    is_partial: true,
    predicate: REVIEWED_PARTIAL_INDEXES.subscriptions.predicate
  }
});
function cliOutput(indexes = validCliIndexes) {
  return JSON.stringify({ rows: [{ coalesce: JSON.stringify(indexes) }] });
}

calls = 0;
let cliWorkdir = "";
const cliInspected = readOnlySchemaMetadata({
  env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
  exec(command, args) {
    calls += 1;
    assert(command === "supabase", "schema guard should use the authenticated Supabase CLI fallback");
    cliWorkdir = args[args.indexOf("--workdir") + 1];
    assert(cliWorkdir.startsWith(`${os.tmpdir()}${path.sep}growup-supabase-schema-`), "Supabase fallback must isolate CLI state outside the repository");
    assert(args.includes("db") && args.includes("query") && args.includes("--linked"), "Supabase fallback must use linked database query");
    assert(args[args.indexOf("--project-ref") + 1] === "abcdefghijklmnopqrst", "Supabase fallback must target the explicit project ref");
    assert(args.includes(SCHEMA_METADATA_SQL), "Supabase fallback must execute the exact schema SQL");
    return cliOutput();
  }
});
assert(calls === 1, "Supabase fallback should perform one live query");
assert(!fs.existsSync(cliWorkdir), "Supabase fallback must remove generated CLI state");
assert(evaluateSchemaContract({ indexes: cliInspected }).ok, "valid Supabase CLI metadata should pass the same contract");

const invalidConfiguredUrl = readOnlySchemaMetadata({
  env: {
    SUPABASE_DB_URL: "export SUPABASE_DB_URL=not-a-raw-uri",
    SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst"
  },
  exec(command) {
    assert(command === "supabase", "invalid database URL text must use the authenticated CLI fallback");
    return cliOutput();
  }
});
assert(evaluateSchemaContract({ indexes: invalidConfiguredUrl }).ok, "invalid URL text should not block an authenticated CLI inspection");

const wrongCliIndex = readOnlySchemaMetadata({
  env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
  exec() {
    return cliOutput(fixtureIndexes({
      subscriptions: {
        index_name: "unreviewed_subscriptions_index",
        is_partial: true,
        predicate: REVIEWED_PARTIAL_INDEXES.subscriptions.predicate
      }
    }));
  }
});
assert(!evaluateSchemaContract({ indexes: wrongCliIndex }).ok, "wrong Supabase CLI index name must block");

const wrongCliPredicate = readOnlySchemaMetadata({
  env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
  exec() {
    return cliOutput(fixtureIndexes({
      subscriptions: {
        index_name: REVIEWED_PARTIAL_INDEXES.subscriptions.indexName,
        is_partial: true,
        predicate: "(status = 'active')"
      }
    }));
  }
});
assert(!evaluateSchemaContract({ indexes: wrongCliPredicate }).ok, "wrong Supabase CLI predicate must block");

const unapprovedPartial = readOnlySchemaMetadata({
  env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
  exec() {
    return cliOutput(fixtureIndexes({ customer_tags: { is_partial: true, predicate: "(tenant_id is not null)" } }));
  }
});
assert(!evaluateSchemaContract({ indexes: unapprovedPartial }).ok, "unapproved partial index must block");

assertThrows(
  () => readOnlySchemaMetadata({
    env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
    exec() { throw new Error("CLI authentication failed"); }
  }),
  "Supabase CLI authentication failure must block"
);
assertThrows(
  () => readOnlySchemaMetadata({
    env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
    exec() { throw new Error("CLI query failed"); }
  }),
  "Supabase CLI query failure must block"
);
assertThrows(
  () => readOnlySchemaMetadata({
    env: { SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
    exec() { return "not-json"; }
  }),
  "unparseable Supabase CLI output must block"
);
assertThrows(
  () => readOnlySchemaMetadata({
    env: { SUPABASE_SCHEMA_METADATA_JSON: cliOutput() },
    exec() { throw new Error("caller metadata must not be used"); }
  }),
  "caller-supplied fake metadata must not make the gate pass"
);

console.log("Production schema contract tests passed.");
