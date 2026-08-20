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
    { id: "tenant_a:theme_preference_u_admin", key: "theme_preference_u_admin", value: "system", tenant_id: "tenant_a" },
    { id: "tenant_b:lineGroupId", key: "lineGroupId", value: "group-b", tenant_id: "tenant_b" },
    { id: "tenant_b:theme_preference_u_admin", key: "theme_preference_u_admin", value: "dark", tenant_id: "tenant_b" },
    { id: "products_b", key: "products", value: [{ id: "product_b", name: "Product B", stockQuantity: 10 }], tenant_id: "tenant_b" }
  ],
  follow_up_rules: [
    { id: "1", jars: 1, days: 15, tenant_id: "tenant_a" },
    { id: "tenant_b:1", jars: 1, days: 30, tenant_id: "tenant_b" }
  ],
  customers: [
    { id: "c_b", name: "B Customer", phone: "0890000000", tenant_id: "tenant_b" }
  ],
  orders: [
    { id: "o_b", customer_id: "c_b", items: "Product B", quantity: 1, amount: 100, order_date: "2026-08-08", tenant_id: "tenant_b" }
  ],
  line_messages: [],
  tags: [
    { id: "tenant_a:07", name: "07", tenant_id: "tenant_a" },
    { id: "tenant_b:tenant-b-only", name: "tenant-b-only", tenant_id: "tenant_b" }
  ],
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
  db.__requestLog = db.__requestLog || [];
  db.__requestLog.push({ method, table, url: String(input), urlLength: String(input).length });
  if (method === "GET") {
    if (table === "tags" && db.__failTagLookupAt) {
      const tagLookupCount = db.__requestLog.filter(row => row.method === "GET" && row.table === "tags").length;
      if (tagLookupCount === db.__failTagLookupAt) {
        return new Response(JSON.stringify({ code: "PGRST_TEST", message: "diagnostic tag lookup failure" }), { status: 503 });
      }
    }
    const rows = applyFilters(db[table], url.searchParams);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` }
    });
  }
  if (method === "POST") {
    if (db.__failPostTable === table) {
      return new Response(JSON.stringify({
        code: "23514",
        message: `violates constraint "${table}_diagnostic_test_check"`,
        details: "diagnostic test failure"
      }), { status: 500 });
    }
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

async function expectRejectCode(label, code, task) {
  try {
    await task();
  } catch (error) {
    if (error.code === code) return;
    throw error;
  }
  fail(`${label} did not reject with ${code}`);
}

async function expectRejectMessage(label, fragment, task) {
  try {
    await task();
  } catch (error) {
    if (String(error.message || error).includes(fragment)) return;
    throw error;
  }
  fail(`${label} did not reject with ${fragment}`);
}

async function captureConsoleError(task) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => {
    messages.push(args.map(item => String(item)).join(" "));
  };
  try {
    const result = await task();
    return { result, messages };
  } finally {
    console.error = original;
  }
}

function assertSafeDiagnosticLog(label, messages) {
  const text = messages.join("\n");
  const forbidden = [
    "test-service-role-key",
    "correct-line-secret",
    "line-channel-secret",
    "คุณข้อมูลลับ",
    "0812345678",
    "99/99 ถนนข้อมูลลับ"
  ];
  for (const value of forbidden) {
    if (text.includes(value)) fail(`${label} leaked forbidden diagnostic value: ${value}`);
  }
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
    await adapter.persistSettingsPatch({
      theme_preference_u_admin: "light",
      new_setting_for_upsert_test: "inserted"
    });
    await adapter.writeDb({
      settings: {},
      followUpRules: [{ jars: 1, days: 20 }, { jars: 2, days: 25 }],
      tags: ["07", "new-tag"],
      users: [],
      customers: [],
      orders: [],
      lineMessages: [{ id: "line-write-path", text: "write path test", rawEvent: { source: { type: "group", groupId: "group-a" } } }],
      contactLogs: []
    });
    await expectRejectCode("cross-tenant tag reuse", "TENANT_TAG_NAME_CONFLICT", () => adapter.writeDb({
      settings: {},
      followUpRules: [{ jars: 1, days: 20 }, { jars: 2, days: 25 }],
      tags: ["tenant-b-only"],
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    }));
    const bulkTagNames = ["07", ...Array.from({ length: 519 }, (_, index) => `bulk-tag-${index}`)];
    db.__requestLog = [];
    await adapter.writeDb({
      settings: {},
      followUpRules: [],
      tags: bulkTagNames,
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    });
    const bulkTagLookups = db.__requestLog.filter(row => row.method === "GET" && row.table === "tags");
    if (bulkTagLookups.length < 2) fail("large tag lookup was not split into multiple requests");
    if (Math.max(...bulkTagLookups.map(row => row.urlLength)) > adapter.MAX_SUPABASE_FILTER_QUERY_LENGTH) {
      fail("large tag lookup exceeded the configured URL bound");
    }
    if (db.tags.filter(row => row.tenant_id === "tenant_a" && row.name === "07").length !== 1) {
      fail("large tag lookup did not preserve the existing tag id");
    }
    if (db.tags.filter(row => row.tenant_id === "tenant_a" && row.name === "bulk-tag-518").length !== 1) {
      fail("large tag lookup did not insert a new tag");
    }
    db.__requestLog = [];
    await adapter.writeDb({
      settings: {},
      followUpRules: [],
      tags: bulkTagNames,
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    });
    if (db.tags.filter(row => row.tenant_id === "tenant_a" && row.name.startsWith("bulk-tag-")).length !== 519) {
      fail("repeat large tag write was not idempotent");
    }
    db.__requestLog = [];
    await adapter.writeDb({
      settings: {},
      followUpRules: [],
      tags: ["07", "07", "duplicate-new", "duplicate-new"],
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    });
    const duplicateTagLookup = db.__requestLog.find(row => row.method === "GET" && row.table === "tags");
    const duplicateTagFilter = duplicateTagLookup ? new URL(duplicateTagLookup.url).searchParams.get("name") || "" : "";
    if (duplicateTagFilter !== "in.(07,duplicate-new)") fail("tag lookup did not deduplicate names before querying");
    db.__requestLog = [];
    db.__failTagLookupAt = 2;
    await expectRejectMessage("tag lookup chunk failure", "Supabase tags request failed: 503", () => adapter.writeDb({
      settings: {},
      followUpRules: [],
      tags: bulkTagNames,
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    }));
    delete db.__failTagLookupAt;
    await expectRejectCode("oversized individual tag name", "SUPABASE_FILTER_VALUE_TOO_LARGE", () => adapter.writeDb({
      settings: {},
      followUpRules: [],
      tags: ["x".repeat(adapter.MAX_SUPABASE_FILTER_QUERY_LENGTH)],
      users: [],
      customers: [],
      orders: [],
      lineMessages: [],
      contactLogs: []
    }));
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
  const tagA = db.tags.find(row => row.name === "tag-a" && row.tenant_id === "tenant_a");
  const customerTagA = db.customer_tags.find(row => row.customer_id === "c_a" && row.tag_name === "tag-a");
  const logA = db.contact_logs.find(row => row.customer_id === "c_a");
  const readA = db.notification_reads.find(row => row.user_id === "u_a");
  const tenantAThemeRows = db.settings.filter(row => row.tenant_id === "tenant_a" && row.key === "theme_preference_u_admin");
  const tenantBThemeRows = db.settings.filter(row => row.tenant_id === "tenant_b" && row.key === "theme_preference_u_admin");
  const newTenantASetting = db.settings.find(row => row.tenant_id === "tenant_a" && row.key === "new_setting_for_upsert_test");
  const tenantATag07Rows = db.tags.filter(row => row.tenant_id === "tenant_a" && row.name === "07");
  const tenantANewTagRows = db.tags.filter(row => row.tenant_id === "tenant_a" && row.name === "new-tag");
  const tenantBTagRows = db.tags.filter(row => row.tenant_id === "tenant_b" && row.name === "tenant-b-only");
  const tenantAFollowUpJar1Rows = db.follow_up_rules.filter(row => row.tenant_id === "tenant_a" && row.jars === 1);
  const tenantAFollowUpJar2Rows = db.follow_up_rules.filter(row => row.tenant_id === "tenant_a" && row.jars === 2);
  const tenantBFollowUpJar1Rows = db.follow_up_rules.filter(row => row.tenant_id === "tenant_b" && row.jars === 1);
  const writePathLineMessage = db.line_messages.find(row => row.tenant_id === "tenant_a" && row.id === "line-write-path");
  if (customerA?.tenant_id !== "tenant_a") fail("customer create did not force tenant_a");
  if (orderA?.tenant_id !== "tenant_a") fail("order create did not override forged tenant");
  if (tagA?.tenant_id !== "tenant_a") fail("tag create did not force tenant_a");
  if (customerTagA?.tenant_id !== "tenant_a") fail("customer_tag create did not force tenant_a");
  if (logA?.tenant_id !== "tenant_a") fail("contact log create did not force tenant_a");
  if (readA?.tenant_id !== "tenant_a") fail("notification read did not force tenant_a");
  if (tenantAThemeRows.length !== 1) fail("settings upsert duplicated an existing tenant/key row");
  if (tenantAThemeRows[0].value !== "light") fail("settings upsert did not update existing tenant/key row");
  if (tenantAThemeRows[0].id !== "tenant_a:theme_preference_u_admin") fail("settings upsert unexpectedly rewrote the setting id");
  if (tenantBThemeRows.length !== 1 || tenantBThemeRows[0].value !== "dark") fail("settings upsert crossed tenant boundary");
  if (newTenantASetting?.value !== "inserted") fail("settings upsert did not insert a new setting");
  if (tenantATag07Rows.length !== 1 || tenantATag07Rows[0].id !== "tenant_a:07") fail("tag upsert duplicated or rewrote an existing tenant tag");
  if (tenantANewTagRows.length !== 1 || tenantANewTagRows[0].id !== "tenant_a:new-tag") fail("tag upsert did not insert a stable tenant-owned id");
  if (tenantBTagRows.length !== 1 || tenantBTagRows[0].id !== "tenant_b:tenant-b-only") fail("tag upsert crossed tenant boundary");
  if (tenantAFollowUpJar1Rows.length !== 1 || tenantAFollowUpJar1Rows[0].id !== "1" || tenantAFollowUpJar1Rows[0].days !== 20) fail("follow-up rule upsert did not preserve/update existing tenant jars");
  if (tenantAFollowUpJar2Rows.length !== 1 || tenantAFollowUpJar2Rows[0].id !== "tenant_a:2") fail("follow-up rule upsert did not insert a stable tenant-owned id");
  if (tenantBFollowUpJar1Rows.length !== 1 || tenantBFollowUpJar1Rows[0].id !== "tenant_b:1" || tenantBFollowUpJar1Rows[0].days !== 30) fail("follow-up rule upsert crossed tenant boundary");
  if (!writePathLineMessage) fail("writeDb did not proceed through line_messages after settings/tags/follow-up upserts");
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
  const unmappedDiagnostic = await adapter.diagnoseLineWebhookTenantRejection({
    events: [{ source: { type: "group", groupId: "unknown-group" }, message: { text: "test" } }]
  });
  if (unmappedDiagnostic.category !== "unmapped_group") fail(`unknown group diagnostic category changed: ${unmappedDiagnostic.category}`);
  if (!unmappedDiagnostic.groupIds.includes("unknown-group")) fail("unknown group diagnostic did not include incoming groupId");

  const missingGroupTenant = await adapter.resolveTenantForLineWebhook({
    events: [{ source: { type: "user" }, message: { text: "test" } }]
  });
  if (missingGroupTenant) fail("LINE webhook tenant resolver did not fail closed for missing group mapping");
  const missingGroupDiagnostic = await adapter.diagnoseLineWebhookTenantRejection({
    events: [{ source: { type: "user" }, message: { text: "test" } }]
  });
  if (missingGroupDiagnostic.category !== "missing_group_id") fail(`missing group diagnostic category changed: ${missingGroupDiagnostic.category}`);

  process.env.LINE_WEBHOOK_ENABLED = "true";
  process.env.LINE_CHANNEL_SECRET = "correct-line-secret";
  process.env.LINE_WEBHOOK_TENANT_ID = "";
  process.env.LINE_GROUP_ID = "";
  const unknownGroupBody = JSON.stringify({
    events: [{
      type: "message",
      replyToken: "reply-unknown-group",
      source: { type: "group", groupId: "unknown-group" },
      message: {
        type: "text",
        id: "line-unknown-group",
        text: "สินค้า: Product A\nชื่อลูกค้า: คุณข้อมูลลับ\nเบอร์โทร: 0812345678\nที่อยู่จัดส่ง: 99/99 ถนนข้อมูลลับ"
      }
    }]
  });
  const unknownLog = await captureConsoleError(() => invokeApp("POST", "/api/line/webhook", unknownGroupBody, {
    "content-type": "application/json",
    "x-line-signature": "invalid-signature"
  }));
  if (unknownLog.result.status !== 403) fail(`unknown group diagnostic request returned ${unknownLog.result.status}`);
  const unknownLogText = unknownLog.messages.join("\n");
  if (!unknownLogText.includes("unknown-group") || !unknownLogText.includes("unmapped_group")) {
    fail("unknown group rejection diagnostic did not include safe group/category metadata");
  }
  assertSafeDiagnosticLog("unknown group diagnostic", unknownLog.messages);

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

  process.env.LINE_CHANNEL_SECRET = "";
  const tenantAProducts = db.settings.find(row => row.tenant_id === "tenant_a" && row.key === "products");
  tenantAProducts.value = [{ id: "product_1", name: "Product A", stockQuantity: 10, archived: false }];
  const lineSuccessBody = JSON.stringify({
    events: [{
      type: "message",
      replyToken: "reply-write-path-success",
      source: { type: "group", groupId: "group-a", userId: "line-user" },
      message: {
        type: "text",
        id: "line-write-path-success",
        text: [
          "สินค้า: Product A",
          "เลขออเดอร์: diagnostic-success",
          "วันที่ซื้อ: 18/8/69",
          "ชื่อลูกค้า: คุณข้อมูลลับ",
          "เบอร์โทร: 0812345678",
          "ที่อยู่จัดส่ง: 99/99 ถนนข้อมูลลับ",
          "จำนวน: 1",
          "ยอดซื้อ: 750",
          "ช่องทางการขาย: LINE",
          "อาการลูกค้า: 07"
        ].join("\n")
      }
    }]
  });
  const lineSuccess = await invokeApp("POST", "/api/line/webhook", lineSuccessBody, {
    "content-type": "application/json"
  });
  if (lineSuccess.status !== 200) fail(`LINE write path success fixture returned ${lineSuccess.status}: ${lineSuccess.body}`);
  if (Math.max(...db.__requestLog.map(row => row.urlLength)) > adapter.MAX_SUPABASE_FILTER_QUERY_LENGTH) {
    fail("LINE write path generated a request beyond the configured URL bound");
  }
  if (!db.line_messages.find(row => row.tenant_id === "tenant_a" && row.raw_event?.message?.id === "line-write-path-success")) {
    fail("LINE write path success fixture did not persist line_messages");
  }
  const lineSuccessOrder = db.orders.find(row => row.tenant_id === "tenant_a" && row.order_number === "diagnostic-success");
  if (!lineSuccessOrder) fail("LINE write path success fixture did not persist order");
  if (db.tags.filter(row => row.tenant_id === "tenant_a" && row.name === "07").length !== 1) {
    fail("LINE write path success fixture duplicated existing tag");
  }
  const lineUpsaleBody = JSON.stringify({
    events: [{
      type: "message",
      replyToken: "reply-write-path-upsale",
      source: { type: "group", groupId: "group-a", userId: "line-user" },
      message: {
        type: "text",
        id: "line-write-path-upsale",
        text: [
          "สินค้า: Product A",
          "เลขออเดอร์: diagnostic-success",
          "วันที่ซื้อ: 18/8/69",
          "ชื่อลูกค้า: คุณข้อมูลลับ",
          "เบอร์โทร: 0812345678",
          "ที่อยู่จัดส่ง: 99/99 ถนนข้อมูลลับ",
          "จำนวน: 2",
          "ยอดซื้อ: 1000",
          "ช่องทางการขาย: LINE",
          "อาการลูกค้า: 07, new-tag"
        ].join("\n")
      }
    }]
  });
  const lineUpsale = await invokeApp("POST", "/api/line/webhook", lineUpsaleBody, {
    "content-type": "application/json"
  });
  if (lineUpsale.status !== 200) fail(`LINE write path upsale fixture returned ${lineUpsale.status}: ${lineUpsale.body}`);
  if (Math.max(...db.__requestLog.map(row => row.urlLength)) > adapter.MAX_SUPABASE_FILTER_QUERY_LENGTH) {
    fail("LINE upsale path generated a request beyond the configured URL bound");
  }
  const updatedLineSuccessOrder = db.orders.find(row => row.id === lineSuccessOrder.id);
  if (Number(updatedLineSuccessOrder?.amount) !== 1000) fail("LINE write path upsale fixture did not update existing order");
  if (!db.line_messages.find(row => row.tenant_id === "tenant_a" && row.raw_event?.message?.id === "line-write-path-upsale")) {
    fail("LINE write path upsale fixture did not persist line_messages");
  }

  const persistenceFailureBody = JSON.stringify({
    events: [{
      type: "message",
      replyToken: "reply-persistence-failure",
      source: { type: "group", groupId: "group-a", userId: "line-user" },
      message: {
        type: "text",
        id: "line-persistence-failure",
        text: [
          "สินค้า: Product A",
          "เลขออเดอร์: diagnostic-500",
          "วันที่ซื้อ: 18/8/69",
          "ชื่อลูกค้า: คุณข้อมูลลับ",
          "เบอร์โทร: 0812345678",
          "ที่อยู่จัดส่ง: 99/99 ถนนข้อมูลลับ",
          "จำนวน: 1",
          "ยอดซื้อ: 750",
          "ช่องทางการขาย: LINE"
        ].join("\n")
      }
    }]
  });
  db.__failPostTable = "orders";
  const persistenceLog = await captureConsoleError(() => invokeApp("POST", "/api/line/webhook", persistenceFailureBody, {
    "content-type": "application/json"
  }));
  delete db.__failPostTable;
  if (persistenceLog.result.status !== 500) fail(`persistence exception did not remain a 500 failure: ${persistenceLog.result.status}`);
  const persistenceLogText = persistenceLog.messages.join("\n");
  if (!persistenceLogText) fail(`persistence failure did not emit diagnostic log: ${persistenceLog.result.body}`);
  if (!persistenceLogText.includes("LINE webhook persistence failed")
    || !persistenceLogText.includes("\"stage\":\"writeDb\"")
    || !persistenceLogText.includes("\"tenantId\":\"tenant_a\"")
    || !persistenceLogText.includes("\"table\":\"orders\"")
    || !persistenceLogText.includes("orders_diagnostic_test_check")) {
    fail(`persistence failure diagnostic did not include expected safe metadata: ${persistenceLogText}`);
  }
  assertSafeDiagnosticLog("persistence diagnostic", persistenceLog.messages);

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
