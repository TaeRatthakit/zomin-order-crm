"use strict";

const assert = require("assert");

const TENANT_ID = "tenant-contact-log-pagination";
const OTHER_TENANT_ID = "tenant-contact-log-other";
const CUSTOMER_ID = "customer-contact-log-pagination";
const ORDER_ID = "order-contact-log-pagination";
const CONTACT_LOG_COUNT = 1449;
const CRM_RESULT = "CRMเรียบร้อยแล้ว";

const tenantLogs = Array.from({ length: CONTACT_LOG_COUNT }, (_, index) => {
  const sequence = index + 1;
  const isCompletion = sequence === CONTACT_LOG_COUNT;
  return {
    id: `contact-${String(sequence).padStart(4, "0")}`,
    tenant_id: TENANT_ID,
    customer_id: CUSTOMER_ID,
    contact_date: isCompletion ? "2026-11-20" : "2026-11-19",
    contacted_by: "pagination-test",
    result: isCompletion ? CRM_RESULT : "โทรติด",
    note: isCompletion ? `[[opportunityCycle:orderId=${ORDER_ID}]]` : `history-${sequence}`,
    next_follow_up_date: null,
    created_at: new Date(Date.UTC(2026, 10, 19, 0, 0, sequence)).toISOString()
  };
});

const otherTenantLog = {
  ...tenantLogs[0],
  id: "contact-other-tenant",
  tenant_id: OTHER_TENANT_ID,
  customer_id: "customer-other-tenant"
};

async function testAllTenantContactLogsAreReadAcrossStateRefreshes() {
  process.env.DATABASE_PROVIDER = "supabase";
  process.env.NODE_ENV = "test";
  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = "https://contact-log-pagination-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

  const fetchCalls = [];
  const writes = [];
  const originalFetch = global.fetch;
  const originalDateNow = Date.now;
  let now = Date.UTC(2026, 10, 20, 8, 0, 0);
  Date.now = () => now;
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/").pop();
    const method = String(options.method || "GET").toUpperCase();
    fetchCalls.push({ table, method, query: url.search });
    if (method !== "GET") writes.push({ method, url: String(input) });
    assert.strictEqual(method, "GET", "contact-log pagination regression test must not write");

    if (table === "contact_logs") {
      assert.strictEqual(url.searchParams.get("tenant_id"), `eq.${TENANT_ID}`);
      assert.strictEqual(url.searchParams.get("order"), "contact_date.asc,created_at.asc,id.asc");
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 0);
      assert.strictEqual(limit, 1000);
      const tenantScopedRows = [...tenantLogs, otherTenantLog]
        .filter(row => row.tenant_id === TENANT_ID)
        .sort((a, b) => [a.contact_date, a.created_at, a.id].join("|").localeCompare([b.contact_date, b.created_at, b.id].join("|")));
      return response(tenantScopedRows.slice(offset, offset + limit));
    }

    if (table === "customers") {
      assert.strictEqual(url.searchParams.get("tenant_id"), `eq.${TENANT_ID}`);
      return response([{
        id: CUSTOMER_ID,
        tenant_id: TENANT_ID,
        name: "Pagination Customer",
        phone: "0800000000",
        latest_address: "Test",
        created_at: "2026-11-01T00:00:00.000Z"
      }]);
    }

    if (table === "orders") {
      assert.strictEqual(url.searchParams.get("tenant_id"), `eq.${TENANT_ID}`);
      return response([{
        id: ORDER_ID,
        tenant_id: TENANT_ID,
        customer_id: CUSTOMER_ID,
        customer_name: "Pagination Customer",
        phone: "0800000000",
        order_date: "2026-11-01",
        order_time: "10:00",
        quantity: 1,
        amount: 100,
        source: "test"
      }]);
    }

    return response([]);
  };

  function response(rows) {
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(rows);
      }
    };
  }

  try {
    const adapter = require("../lib/db/supabase-adapter");
    const snapshots = [];
    for (const phase of ["state-refresh", "after-60-seconds", "navigation-reload", "re-login"]) {
      if (phase === "after-60-seconds") now += 60_000;
      const result = await adapter.withTenantContext({ tenantId: TENANT_ID, userId: `${phase}-user` }, () => adapter.readDb());
      snapshots.push(result);
    }

    for (const snapshot of snapshots) {
      assert.strictEqual(snapshot.contactLogs.length, CONTACT_LOG_COUNT, "every tenant contact log must survive readback");
      assert.strictEqual(new Set(snapshot.contactLogs.map(log => log.id)).size, CONTACT_LOG_COUNT, "pagination must not duplicate logs");
      assert(!snapshot.contactLogs.some(log => log.id === otherTenantLog.id), "another tenant's contact log must not leak");
      const completion = snapshot.contactLogs.find(log => log.result === CRM_RESULT);
      assert(completion, "CRM completion beyond the first 1,000 rows must survive state refresh");
      assert.strictEqual(completion.orderId, ORDER_ID, "CRM completion must retain its opportunity cycle");
    }

    const contactLogCalls = fetchCalls.filter(call => call.table === "contact_logs");
    assert.strictEqual(contactLogCalls.length, snapshots.length * 2, "1,449 logs require two pages for every fresh state read");
    assert.strictEqual(writes.length, 0, "state readback must not write or mutate contact history");
  } finally {
    global.fetch = originalFetch;
    Date.now = originalDateNow;
  }
}

testAllTenantContactLogsAreReadAcrossStateRefreshes()
  .then(() => console.log("contact-log-pagination-regression-test: PASS"))
  .catch(error => {
    console.error(`contact-log-pagination-regression-test: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
