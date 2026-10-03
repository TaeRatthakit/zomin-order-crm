"use strict";

// Local PostgreSQL proof, not a mock implementation of the transaction. Install
// @electric-sql/pglite@0.5.8 outside the app and set ORDER_SAFETY_PGLITE_MODULE to
// that module's path. No app dependency, remote database or external fetch is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { PGlite } = require(process.env.ORDER_SAFETY_PGLITE_MODULE || "@electric-sql/pglite");
const root = path.join(__dirname, "..");
const migration = "supabase/migrations/20261003100135_order_create_idempotency.sql";
process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://order-safety-local.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-not-a-secret";
process.env.SESSION_SECRET = "order-safety-local-session-not-a-secret";
process.env.VERCEL_ENV = "preview";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

async function main() {
  const pg = new PGlite();
  try {
    await pg.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    for (const file of ["supabase/schema.sql", "supabase/migration-tenancy-phase1.sql"]) {
      await pg.exec(fs.readFileSync(path.join(root, file), "utf8").replace(/create extension if not exists pgcrypto;/g, ""));
    }
    // Match the inspected Preview arbiters, in this disposable local DB only.
    await pg.exec(`alter table public.settings drop constraint settings_key_key;
      create unique index settings_tenant_key on public.settings(tenant_id,key);
      create unique index tags_tenant_name on public.tags(tenant_id,name);
      create table public.subscriptions(id text,tenant_id uuid);
      create table public.payments(id text,tenant_id uuid);
      grant all on all tables in schema public to service_role;`);
    await pg.exec(fs.readFileSync(path.join(root, migration), "utf8"));
    const { hashPassword, createSession, sessionCookie } = require("../lib/auth");
    for (let i = 0; i < ids.length; i += 1) {
      await pg.query("insert into public.tenants(id,name) values($1,$2)", [ids[i], `Order safety ${i}`]);
      await pg.query("insert into public.users(id,username,password_hash,name,role) values($1,$1,$2,$1,'Owner')", [`owner${i}`, hashPassword("local-only")]);
      await pg.query("insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'Owner')", [ids[i], `owner${i}`]);
      await pg.query("insert into public.settings(id,tenant_id,key,value) values($1,$2,'products',$3::jsonb)", [`${ids[i]}:products`, ids[i], JSON.stringify([{ id: "qa-product", name: "QA product", stockQuantity: 10, stockTrackingEnabled: true }])]);
    }
    let failBeforeCommit = false;
    let loseCommitResponse = false;
    const queryRows = async table => (await pg.query(`select to_jsonb(t) as row from public.${table} t`)).rows.map(row => row.row);
    global.fetch = async (input, options = {}) => {
      const url = new URL(input);
      assert.equal(url.origin, process.env.SUPABASE_URL, "external network is forbidden");
      const table = url.pathname.split("/").pop();
      if (url.pathname.includes("/rpc/")) {
        assert.equal(table, "growup_create_order_once", "only the dedicated create RPC is permitted");
        const args = JSON.parse(options.body);
        if (failBeforeCommit) { failBeforeCommit = false; args.p_products_after = null; }
        try {
          const keys = ["p_tenant_id", "p_actor_user_id", "p_token", "p_fingerprint", "p_order", "p_customer", "p_customer_before", "p_orders_before", "p_customer_tags_before", "p_products_before", "p_products_after", "p_customer_tags"];
          const values = keys.map((key, i) => i < 4 ? args[key] : args[key] == null ? null : JSON.stringify(args[key]));
          const sql = `select public.growup_create_order_once(${keys.map((_, i) => `$${i + 1}${i === 0 ? "::uuid" : i >= 4 ? "::jsonb" : "::text"}`).join(",")}) as result`;
          const result = (await pg.query(sql, values)).rows[0].result;
          if (loseCommitResponse) { loseCommitResponse = false; return new Response(JSON.stringify({ message: "simulated response lost AFTER commit" }), { status: 500 }); }
          return Response.json(result);
        } catch (error) { return new Response(JSON.stringify({ message: error.message, code: error.code }), { status: 409 }); }
      }
      assert.equal(options.method || "GET", "GET", "all effects must be written through the transaction");
      assert.ok(/^[a-z_]+$/.test(table));
      let rows = await queryRows(table);
      for (const [key, filter] of url.searchParams) {
        if (["select", "limit", "order", "offset"].includes(key) || key.includes(".")) continue;
        if (filter.startsWith("eq.")) rows = rows.filter(row => String(row[key]) === filter.slice(3));
        else if (filter.startsWith("in.(")) rows = rows.filter(row => filter.slice(4, -1).split(",").includes(String(row[key])));
        else if (filter === "is.null") rows = rows.filter(row => row[key] == null);
      }
      if (table === "users" && url.searchParams.get("select")?.includes("tenant_memberships")) {
        const memberships = await queryRows("tenant_memberships");
        const tenants = await queryRows("tenants");
        rows = rows.map(row => ({ ...row, tenant_memberships: memberships.filter(m => m.user_id === row.id)
          .map(m => ({ ...m, tenant: tenants.find(t => t.id === m.tenant_id) })) }));
      }
      const limit = Number(url.searchParams.get("limit") || rows.length || 1);
      const offset = Number(url.searchParams.get("offset") || 0);
      return Response.json(rows.slice(offset, offset + limit));
    };
    const appHandler = require("../server");
    const cookies = ids.map((_id, i) => {
      const session = createSession({ id: `owner${i}`, role: "Owner" });
      return sessionCookie(session.token, session.expiresAt).split(";")[0];
    });
    async function request(body, tenant = 0, cookie = cookies[tenant], handler = appHandler) {
      const req = Readable.from([JSON.stringify(body)]);
      req.method = "POST"; req.url = "/api/orders";
      req.headers = { host: "order-safety-local.test", "content-type": "application/json", cookie };
      return new Promise((resolve, reject) => {
        const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; },
          end(data) { resolve({ status: this.statusCode, body: JSON.parse(data || "{}") }); } };
        Promise.resolve(handler(req, res)).catch(reject);
      });
    }
    const payload = { name: "QA customer", phone: "0800012345", productId: "qa-product", items: "QA product", amount: 100, jars: 1, date: "2026-10-03", time: "10:00", tags: "QA safety", clientMutationId: "same-operation" };
    async function snapshot(tenant = 0) {
      const orders = (await queryRows("orders")).filter(row => row.tenant_id === ids[tenant]);
      const customers = (await queryRows("customers")).filter(row => row.tenant_id === ids[tenant]);
      const products = (await queryRows("settings")).find(row => row.tenant_id === ids[tenant] && row.key === "products").value;
      const operations = (await queryRows("order_create_operations")).filter(row => row.tenant_id === ids[tenant]);
      return { count: orders.length, stock: products[0].stockQuantity, purchases: customers.reduce((sum, c) => sum + c.purchase_count, 0), operations: operations.length };
    }
    const before = await snapshot();
    if (process.env.ORDER_SAFETY_TEST_SERVE) {
      assert.equal((await request(payload)).status, 200);
      const http = require("node:http");
      const server = http.createServer(appHandler);
      await new Promise(resolve => server.listen(Number(process.env.ORDER_SAFETY_TEST_SERVE), "127.0.0.1", resolve));
      console.log("LOCAL_ORDER_SAFETY_SERVER_READY", server.address().port);
      await new Promise(resolve => server.on("close", resolve));
      return;
    }
    const first = await request(payload); assert.equal(first.status, 200, JSON.stringify(first));
    assert.ok(first.body.mutation.order.id); assert.ok(first.body.mutation.order.customerId);
    const afterFirst = await snapshot(); assert.deepEqual(afterFirst, { count: 1, stock: 9, purchases: 1, operations: 1 });
    const retry = await request(payload); assert.equal(retry.status, 200, JSON.stringify(retry));
    assert.equal(first.body.mutation.order.id, retry.body.mutation.order.id); assert.deepEqual(await snapshot(), afterFirst);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => request({ ...payload, clientMutationId: "concurrent" })));
    concurrent.forEach(res => assert.equal(res.status, 200, JSON.stringify(res)));
    assert.equal(new Set(concurrent.map(res => res.body.mutation.order.id)).size, 1);
    assert.deepEqual(await snapshot(), { count: 2, stock: 8, purchases: 2, operations: 2 });
    const conflictBefore = await snapshot();
    const conflict = await request({ ...payload, amount: 101 }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "ORDER_CREATE_TOKEN_CONFLICT");
    assert.deepEqual(await snapshot(), conflictBefore);
    const different = await request({ ...payload, clientMutationId: "different" }); assert.equal(different.status, 200);
    assert.notEqual(different.body.mutation.order.id, first.body.mutation.order.id);
    const crossTenant = await request({ ...payload, phone: "0800098765" }, 1); assert.equal(crossTenant.status, 200, JSON.stringify(crossTenant));
    assert.notEqual(crossTenant.body.mutation.order.id, first.body.mutation.order.id);
    assert.deepEqual(await snapshot(1), { count: 1, stock: 9, purchases: 1, operations: 1 });
    const failureBefore = await snapshot();
    failBeforeCommit = true;
    const failed = await request({ ...payload, clientMutationId: "rollback" }); assert.ok(failed.status >= 400);
    assert.deepEqual(await snapshot(), failureBefore, "late SQL failure must roll back order, customer, stock and operation");
    assert.equal((await request({ ...payload, clientMutationId: "rollback" })).status, 200);
    const ambiguousBefore = await snapshot(); loseCommitResponse = true;
    const ambiguous = await request({ ...payload, clientMutationId: "lost-response" }); assert.ok(ambiguous.status >= 400);
    const committed = await snapshot(); assert.equal(committed.count, ambiguousBefore.count + 1);
    const replay = await request({ ...payload, clientMutationId: "lost-response" }); assert.equal(replay.status, 200);
    assert.deepEqual(await snapshot(), committed);
    const authBefore = await snapshot();
    const unauthenticated = await request(payload, 0, "");
    // Orders' existing no-session entry path fails closed through the tenant
    // guard. Compare its exact status with owner-approved source when supplied;
    // do not change authentication routing to conceal a pre-existing 500.
    if (process.env.ORDER_SAFETY_REFERENCE_ROOT) {
      const reference = require(path.join(process.env.ORDER_SAFETY_REFERENCE_ROOT, "server.js"));
      const previous = await request(payload, 0, "", reference);
      console.log("UNAUTHENTICATED_BASELINE", JSON.stringify({ candidate: unauthenticated.status, approved: previous.status }));
      assert.equal(unauthenticated.status, previous.status, "authentication routing must remain identical to approved source");
    }
    assert.ok(unauthenticated.status >= 400, "unauthenticated create must fail closed");
    assert.deepEqual(await snapshot(), authBefore, "unauthenticated create must have zero effects");
    await pg.query("update public.tenant_memberships set is_active=false where tenant_id=$1", [ids[1]]);
    const inactive = await request({ ...payload, clientMutationId: "inactive" }, 1); assert.ok([401, 403].includes(inactive.status));
    assert.deepEqual(await snapshot(1), { count: 1, stock: 9, purchases: 1, operations: 1 });
    const security = (await pg.query(`select has_function_privilege('anon', 'public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE') as service,
      (select relrowsecurity from pg_class where oid='public.order_create_operations'::regclass) as rls,
      (select prosecdef from pg_proc where oid='public.growup_create_order_once(uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure) as definer`)).rows[0];
    assert.deepEqual(security, { anon: false, authenticated: false, service: true, rls: true, definer: false });
    await require("./order-save-confirmation-test").main();
    console.log(JSON.stringify({ status: "PASS — LOCAL POSTGRESQL; live multi-session Preview proof still required", before, afterFirst, afterRetry: afterFirst, final: await snapshot(), security }, null, 2));
  } finally { await pg.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
