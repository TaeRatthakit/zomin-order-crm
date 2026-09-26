"use strict";

const assert = require("assert");

const TENANT_ID = "tenant-orders-pagination";
const OTHER_TENANT_ID = "tenant-other";
const ORDER_COUNT = 1449;

const orders = Array.from({ length: ORDER_COUNT }, (_, index) => ({
  id: `order-${String(index + 1).padStart(4, "0")}`,
  tenant_id: TENANT_ID,
  customer_id: `customer-${String(index + 1).padStart(4, "0")}`,
  order_number: `${index + 1}/26`,
  customer_name: `Customer ${index + 1}`,
  order_date: "2026-09-26",
  order_time: `${String(Math.floor(index / 60) % 24).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
  quantity: 1,
  amount: 100,
  source: "test"
}));

async function testAllTenantOrdersAreReadExactlyOnce() {
  process.env.DATABASE_PROVIDER = "supabase";
  process.env.NODE_ENV = "test";
  process.env.VERCEL_ENV = "preview";
  process.env.SUPABASE_URL = "https://orders-pagination-test.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

  const fetchCalls = [];
  const writes = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    fetchCalls.push({ table: url.pathname.split("/").pop(), method, query: url.search });
    if (method !== "GET") writes.push({ method, url: String(input) });
    assert.strictEqual(method, "GET", "orders read regression test must not write");

    if (url.pathname.endsWith("/orders")) {
      assert.strictEqual(url.searchParams.get("tenant_id"), `eq.${TENANT_ID}`);
      assert.strictEqual(url.searchParams.get("order"), "order_date.asc,order_time.asc,id.asc");
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 0);
      assert.strictEqual(limit, 1000);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(orders.slice(offset, offset + limit));
        }
      };
    }

    if (url.pathname.endsWith("/tenant_memberships") || url.pathname.endsWith("/users")) {
      return { ok: true, status: 200, async text() { return "[]"; } };
    }

    return { ok: true, status: 200, async text() { return "[]"; } };
  };

  try {
    const adapter = require("../lib/db/supabase-adapter");
    const result = await adapter.withTenantContext({ tenantId: TENANT_ID }, () => adapter.readDb());
    const returnedIds = result.orders.map(order => order.id);
    const uniqueIds = new Set(returnedIds);

    assert.strictEqual(returnedIds.length, ORDER_COUNT, "all tenant orders must be returned");
    assert.strictEqual(uniqueIds.size, ORDER_COUNT, "pagination must not duplicate order IDs");
    assert.deepStrictEqual(returnedIds, orders.map(order => order.id), "stable ordering must be preserved");
    assert.strictEqual(fetchCalls.filter(call => call.table === "orders").length, 2, "1449 orders require two pages");
    assert.strictEqual(writes.length, 0, "orders read must not write");
    assert(!orders.some(order => order.tenant_id === OTHER_TENANT_ID), "fixture must remain tenant-scoped");
  } finally {
    global.fetch = originalFetch;
  }
}

testAllTenantOrdersAreReadExactlyOnce()
  .then(() => console.log("order-pagination-regression-test: PASS"))
  .catch(error => {
    console.error(`order-pagination-regression-test: FAIL: ${error.message}`);
    process.exitCode = 1;
  });
