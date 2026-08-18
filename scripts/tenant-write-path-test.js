"use strict";

process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://tenant-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.LINE_CHANNEL_SECRET = "";
process.env.LINE_GROUP_ID = "";
process.env.LINE_WEBHOOK_TENANT_ID = "";

const db = {
  tenants: [
    { id: "tenant_a", name: "Tenant A", status: "active" },
    { id: "tenant_b", name: "Tenant B", status: "active" }
  ],
  tenant_memberships: [
    { id: "m_a_owner", tenant_id: "tenant_a", user_id: "u_a", role: "Owner", is_active: true },
    { id: "m_b_owner", tenant_id: "tenant_b", user_id: "u_b", role: "Owner", is_active: true }
  ],
  users: [
    { id: "u_a", username: "owner-a", password_hash: "hash", name: "Owner A", role: "Owner", phone: "", is_active: true },
    { id: "u_b", username: "owner-b", password_hash: "hash", name: "Owner B", role: "Owner", phone: "", is_active: true }
  ],
  settings: [
    { id: "products", key: "products", value: [{ id: "product_1", name: "Product A", stockQuantity: 10 }], tenant_id: "tenant_a" },
    { id: "lineGroupId", key: "lineGroupId", value: "group-a", tenant_id: "tenant_a" },
    { id: "lineGroupIds", key: "lineGroupIds", value: ["group-a", "group-c"], tenant_id: "tenant_a" },
    { id: "tenant_b:lineGroupId", key: "lineGroupId", value: "group-b", tenant_id: "tenant_b" },
    { id: "products_b", key: "products", value: [{ id: "product_b", name: "Product B", stockQuantity: 10 }], tenant_id: "tenant_b" }
  ],
  follow_up_rules: [],
  customers: [
    { id: "c_b", name: "B Customer", phone: "0890000000", tenant_id: "tenant_b" }
  ],
  orders: [
    { id: "o_b", customer_id: "c_b", items: "Product B", quantity: 1, amount: 100, order_date: "2026-08-08", tenant_id: "tenant_b" }
  ],
  line_messages: [],
  tags: [],
  customer_tags: [],
  contact_logs: [],
  notification_reads: [],
  tenant_role_permissions: [],
  tenant_settings: []
};

function fail(message) {
  throw new Error(message);
}

function parseValue(raw = "") {
  return decodeURIComponent(String(raw).replace(/^"|"$/g, ""));
}

function parseIn(raw = "") {
  return parseValue(raw).replace(/^\(|\)$/g, "").split(",").map(item => item.replace(/^"|"$/g, "")).filter(Boolean);
}

function applyFilters(rows, params) {
  let out = [...rows];
  for (const [key, value] of params.entries()) {
    if (["select", "limit", "order", "on_conflict"].includes(key)) continue;
    if (value.startsWith("eq.")) {
      const expected = parseValue(value.slice(3));
      out = out.filter(row => String(row[key]) === expected);
    } else if (value === "is.null") {
      out = out.filter(row => row[key] == null);
    } else if (value === "not.is.null") {
      out = out.filter(row => row[key] != null);
    } else if (value.startsWith("in.")) {
      const values = new Set(parseIn(value.slice(3)));
      out = out.filter(row => values.has(String(row[key])));
    }
  }
  return out;
}

function conflictKey(table, row, params) {
  const conflict = params.get("on_conflict") || "id";
  return conflict.split(",").map(key => `${key}:${row[key]}`).join("|");
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const table = url.pathname.split("/").pop();
  if (!Object.prototype.hasOwnProperty.call(db, table)) {
    return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  }
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const rows = applyFilters(db[table], url.searchParams);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` }
    });
  }
  if (method === "POST") {
    const rows = JSON.parse(options.body || "[]");
    for (const row of rows) {
      const key = conflictKey(table, row, url.searchParams);
      const index = db[table].findIndex(existing => conflictKey(table, existing, url.searchParams) === key);
      if (index === -1) db[table].push({ ...row });
      else db[table][index] = { ...db[table][index], ...row };
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (method === "PATCH") {
    const patch = JSON.parse(options.body || "{}");
    const rows = applyFilters(db[table], url.searchParams);
    for (const row of rows) Object.assign(row, patch);
    return new Response(null, { status: 204 });
  }
  if (method === "DELETE") {
    const rows = new Set(applyFilters(db[table], url.searchParams));
    db[table] = db[table].filter(row => !rows.has(row));
    return new Response(null, { status: 204 });
  }
  return new Response("unsupported", { status: 405 });
};

const adapter = require("../lib/db/supabase-adapter");

async function invokeApp(method, url, body = "", headers = {}) {
  const { Readable } = require("stream");
  const app = require("../server");
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, nextHeaders = {}) {
        this.statusCode = status;
        this.headers = { ...this.headers, ...nextHeaders };
      },
      end(payload = "") {
        resolve({ status: this.statusCode, headers: this.headers, body: String(payload || "") });
      }
    };
    req.on("error", reject);
    app(req, res).catch(reject);
  });
}

async function expectReject(label, task) {
  try {
    await task();
  } catch (error) {
    if (error.code === "TENANT_CONTEXT_REQUIRED") return;
    throw error;
  }
  fail(`${label} did not reject without tenant context`);
}

(async () => {
  const tenantA = await adapter.resolveTenantForUser("u_a");
  const tenantB = await adapter.resolveTenantForUser("u_b");
  if (tenantA?.tenantId !== "tenant_a" || tenantB?.tenantId !== "tenant_b") fail("tenant resolver returned wrong tenant");

  await expectReject("writeDb", () => adapter.writeDb({
    settings: {},
    followUpRules: [],
    tags: [],
    users: [],
    customers: [],
    orders: [],
    lineMessages: [],
    contactLogs: []
  }));

  await adapter.withTenantContext(tenantA, async () => {
    await adapter.persistSettingsPatch({ products: [{ id: "product_1", name: "Product A" }] });
    await adapter.persistNotificationReadIds("u_a", ["order-review:o_a:2026-08-08"]);
    await adapter.persistOrderMutation({
      customers: [{
        id: "c_a",
        name: "A Customer",
        phone: "0811111111",
        tags: ["tag-a"],
        tenant_id: null
      }],
      order: {
        id: "o_a",
        customerId: "c_a",
        customerName: "A Customer",
        phone: "0811111111",
        items: "Product A",
        jars: 1,
        amount: 750,
        date: "2026-08-08",
        tenant_id: "tenant_b"
      },
      tags: ["tag-a"],
      affectedCustomerIds: ["c_a"]
    });
    await adapter.createContactLogFast({
      customerId: "c_a",
      date: "2026-08-08",
      result: "โทรติด",
      note: "test",
      staff: "Owner A"
    });
    const cross = await adapter.createContactLogFast({
      customerId: "c_b",
      date: "2026-08-08",
      result: "โทรติด",
      note: "cross",
      staff: "Owner A"
    });
    if (cross.ok !== false || cross.status !== 404) fail("cross-tenant contact log did not fail closed");
    await adapter.deleteOrder("o_b");
  });

  const customerA = db.customers.find(row => row.id === "c_a");
  const orderA = db.orders.find(row => row.id === "o_a");
  const tagA = db.tags.find(row => row.id === "tag-a");
  const customerTagA = db.customer_tags.find(row => row.customer_id === "c_a" && row.tag_name === "tag-a");
  const logA = db.contact_logs.find(row => row.customer_id === "c_a");
  const readA = db.notification_reads.find(row => row.user_id === "u_a");
  if (customerA?.tenant_id !== "tenant_a") fail("customer create did not force tenant_a");
  if (orderA?.tenant_id !== "tenant_a") fail("order create did not override forged tenant");
  if (tagA?.tenant_id !== "tenant_a") fail("tag create did not force tenant_a");
  if (customerTagA?.tenant_id !== "tenant_a") fail("customer_tag create did not force tenant_a");
  if (logA?.tenant_id !== "tenant_a") fail("contact log create did not force tenant_a");
  if (readA?.tenant_id !== "tenant_a") fail("notification read did not force tenant_a");
  if (!db.orders.find(row => row.id === "o_b")) fail("tenant A deleted tenant B order by direct ID");

  await adapter.withTenantContext(tenantB, async () => {
    await adapter.deleteOrder("o_a");
  });
  if (!db.orders.find(row => row.id === "o_a")) fail("tenant B deleted tenant A order by direct ID");

  const lineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-a" }, message: { text: "test" } }]
  });
  if (lineTenant?.tenantId !== "tenant_a") fail("LINE webhook tenant resolver did not use legacy settings mapping");

  const secondLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-c" }, message: { text: "test" } }]
  });
  if (secondLineTenant?.tenantId !== "tenant_a") fail("LINE webhook tenant resolver did not use multi-group settings mapping");

  const legacyLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-b" }, message: { text: "test" } }]
  });
  if (legacyLineTenant?.tenantId !== "tenant_b") fail("LINE webhook tenant resolver did not preserve scalar legacy mapping");

  process.env.LINE_CHANNEL_SECRET = "line-channel-secret";
  process.env.LINE_WEBHOOK_TENANT_ID = "tenant_a";
  process.env.LINE_GROUP_ID = "group-a";
  const envLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-a" }, message: { text: "test" } }]
  });
  if (envLineTenant?.tenantId !== "tenant_a") fail("LINE webhook tenant resolver did not use explicit grouped env mapping");

  process.env.LINE_GROUP_ID = "";
  const unconstrainedEnvLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "unconfigured-group" }, message: { text: "test" } }]
  });
  if (unconstrainedEnvLineTenant) fail("LINE webhook tenant resolver trusted tenant env without a group constraint");

  process.env.LINE_GROUP_ID = "group-a";
  const constrainedLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-b" }, message: { text: "test" } }]
  });
  if (constrainedLineTenant) fail("LINE webhook tenant resolver ignored configured group constraint");

  process.env.LINE_CHANNEL_SECRET = "";
  process.env.LINE_WEBHOOK_TENANT_ID = "";
  process.env.LINE_GROUP_ID = "";
  db.settings.push({ id: "tenant_b:lineGroupIds", key: "lineGroupIds", value: ["group-c"], tenant_id: "tenant_b" });
  const ambiguousLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-c" }, message: { text: "test" } }]
  });
  if (ambiguousLineTenant) fail("LINE webhook tenant resolver did not fail closed for ambiguous group mapping");
  db.settings = db.settings.filter(row => row.id !== "tenant_b:lineGroupIds");

  db.settings.push({ id: "tenant_b:badLineGroupIds", key: "lineGroupIds", value: "group-b", tenant_id: "tenant_b" });
  const malformedLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "group-b" }, message: { text: "test" } }]
  });
  if (malformedLineTenant) fail("LINE webhook tenant resolver did not fail closed for malformed lineGroupIds");
  db.settings = db.settings.filter(row => row.id !== "tenant_b:badLineGroupIds");

  const unmappedLineTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "group", groupId: "unknown-group" }, message: { text: "test" } }]
  });
  if (unmappedLineTenant) fail("LINE webhook tenant resolver did not fail closed for unknown mapping");

  const missingGroupTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "user" }, message: { text: "test" } }]
  });
  if (missingGroupTenant) fail("LINE webhook tenant resolver did not fail closed for missing group mapping");

  process.env.LINE_WEBHOOK_ENABLED = "true";
  process.env.LINE_CHANNEL_SECRET = "correct-line-secret";
  process.env.LINE_WEBHOOK_TENANT_ID = "";
  process.env.LINE_GROUP_ID = "";
  const signedPathBody = JSON.stringify({
    events: [{
      type: "message",
      replyToken: "reply-signature-path",
      source: { type: "group", groupId: "group-c" },
      message: { type: "text", id: "line-signature-path", text: "สินค้า: Product A" }
    }]
  });
  const signaturePathResponse = await invokeApp("POST", "/api/line/webhook", signedPathBody, {
    "content-type": "application/json",
    "x-line-signature": "invalid-signature"
  });
  if (signaturePathResponse.status !== 200) fail(`trusted LINE tenant did not reach signature validation path: ${signaturePathResponse.status}`);
  const signaturePathJson = JSON.parse(signaturePathResponse.body || "{}");
  if (signaturePathJson.received !== 0 || signaturePathJson.verification !== true) {
    fail("trusted LINE tenant did not stop at signature validation failure");
  }
  process.env.LINE_WEBHOOK_ENABLED = "";
  process.env.LINE_CHANNEL_SECRET = "";

  await adapter.withTenantContext(secondLineTenant, async () => {
    const tenantDb = await adapter.readDb();
    if ((tenantDb.orders || []).some(order => order.tenant_id === "tenant_b")) fail("LINE webhook tenant context read crossed tenant boundary");
  });

  const anyNullTenant = [
    "customers",
    "orders",
    "settings",
    "tags",
    "customer_tags",
    "contact_logs",
    "notification_reads"
  ].flatMap(table => db[table].map(row => ({ table, row }))).filter(item => !item.row.tenant_id);
  if (anyNullTenant.length) fail(`tenant-owned rows with NULL tenant: ${anyNullTenant.map(item => `${item.table}:${item.row.id || item.row.key}`).join(", ")}`);

  console.log("Tenant write path security test passed.");
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
