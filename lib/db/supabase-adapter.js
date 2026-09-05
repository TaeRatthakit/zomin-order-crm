const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const { synchronizeCustomers } = require("../customer-sync");
const tenantPrimitives = require("./tenant-primitives");
const OPPORTUNITY_CYCLE_NOTE_RE = /\n?\[\[opportunityCycle:orderId=([^\]]+)\]\]/g;
const PRODUCT_RESOLUTION_ERROR = "ไม่พบสินค้า กรุณาเพิ่มสินค้าหรือจับคู่สินค้าให้ถูกต้องก่อนสร้างออเดอร์";
const tenantContextStorage = new AsyncLocalStorage();
const MAX_SUPABASE_FILTER_QUERY_LENGTH = 3500;
const SAFE_PRODUCTION_SUPABASE_PROJECT_REF = "mjnpzdmrqweugdnvlqwq";

const TENANT_OWNED_TABLES = new Set([
  "customers",
  "orders",
  "line_messages",
  "follow_up_rules",
  "settings",
  "tags",
  "customer_tags",
  "contact_logs",
  "notification_reads",
  "tenant_role_permissions",
  "tenant_settings",
  "tenant_memberships",
  "subscriptions",
  "payments"
]);

const COMPOSITE_CONFLICTS = {
  settings: "tenant_id,key",
  follow_up_rules: "tenant_id,jars",
  tags: "tenant_id,name",
  customer_tags: "tenant_id,customer_id,tag_name",
  notification_reads: "user_id,notification_id",
  tenant_memberships: "tenant_id,user_id",
  tenant_role_permissions: "tenant_id,role",
  tenant_settings: "tenant_id,key",
  subscriptions: "tenant_id",
  payments: "tenant_id,idempotency_key"
};

function tenantContext() {
  return tenantContextStorage.getStore() || null;
}

function normalizeTenantContext(context = {}) {
  const tenantId = String(context.tenantId || context.tenant_id || "").trim();
  if (!tenantId) {
    const error = new Error("Missing authenticated tenant context.");
    error.code = "TENANT_CONTEXT_REQUIRED";
    throw error;
  }
  return {
    tenantId,
    tenantName: String(context.tenantName || context.tenant_name || ""),
    tenantRole: String(context.tenantRole || context.tenant_role || context.role || ""),
    userId: String(context.userId || context.user_id || "")
  };
}

function withTenantContext(context, task) {
  const normalized = normalizeTenantContext(context);
  return tenantContextStorage.run(normalized, task);
}

function requireTenantContext(table, operation = "write") {
  if (!TENANT_OWNED_TABLES.has(table)) return null;
  const context = tenantContext();
  if (!context?.tenantId) {
    const error = new Error(`Refusing ${operation} on tenant-owned table ${table} without tenant context.`);
    error.code = "TENANT_CONTEXT_REQUIRED";
    throw error;
  }
  return context;
}

function stripTenantFields(row = {}) {
  const { tenant_id, tenantId, tenantName, tenantRole, ...rest } = row || {};
  return rest;
}

function tenantOwnedRow(table, row = {}) {
  const context = requireTenantContext(table, "write");
  if (!context) return row;
  const next = { ...stripTenantFields(row), tenant_id: context.tenantId };
  if (table === "settings" && next.key && !next.id) next.id = `${context.tenantId}:${next.key}`;
  if (table === "follow_up_rules" && next.jars !== undefined && !next.id) next.id = `${context.tenantId}:${next.jars}`;
  if (table === "tags" && next.name && !next.id) next.id = `${context.tenantId}:${next.name}`;
  if (table === "customer_tags" && next.customer_id && next.tag_name) next.id = `${context.tenantId}:${next.customer_id}:${next.tag_name}`;
  return next;
}

function tenantScopedQuery(table, query = "", operation = "read") {
  const context = requireTenantContext(table, operation);
  if (!context) return query;
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  params.delete("tenant_id");
  params.append("tenant_id", `eq.${context.tenantId}`);
  return params.toString();
}

function onConflictForTable(table) {
  return COMPOSITE_CONFLICTS[table] || "id";
}

function opportunityLogOrderId(log = {}) {
  const direct = String(log.order_id || log.orderId || "").trim();
  if (direct) return direct;
  OPPORTUNITY_CYCLE_NOTE_RE.lastIndex = 0;
  const match = OPPORTUNITY_CYCLE_NOTE_RE.exec(String(log.note || ""));
  OPPORTUNITY_CYCLE_NOTE_RE.lastIndex = 0;
  return match ? decodeURIComponent(match[1]) : "";
}

function opportunityCycleMarker(orderId = "") {
  return `[[opportunityCycle:orderId=${encodeURIComponent(String(orderId || "").trim())}]]`;
}

function stripOpportunityCycleNote(note = "") {
  return String(note || "").replace(OPPORTUNITY_CYCLE_NOTE_RE, "").trim();
}

function noteWithOpportunityCycle(note = "", orderId = "") {
  return [stripOpportunityCycleNote(note), opportunityCycleMarker(orderId)].filter(Boolean).join("\n");
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function deterministicTenantMembershipId(tenantId = "", userId = "") {
  const hex = crypto
    .createHash("sha1")
    .update(`${tenantId}:${userId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function deterministicOpportunityLogId(customerId = "", orderId = "", result = "") {
  const digest = crypto
    .createHash("sha1")
    .update(`${customerId}:${orderId}:${result}`)
    .digest("hex")
    .slice(0, 12);
  return `log_opp_${digest}`;
}

function assertEnv() {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) {
    const message = `Supabase mode needs ENV: ${missing.join(", ")}. Set DATABASE_PROVIDER=json for local JSON mode.`;
    const error = new Error(message);
    error.code = "SUPABASE_ENV_MISSING";
    throw error;
  }
  assertProductionDatabaseTarget();
}

function databaseProjectFingerprint(value = process.env.SUPABASE_URL || "") {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname.endsWith(".supabase.co") ? hostname.split(".")[0] : hostname;
  } catch {
    return "";
  }
}

function isProductionRuntime() {
  if (String(process.env.VERCEL_ENV || "").toLowerCase() === "production") return true;
  return !process.env.VERCEL_ENV && String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function assertProductionDatabaseTarget() {
  if (!isProductionRuntime()) return;
  const expected = String(
    process.env.PRODUCTION_SUPABASE_PROJECT_REF
      || process.env.GROWUP_PRODUCTION_SUPABASE_PROJECT_REF
      || SAFE_PRODUCTION_SUPABASE_PROJECT_REF
  ).trim().toLowerCase();
  const actual = databaseProjectFingerprint();
  if (!actual || actual !== expected) {
    const error = new Error("Production database project does not match the approved Production project.");
    error.code = "SUPABASE_PRODUCTION_PROJECT_MISMATCH";
    error.expectedProjectRef = expected;
    error.actualProjectRef = actual;
    throw error;
  }
}

function endpoint(table, query = "") {
  const url = new URL(process.env.SUPABASE_URL);
  const restBase = `${url.origin}/rest/v1`;
  return `${restBase}/${table}${query}`;
}

function supabaseOrigin() {
  return new URL(process.env.SUPABASE_URL).origin;
}

async function request(table, options = {}, query = "") {
  assertEnv();
  const method = String(options.method || "GET").toUpperCase();
  let body = options.body;
  if (TENANT_OWNED_TABLES.has(table)) {
    if (method === "POST") {
      const parsed = body ? JSON.parse(body) : [];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      body = JSON.stringify(rows.map(row => tenantOwnedRow(table, row)));
    } else if (method === "PATCH") {
      requireTenantContext(table, "update");
      if (body) body = JSON.stringify(stripTenantFields(JSON.parse(body)));
      query = tenantScopedQuery(table, query, "update");
      query = query ? `?${query}` : "";
    } else if (method === "DELETE") {
      query = tenantScopedQuery(table, query, "delete");
      query = query ? `?${query}` : "";
    }
  }
  const res = await fetch(endpoint(table, query), {
    ...options,
    body,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase ${table} request failed: ${res.status} ${detail}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function select(table) {
  const scoped = tenantScopedQuery(table, "select=*");
  return request(table, { method: "GET" }, `?${scoped}`);
}

async function selectWhere(table, query) {
  const scoped = tenantScopedQuery(table, `select=*&${query}`);
  return request(table, { method: "GET" }, `?${scoped}`);
}

async function selectWhereUnscoped(table, query) {
  return request(table, { method: "GET" }, `?select=*&${query}`);
}

function boundedInFilterChunks(field, values, fixedQuery = "") {
  const uniqueValues = [...new Set(values.map(value => String(value)).filter(Boolean))];
  const chunks = [];
  let current = [];
  let currentLength = 0;
  const fixedLength = 256 + fixedQuery.length + `${field}=in.()`.length;
  for (const value of uniqueValues) {
    const encoded = encodeURIComponent(value);
    const valueLength = encoded.length + (current.length ? 1 : 0);
    if (fixedLength + encoded.length > MAX_SUPABASE_FILTER_QUERY_LENGTH) {
      const error = new Error(`Supabase ${field} filter value exceeds the safe query bound.`);
      error.code = "SUPABASE_FILTER_VALUE_TOO_LARGE";
      throw error;
    }
    if (current.length && fixedLength + currentLength + valueLength > MAX_SUPABASE_FILTER_QUERY_LENGTH) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(value);
    currentLength += encoded.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function selectWhereInChunks(table, field, values, fixedQuery = "") {
  const rows = [];
  for (const chunk of boundedInFilterChunks(field, values, fixedQuery)) {
    const predicate = `${field}=in.(${chunk.map(encodeURIComponent).join(",")})`;
    const query = fixedQuery ? `${fixedQuery}&${predicate}` : predicate;
    rows.push(...(await selectWhere(table, query)));
  }
  return rows.sort((left, right) => (
    String(left?.[field] || "").localeCompare(String(right?.[field] || ""))
    || String(left?.tenant_id || "").localeCompare(String(right?.tenant_id || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
}

async function selectWhereUnscopedInChunks(table, field, values, fixedQuery = "") {
  const rows = [];
  for (const chunk of boundedInFilterChunks(field, values, fixedQuery)) {
    const predicate = `${field}=in.(${chunk.map(encodeURIComponent).join(",")})`;
    const query = fixedQuery ? `${fixedQuery}&${predicate}` : predicate;
    rows.push(...(await selectWhereUnscoped(table, query)));
  }
  return rows.sort((left, right) => (
    String(left?.[field] || "").localeCompare(String(right?.[field] || ""))
    || String(left?.tenant_id || "").localeCompare(String(right?.tenant_id || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
}

async function safeSelect(table) {
  return select(table).catch(error => {
    if (String(error.message || "").includes("404")) return [];
    if (String(error.detail || error.message || "").includes("PGRST205")) return [];
    throw error;
  });
}

async function rpc(functionName, payload = {}) {
  assertEnv();
  const res = await fetch(endpoint(`rpc/${functionName}`), {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.text();
    const error = new Error(`Supabase RPC ${functionName} failed: ${res.status} ${detail}`);
    error.status = res.status;
    error.detail = detail;
    throw error;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function selectUsersForTenantContext() {
  const context = tenantContext();
  if (!context?.tenantId) return select("users");
  const memberships = await selectWhereUnscoped(
    "tenant_memberships",
    `tenant_id=eq.${encodeURIComponent(context.tenantId)}&is_active=eq.true`
  );
  const userIds = [...new Set((memberships || []).map(row => row.user_id).filter(Boolean))];
  if (!userIds.length) return [];
  return selectWhereUnscopedInChunks("users", "id", userIds);
}

async function resolveTenantForUser(userId) {
  const value = String(userId || "").trim();
  if (!value) return null;
  const memberships = await selectWhereUnscoped(
    "tenant_memberships",
    `user_id=eq.${encodeURIComponent(value)}&is_active=eq.true`
  ).catch(() => []);
  const active = (memberships || []).filter(row => row.tenant_id);
  if (active.length !== 1) return null;
  const tenants = await selectWhereUnscoped(
    "tenants",
    `id=eq.${encodeURIComponent(active[0].tenant_id)}&status=eq.active&limit=1`
  ).catch(() => []);
  const tenant = tenants?.[0];
  if (!tenant) return null;
  return {
    tenantId: tenant.id,
    tenantName: tenant.name || "",
    tenantRole: active[0].role || "",
    userId: value
  };
}

async function resolveTenantForLineWebhook(body = {}) {
  const configuredTenantId = String(process.env.LINE_WEBHOOK_TENANT_ID || process.env.GROWUP_TENANT_ID || "").trim();
  const configuredGroupId = String(process.env.LINE_GROUP_ID || "").trim();
  const events = Array.isArray(body.events) ? body.events : [];
  const groupIds = [...new Set(events.map(event => String(event?.source?.groupId || "").trim()).filter(Boolean))];
  if (groupIds.length !== 1) return null;
  const groupId = groupIds[0];
  const candidateTenantIds = new Set();
  if (configuredTenantId && configuredGroupId) {
    if (groupId !== configuredGroupId) return null;
    candidateTenantIds.add(configuredTenantId);
  }
  const settingsRows = await selectWhereUnscoped(
    "settings",
    `key=in.${encodeURIComponent("(lineGroupId,lineGroupIds)")}`
  ).catch(() => []);
  const malformedTenantIds = new Set();
  for (const row of settingsRows || []) {
    const tenantId = String(row.tenant_id || "").trim();
    if (!tenantId) continue;
    if (row.key === "lineGroupIds") {
      if (!Array.isArray(row.value) || row.value.some(item => !String(item || "").trim())) {
        malformedTenantIds.add(tenantId);
        continue;
      }
      if (new Set(row.value.map(item => String(item || "").trim())).has(groupId)) candidateTenantIds.add(tenantId);
      continue;
    }
    if (row.key === "lineGroupId" && String(row.value || "").trim() === groupId) candidateTenantIds.add(tenantId);
  }
  for (const tenantId of malformedTenantIds) candidateTenantIds.delete(tenantId);
  const tenantIds = [...candidateTenantIds];
  if (tenantIds.length !== 1) return null;
  const tenants = await selectWhereUnscoped("tenants", `id=eq.${encodeURIComponent(tenantIds[0])}&status=eq.active&limit=1`).catch(() => []);
  const tenant = tenants?.[0];
  if (!tenant) return null;
  return {
    tenantId: tenant.id,
    tenantName: tenant.name || "",
    tenantRole: "Webhook",
    userId: "line-webhook"
  };
}

function lineWebhookGroupIdsFromBody(body = {}) {
  const events = Array.isArray(body.events) ? body.events : [];
  return [...new Set(events.map(event => String(event?.source?.groupId || "").trim()).filter(Boolean))];
}

async function diagnoseLineWebhookTenantRejection(body = {}) {
  const configuredTenantId = String(process.env.LINE_WEBHOOK_TENANT_ID || process.env.GROWUP_TENANT_ID || "").trim();
  const configuredGroupId = String(process.env.LINE_GROUP_ID || "").trim();
  const events = Array.isArray(body.events) ? body.events : [];
  const groupIds = lineWebhookGroupIdsFromBody(body);
  const sourceTypes = [...new Set(events.map(event => String(event?.source?.type || "").trim()).filter(Boolean))];
  const base = {
    category: "",
    eventCount: events.length,
    sourceTypes,
    groupIds,
    missingGroupId: groupIds.length === 0,
    candidateTenantCount: 0,
    malformedTenantCount: 0,
    matchedTenantIds: []
  };
  if (!Array.isArray(body.events)) return { ...base, category: "missing_events_array" };
  if (groupIds.length === 0) return { ...base, category: "missing_group_id" };
  if (groupIds.length > 1) return { ...base, category: "multiple_group_ids" };
  const groupId = groupIds[0];
  if (configuredTenantId && configuredGroupId && groupId !== configuredGroupId) {
    return { ...base, category: "env_group_mismatch" };
  }

  let settingsRows = [];
  try {
    settingsRows = await selectWhereUnscoped(
      "settings",
      `key=in.${encodeURIComponent("(lineGroupId,lineGroupIds)")}`
    );
  } catch (error) {
    return { ...base, category: "settings_lookup_failed", errorCode: error.code || "" };
  }
  const candidateTenantIds = new Set();
  const malformedTenantIds = new Set();
  if (configuredTenantId && configuredGroupId && groupId === configuredGroupId) candidateTenantIds.add(configuredTenantId);
  for (const row of settingsRows || []) {
    const tenantId = String(row.tenant_id || "").trim();
    if (!tenantId) continue;
    if (row.key === "lineGroupIds") {
      if (!Array.isArray(row.value) || row.value.some(item => !String(item || "").trim())) {
        malformedTenantIds.add(tenantId);
        continue;
      }
      if (new Set(row.value.map(item => String(item || "").trim())).has(groupId)) candidateTenantIds.add(tenantId);
      continue;
    }
    if (row.key === "lineGroupId" && String(row.value || "").trim() === groupId) candidateTenantIds.add(tenantId);
  }
  for (const tenantId of malformedTenantIds) candidateTenantIds.delete(tenantId);
  const matchedTenantIds = [...candidateTenantIds];
  const diagnostic = {
    ...base,
    candidateTenantCount: matchedTenantIds.length,
    malformedTenantCount: malformedTenantIds.size,
    matchedTenantIds
  };
  if (matchedTenantIds.length === 0) return { ...diagnostic, category: "unmapped_group" };
  if (matchedTenantIds.length > 1) return { ...diagnostic, category: "ambiguous_group_mapping" };
  const tenants = await selectWhereUnscoped(
    "tenants",
    `id=eq.${encodeURIComponent(matchedTenantIds[0])}&status=eq.active&limit=1`
  ).catch(() => []);
  if (!tenants?.[0]) return { ...diagnostic, category: "matched_tenant_inactive_or_missing" };
  return { ...diagnostic, category: "would_resolve" };
}

function productNameKey(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function activeProductsForImport() {
  const rows = await selectWhere("settings", `key=eq.${encodeURIComponent("products")}&limit=1`);
  return (Array.isArray(rows?.[0]?.value) ? rows[0].value : [])
    .filter(product => product && product.archived !== true && String(product.name || "").trim());
}

function resolveImportProduct(products = [], row = {}) {
  const productId = String(row.productId || row.product_id || "").trim();
  const nameKey = productNameKey(row.items || row.product || row.productName || "");
  const product = (productId ? products.find(item => String(item.id || "") === productId) : null)
    || products.find(item => productNameKey(item.name) === nameKey);
  if (!product) throw new Error(PRODUCT_RESOLUTION_ERROR);
  return product;
}

function moneyMatches(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < 0.000001;
}

function normalizePackageExpenses(expenses = []) {
  return (Array.isArray(expenses) ? expenses : []).map((expense, index) => ({
    id: String(expense?.id || `expense_${index + 1}`),
    name: String(expense?.name || "").trim(),
    amount: Math.max(0, Number(expense?.amount || 0)),
    enabled: expense?.enabled !== false
  })).filter(expense => expense.name || expense.amount > 0);
}

function normalizeSalesPackages(packages = []) {
  return (Array.isArray(packages) ? packages : []).map((item, index) => {
    const paidQuantity = Math.max(0, Number(item?.paidQuantity || 0));
    const freeQuantity = Math.max(0, Number(item?.freeQuantity || 0));
    return {
      id: String(item?.id || `package_${index + 1}`),
      name: String(item?.name || "").trim(),
      paidQuantity,
      freeQuantity,
      totalQuantityShipped: Math.max(0, Number(item?.totalQuantityShipped || paidQuantity + freeQuantity)),
      salePrice: Math.max(0, Number(item?.salePrice || 0)),
      enabled: item?.enabled !== false,
      expenses: normalizePackageExpenses(item?.expenses)
    };
  }).filter(item => item.id && item.totalQuantityShipped > 0);
}

function importSalesPackageForRow(product = {}, row = {}) {
  const packageId = String(row.packageId || row.package_id || "").trim();
  const packages = normalizeSalesPackages(product.salesPackages);
  if (packageId) return packages.find(item => item.id === packageId && item.enabled !== false) || null;
  const revenue = Number(row.amount || 0);
  const shipped = Number(row.totalQuantityShipped || row.jars || 0);
  if (!revenue || !shipped) return null;
  const matches = packages.filter(item =>
    item.enabled !== false &&
    moneyMatches(item.salePrice, revenue) &&
    moneyMatches(item.totalQuantityShipped, shipped)
  );
  return matches.length === 1 ? matches[0] : null;
}

function importPackageFields(product = {}, row = {}) {
  const selectedPackage = importSalesPackageForRow(product, row);
  return {
    productId: product.id || "",
    packageId: selectedPackage?.id || "",
    packageName: selectedPackage?.name || "",
    paidQuantity: selectedPackage ? Number(selectedPackage.paidQuantity || 0) : Number(row.paidQuantity || 0),
    freeQuantity: selectedPackage ? Number(selectedPackage.freeQuantity || 0) : Number(row.freeQuantity || 0),
    totalQuantityShipped: selectedPackage ? Number(selectedPackage.totalQuantityShipped || 0) : Number(row.totalQuantityShipped || row.jars || 0),
    packageExpenses: selectedPackage ? normalizePackageExpenses(selectedPackage.expenses) : normalizePackageExpenses(row.packageExpenses)
  };
}

async function upsert(table, rows) {
  if (!rows || !rows.length) return [];
  if (table === "follow_up_rules") return upsertFollowUpRules(rows);
  if (table === "settings") return upsertSettings(rows);
  if (table === "tags") return upsertTags(rows);
  return request(table, {
    method: "POST",
    body: JSON.stringify(rows)
  }, `?on_conflict=${onConflictForTable(table)}`);
}

async function upsertSettings(rows) {
  const context = requireTenantContext("settings", "write");
  const keys = [...new Set(rows.map(row => String(row?.key || "").trim()).filter(Boolean))];
  if (!keys.length) return [];
  const existingRows = await selectWhereInChunks("settings", "key", keys);
  const existingIdByKey = new Map((existingRows || []).map(row => [String(row.key || ""), row.id]));
  const rowsWithExistingIds = rows.map(row => {
    const existingId = existingIdByKey.get(String(row?.key || ""));
    return { ...row, id: existingId || `${context.tenantId}:${String(row?.key || "").trim()}` };
  });
  return request("settings", {
    method: "POST",
    body: JSON.stringify(rowsWithExistingIds)
  }, `?on_conflict=${onConflictForTable("settings")}`);
}

async function upsertFollowUpRules(rows) {
  const context = requireTenantContext("follow_up_rules", "write");
  const jarsValues = [...new Set(rows.map(row => Number(row?.jars)).filter(value => Number.isFinite(value)))];
  if (!jarsValues.length) return [];
  const existingRows = await selectWhereInChunks("follow_up_rules", "jars", jarsValues);
  const existingIdByJars = new Map((existingRows || []).map(row => [Number(row.jars), row.id]));
  const rowsWithStableIds = rows.map(row => {
    const jars = Number(row?.jars);
    const existingId = existingIdByJars.get(jars);
    return { ...row, id: existingId || `${context.tenantId}:${jars}` };
  });
  return request("follow_up_rules", {
    method: "POST",
    body: JSON.stringify(rowsWithStableIds)
  }, `?on_conflict=${onConflictForTable("follow_up_rules")}`);
}

async function upsertTags(rows) {
  const context = requireTenantContext("tags", "write");
  const names = [...new Set(rows.map(row => String(row?.name || "").trim()).filter(Boolean))];
  if (!names.length) return [];
  const existingRows = await selectWhereUnscopedInChunks("tags", "name", names);
  const existingByName = new Map();
  for (const row of existingRows || []) {
    const name = String(row.name || "");
    const owner = String(row.tenant_id || "");
    const current = existingByName.get(name);
    if (current && current.tenant_id !== owner) {
      const error = new Error(`Ambiguous tag mapping for ${name}.`);
      error.code = "TENANT_TAG_NAME_CONFLICT";
      throw error;
    }
    existingByName.set(name, row);
  }
  const rowsWithStableIds = rows.map(row => {
    const name = String(row?.name || "").trim();
    const existing = existingByName.get(name);
    if (existing && String(existing.tenant_id || "") !== context.tenantId) {
      const error = new Error(`Refusing to reuse tag ${name} from another tenant.`);
      error.code = "TENANT_TAG_NAME_CONFLICT";
      throw error;
    }
    return { ...row, id: existing?.id || `${context.tenantId}:${name}`, name };
  });
  return request("tags", {
    method: "POST",
    body: JSON.stringify(rowsWithStableIds)
  }, `?on_conflict=${onConflictForTable("tags")}`);
}

function productImageBucket() {
  return process.env.PRODUCT_IMAGE_BUCKET || "product-images";
}

function storageObjectPath(path = "") {
  return String(path)
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

function storageHeaders(headers = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...headers
  };
}

async function storageFetch(pathname, options = {}) {
  assertEnv();
  const res = await fetch(`${supabaseOrigin()}/storage/v1${pathname}`, {
    ...options,
    headers: storageHeaders(options.headers || {})
  });
  if (!res.ok && !(options.allowNotFound && res.status === 404)) {
    const detail = await res.text();
    throw new Error(`Supabase Storage request failed: ${res.status} ${detail}`);
  }
  return res;
}

async function ensureProductImageBucket() {
  const bucket = productImageBucket();
  const bucketPath = `/bucket/${encodeURIComponent(bucket)}`;
  const existing = await storageFetch(bucketPath, { method: "GET", allowNotFound: true });
  if (existing.status === 404) {
    await storageFetch("/bucket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bucket,
        name: bucket,
        public: true,
        file_size_limit: 10_000_000,
        allowed_mime_types: ["image/webp", "image/jpeg", "image/png", "image/gif", "image/svg+xml"]
      })
    });
    return { bucket, created: true, public: true };
  }
  const bucketInfo = await existing.json().catch(() => ({}));
  if (bucketInfo.public !== true) {
    await storageFetch(bucketPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public: true, file_size_limit: 10_000_000 })
    });
  }
  return { bucket, created: false, public: true };
}

function productImagePublicUrl(objectPath) {
  const encodedPath = storageObjectPath(objectPath);
  return `${supabaseOrigin()}/storage/v1/object/public/${encodeURIComponent(productImageBucket())}/${encodedPath}`;
}

function productImagePublicBaseUrl() {
  return `${supabaseOrigin()}/storage/v1/object/public/${encodeURIComponent(productImageBucket())}/products/`;
}

async function uploadProductImageObject(objectPath, bytes, contentType) {
  await ensureProductImageBucket();
  const encodedPath = storageObjectPath(objectPath);
  await storageFetch(`/object/${encodeURIComponent(productImageBucket())}/${encodedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
      "Cache-Control": "31536000"
    },
    body: bytes
  });
  return productImagePublicUrl(objectPath);
}

async function verifyPublicProductImageUrl(url) {
  const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
  return res.ok;
}

async function deleteWhere(table, query) {
  await request(table, { method: "DELETE" }, `?${query}`);
}

async function deleteOrder(id) {
  await request("orders", { method: "DELETE" }, `?id=eq.${encodeURIComponent(id)}`);
}

async function deleteUser(id) {
  const userId = String(id || "").trim();
  if (!userId) return;
  requireTenantContext("tenant_memberships", "delete");
  await request("tenant_memberships", { method: "DELETE" }, `?user_id=eq.${encodeURIComponent(userId)}`);
  const remaining = await selectWhereUnscoped("tenant_memberships", `user_id=eq.${encodeURIComponent(userId)}&limit=1`).catch(() => []);
  if (!remaining?.length) {
    await request("users", { method: "DELETE" }, `?id=eq.${encodeURIComponent(userId)}`);
  }
}

function customerRowPayload(customer = {}) {
  return {
    id: customer.id,
    name: customer.name,
    phone: storedCustomerPhone(customer.phone, customer.id),
    latest_address: customer.address || "",
    note: customer.note || "",
    assigned_to: customer.assignedTo || null,
    first_purchase_date: customer.firstPurchaseDate || customer.createdAt || null,
    last_purchase_date: customer.lastPurchaseDate || null,
    purchase_count: Number(customer.purchaseCount || 0),
    total_quantity: Number(customer.totalJars || 0),
    total_amount: Number(customer.totalSpent || 0),
    status: customer.status || "NORMAL",
    vip_level: customer.vipLevel || "NORMAL",
    customer_score: Number(customer.customerScore || 0),
    follow_up_date: customer.followUpDate || null,
    last_contact_date: customer.lastContactDate || null,
    last_contact_note: customer.lastContactNote || ""
  };
}

function orderRowPayload(order = {}) {
  return {
    id: order.id,
    customer_id: order.customerId,
    order_number: normalizeOrderNumber(order.orderNumber),
    customer_name: order.customerName || "",
    phone: order.phone || "",
    address: order.address || "",
    items: order.items || order.product || "Growup",
    quantity: order.jars,
    amount: order.amount,
    order_date: order.date,
    order_time: order.time || null,
    source: order.source || "",
    source_channel: order.sourceChannel || order.source_channel || "",
    social_name: order.socialName || order.social_name || "",
    free_gift: order.freeGift || order.free_gift || "",
    vip_card_status: order.vipCardStatus || order.vip_card_status || "",
    note: order.note || "",
    raw_text: rawTextWithOrderMetadata(order),
    created_by: order.createdBy || null
  };
}

async function deleteCustomer(id) {
  const customerId = encodeURIComponent(id);
  await request("customer_tags", { method: "DELETE" }, `?customer_id=eq.${customerId}`);
  await request("contact_logs", { method: "DELETE" }, `?customer_id=eq.${customerId}`);
  await request("customers", { method: "DELETE" }, `?id=eq.${customerId}`);
}

async function getImportJob(id) {
  const rows = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_job_${id}`)}&limit=1`);
  return rows?.[0]?.value || null;
}

async function getActiveImportJob(type) {
  const rows = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_active_${type}`)}&limit=1`);
  const id = rows?.[0]?.value?.id;
  if (!id) return null;
  const job = await getImportJob(id);
  return job && ["queued", "running", "paused"].includes(job.status) ? job : null;
}

async function getLatestImportJob(type) {
  const rows = await selectWhere(
    "settings",
    `key=like.${encodeURIComponent("import_job_%")}&order=updated_at.desc&limit=10`
  );
  return (rows || []).map(row => row.value).find(job => job?.type === type) || null;
}

async function saveImportJob(job) {
  await upsert("settings", [{
    id: `import_job_${job.id}`,
    key: `import_job_${job.id}`,
    value: job
  }]);
  if (["queued", "running", "paused"].includes(job.status)) {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: job.id }
    }]);
  } else {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: "" }
    }]);
  }
  return job;
}

async function previewLatestImportCleanup(type = "orders") {
  const job = await getLatestImportJob(type);
  if (!job) return null;
  const startedAt = encodeURIComponent(job.startedAt || job.createdAt || "");
  const completedAt = encodeURIComponent(job.completedAt || job.startedAt || job.createdAt || "");
  const [orders, customers] = await Promise.all([
    selectWhere(
      "orders",
      `select=id,customer_id,created_at&created_at=gte.${startedAt}&created_at=lte.${completedAt}&limit=20000`
    ),
    selectWhere(
      "customers",
      `select=id,created_at&created_at=gte.${startedAt}&created_at=lte.${completedAt}&limit=20000`
    )
  ]);
  const orderIds = (orders || []).map(order => order.id);
  const customerIds = (customers || []).map(customer => customer.id);
  return {
    job,
    orderCount: orderIds.length,
    orderIds,
    customerCount: customerIds.length,
    customerIds,
    settingsKeys: [`import_job_${job.id}`]
  };
}

async function cleanupImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) return null;
  const preview = await previewLatestImportCleanup(job.type || "orders");
  if (!preview || preview.job.id !== jobId) {
    throw new Error("Cleanup is only allowed for the latest import job.");
  }

  const orderIds = Array.isArray(job.importedOrderIds) && job.importedOrderIds.length ? job.importedOrderIds : (preview.orderIds || []);

  if (orderIds.length) {
    await deleteWhere("orders", `id=in.${encodeURIComponent(inFilter(orderIds))}`);
  }

  const allCustomers = await selectWhere("customers", "select=id");
  const orphanCustomerIds = [];
  for (const customer of allCustomers || []) {
    const remaining = await selectWhere("orders", `select=id&customer_id=eq.${encodeURIComponent(customer.id)}&limit=1`);
    if (!remaining?.length) orphanCustomerIds.push(customer.id);
  }

  if (orphanCustomerIds.length) {
    await deleteIdsInChunks("customers", "id", orphanCustomerIds);
    await deleteIdsInChunks("contact_logs", "customer_id", orphanCustomerIds);
  }

  await deleteWhere("settings", `key=eq.${encodeURIComponent(`import_job_${jobId}`)}`);
  const active = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_active_${job.type}`)}&limit=1`);
  if (active?.[0]?.value?.id === jobId) {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: "" }
    }]);
  }

  return {
    job,
    deletedOrders: orderIds.length,
    deletedCustomers: orphanCustomerIds.length,
    deletedImportRecords: 1
  };
}

function inFilter(values) {
  return `(${values.map(value => `"${String(value).replace(/["\\]/g, "")}"`).join(",")})`;
}

async function deleteIdsInChunks(table, field, ids, chunkSize = 100) {
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    if (!chunk.length) continue;
    await deleteWhere(table, `${field}=in.${encodeURIComponent(inFilter(chunk))}`);
  }
}

function importOrderKey(order) {
  const orderNumber = String(order.order_number || order.orderNumber || "").trim().toLowerCase();
  return orderNumber
    ? `order:${orderNumber}`
    : `fallback:${String(order.order_date || order.date || "")}|${String(order.phone || "").replace(/[^\d]/g, "")}|${Number(order.amount || 0)}`;
}

function storedCustomerPhone(value, customerId) {
  const phone = String(value || "").trim();
  if (phone) return phone;
  return `missingphone${String(customerId || "customer").toLowerCase().replace(/[^a-z]/g, "x")}`;
}

async function importOrdersBatch(rows) {
  const validRows = [];
  const failed = [];
  for (const row of rows) {
    const phone = String(row.phone || "").replace(/[^\d]/g, "");
    if (!phone || !String(row.name || "").trim() || !String(row.date || "").trim()) {
      failed.push({ rowNumber: row.rowNumber, error: "ข้อมูลชื่อ เบอร์โทร หรือวันที่ไม่ครบ", row });
    } else if (!Number.isFinite(Number(row.jars)) || !Number.isFinite(Number(row.amount))) {
      failed.push({ rowNumber: row.rowNumber, error: "จำนวนหรือยอดซื้อไม่ถูกต้อง", row });
    } else {
      validRows.push({ ...row, phone });
    }
  }
  if (!validRows.length) return { imported: 0, skipped: 0, failed };
  const activeProducts = await activeProductsForImport();

  const orderNumbers = [...new Set(validRows.map(row => String(row.orderNumber || "").trim()).filter(Boolean))];
  const dates = [...new Set(validRows.map(row => row.date).filter(Boolean))];
  const phones = [...new Set(validRows.map(row => row.phone))];
  const [numberMatches, dateMatches, customerMatches] = await Promise.all([
    orderNumbers.length
      ? selectWhere("orders", `order_number=in.${encodeURIComponent(inFilter(orderNumbers))}`)
      : [],
    dates.length
      ? selectWhere("orders", `order_date=in.${encodeURIComponent(inFilter(dates))}&phone=in.${encodeURIComponent(inFilter(phones))}`)
      : [],
    selectWhere("customers", `phone=in.${encodeURIComponent(inFilter(phones))}`)
  ]);
  const existingKeys = new Set([...(numberMatches || []), ...(dateMatches || [])].map(importOrderKey));
  const customersByPhone = new Map((customerMatches || []).map(customer => [String(customer.phone || "").replace(/[^\d]/g, ""), customer]));
  const customers = [];
  const orders = [];
  const tags = [];
  const customerTags = [];
  const importedCustomerIds = [];
  const importedOrderIds = [];
  let skipped = 0;

  for (const row of validRows) {
    const key = importOrderKey(row);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    let product;
    try {
      product = resolveImportProduct(activeProducts, row);
    } catch (error) {
      failed.push({ rowNumber: row.rowNumber, error: error.message, row });
      continue;
    }
    const packageFields = importPackageFields(product, row);
    let customer = customersByPhone.get(row.phone);
    if (!customer) {
      customer = {
        id: `c_${require("crypto").randomBytes(6).toString("hex")}`,
        name: String(row.name).trim(),
        phone: row.phone,
        latest_address: String(row.address || "").trim(),
        note: ""
      };
      customersByPhone.set(row.phone, customer);
      customers.push(customer);
      importedCustomerIds.push(customer.id);
    }
    const orderId = `o_${require("crypto").randomBytes(6).toString("hex")}`;
    orders.push({
      __rowNumber: row.rowNumber,
      __sourceRow: row,
      id: orderId,
      customer_id: customer.id,
      order_number: String(row.orderNumber || "").trim(),
      customer_name: String(row.name).trim(),
      phone: row.phone,
      address: String(row.address || "").trim(),
      items: product.name,
      quantity: Number(row.jars || 1),
      amount: Number(row.amount || 0),
      order_date: row.date,
      order_time: row.time || null,
      source: "Import",
      source_channel: row.sourceChannel || "Import",
      social_name: row.socialName || "",
      free_gift: row.freeGift || "",
      vip_card_status: row.vipCardStatus || "",
      note: row.note || "",
      raw_text: rawTextWithOrderMetadata({
        orderNumber: row.orderNumber,
        alternatePhone: row.alternatePhone || "",
        originSource: row.originSource || "",
        originSourceOther: row.originSourceOther || "",
        ...packageFields,
        rawText: row.rawText || ""
      })
    });
    importedOrderIds.push(orderId);
    for (const tagName of Array.isArray(row.tags) ? row.tags : String(row.tags || "").split(",").map(tag => tag.trim()).filter(Boolean)) {
      tags.push({ id: tagName, name: tagName });
      customerTags.push({ id: `${customer.id}_${tagName}`, customer_id: customer.id, tag_name: tagName });
    }
    existingKeys.add(key);
  }

  await upsert("customers", customers);
  await upsert("tags", [...new Map(tags.map(tag => [tag.id, tag])).values()]);
  await upsert("customer_tags", [...new Map(customerTags.map(tag => [tag.id, tag])).values()]);
  const orderPayload = orders.map(({ __rowNumber, __sourceRow, ...order }) => order);
  let imported = orderPayload.length;
  try {
    await upsert("orders", orderPayload);
  } catch {
    imported = 0;
    for (const order of orders) {
      const { __rowNumber, __sourceRow, ...payload } = order;
      try {
        await upsert("orders", [payload]);
        imported += 1;
      } catch (error) {
        failed.push({ rowNumber: __rowNumber, error: error.message, row: __sourceRow });
      }
    }
  }
  return { imported, skipped, failed, importedOrderIds, importedCustomerIds };
}

function mapSettings(rows) {
  const settings = {};
  for (const row of rows || []) {
    settings[row.key] = row.value;
  }
  return settings;
}

function settingsRows(settings = {}) {
  return Object.entries(settings).map(([key, value]) => ({ id: key, key, value }));
}

async function readSettingsPatch(keys = []) {
  const names = [...new Set(keys.map(key => String(key || "").trim()).filter(Boolean))];
  if (!names.length) return {};
  const rows = await selectWhere("settings", `key=in.(${names.map(encodeURIComponent).join(",")})`);
  return mapSettings(rows || []);
}

function mapContactLogRow(log = {}) {
  return {
    id: log.id,
    customerId: log.customer_id,
    date: log.contact_date,
    result: log.result,
    note: log.note || "",
    staff: log.contacted_by || "",
    nextFollowUpDate: log.next_follow_up_date || "",
    createdAt: log.created_at || "",
    orderId: opportunityLogOrderId(log)
  };
}

function mapOrderRow(order = {}) {
  return {
    id: order.id,
    customerId: order.customer_id,
    date: order.order_date,
    time: order.order_time || ""
  };
}

function contactLogRowPayload(log = {}) {
  return {
    id: log.id,
    customer_id: log.customerId,
    contact_date: log.date,
    contacted_by: log.staff || "",
    result: log.result,
    note: log.note || "",
    next_follow_up_date: log.nextFollowUpDate || null,
    created_at: log.createdAt || undefined
  };
}

function sortedOpportunityOrders(orders = []) {
  return [...orders].sort((a, b) => [
    String(a.date || ""),
    String(a.time || ""),
    String(a.id || "")
  ].join("|").localeCompare([
    String(b.date || ""),
    String(b.time || ""),
    String(b.id || "")
  ].join("|")));
}

function inferOpportunityLogOrderId(orders = [], log = {}) {
  const direct = opportunityLogOrderId(log);
  if (direct) return direct;
  const sorted = sortedOpportunityOrders(orders);
  if (sorted.length === 1) return String(sorted[0].id || "");
  const logDate = String(log.date || log.contact_date || "");
  const previousOrders = sorted.filter(order => String(order.date || "") <= logDate);
  return previousOrders.length ? String(previousOrders[previousOrders.length - 1].id || "") : "";
}

async function createContactLogFast(input = {}) {
  const timings = {};
  const readStartedAt = Date.now();
  const customerId = String(input.customerId || "").trim();
  if (!customerId) return { ok: false, status: 400, error: "ไม่พบลูกค้า" };
  const manualOpportunityResult = Boolean(input.manualOpportunityResult);
  const requestedOrderId = String(input.orderId || "").trim();
  const canUseExactCycle = manualOpportunityResult && requestedOrderId;
  const exactMarker = canUseExactCycle ? opportunityCycleMarker(requestedOrderId) : "";
  const [customers, orderRows, duplicateRows] = await Promise.all([
    canUseExactCycle
      ? Promise.resolve([])
      : selectWhere("customers", `id=eq.${encodeURIComponent(customerId)}&limit=1`),
    canUseExactCycle
      ? selectWhere("orders", `id=eq.${encodeURIComponent(requestedOrderId)}&customer_id=eq.${encodeURIComponent(customerId)}&limit=1`)
      : (manualOpportunityResult || requestedOrderId)
        ? selectWhere("orders", `customer_id=eq.${encodeURIComponent(customerId)}&order=order_date.asc,order_time.asc,id.asc`)
        : Promise.resolve([]),
    canUseExactCycle
      ? Promise.resolve([])
      : manualOpportunityResult
        ? selectWhere("contact_logs", `customer_id=eq.${encodeURIComponent(customerId)}&result=eq.${encodeURIComponent(input.result || "")}`)
        : Promise.resolve([])
  ]);
  timings.readMs = Date.now() - readStartedAt;
  const customer = customers?.[0];
  const orders = (orderRows || []).map(mapOrderRow);
  const requestedOrder = requestedOrderId ? orders.find(order => order.id === requestedOrderId) : null;
  if (!canUseExactCycle && !customer) return { ok: false, status: 404, error: "ไม่พบลูกค้า", timings };
  if (requestedOrderId && !requestedOrder) {
    return { ok: false, status: 400, error: "รอบออเดอร์นี้ไม่ตรงกับลูกค้า", timings };
  }
  const sortedOrders = sortedOpportunityOrders(orders);
  const cycleOrder = requestedOrder || (manualOpportunityResult ? sortedOrders[sortedOrders.length - 1] : null);
  const cycleOrderId = String(cycleOrder?.id || "");
  const duplicateStartedAt = Date.now();
  if (manualOpportunityResult) {
    const existing = canUseExactCycle
      ? null
      : (duplicateRows || []).map(mapContactLogRow).find(log => {
        if (log.customerId !== customerId || log.result !== input.result) return false;
        if (!cycleOrderId) return log.date === input.date;
        return inferOpportunityLogOrderId(orders, log) === cycleOrderId;
      });
    timings.duplicateMs = Date.now() - duplicateStartedAt;
    if (existing) return { ok: true, log: { ...existing, orderId: inferOpportunityLogOrderId(orders, existing) }, duplicate: true, timings };
  } else {
    timings.duplicateMs = Date.now() - duplicateStartedAt;
  }
  const log = {
    id: canUseExactCycle ? deterministicOpportunityLogId(customerId, cycleOrderId, input.result) : uid("log"),
    customerId,
    date: input.date,
    result: String(input.result || "โทรติด").trim() || "โทรติด",
    note: manualOpportunityResult && cycleOrderId
      ? noteWithOpportunityCycle(input.note || "", cycleOrderId)
      : String(input.note || "").trim(),
    staff: String(input.staff || "").trim(),
    nextFollowUpDate: input.nextFollowUpDate || "",
    createdAt: new Date().toISOString(),
    orderId: cycleOrderId
  };
  const writeStartedAt = Date.now();
  const [, insertedRows] = await Promise.all([
    request("customers", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        last_contact_date: log.date || null,
        last_contact_note: log.note || ""
      })
    }, `?id=eq.${encodeURIComponent(customerId)}`),
    request("contact_logs", {
      method: "POST",
      headers: { Prefer: canUseExactCycle ? "resolution=ignore-duplicates,return=representation" : "return=representation" },
      body: JSON.stringify([contactLogRowPayload(log)])
    }, canUseExactCycle ? "?on_conflict=id" : "")
  ]);
  timings.writeMs = Date.now() - writeStartedAt;
  timings.serializeMs = 0;
  const duplicate = canUseExactCycle && Array.isArray(insertedRows) && insertedRows.length === 0;
  return { ok: true, log, duplicate, timings };
}

async function readNotificationReadIds(userId) {
  const user = String(userId || "").trim();
  if (!user) return [];
  const rows = await selectWhere("notification_reads", `user_id=eq.${encodeURIComponent(user)}`);
  return (rows || []).map(row => row.notification_id).filter(Boolean);
}

async function persistNotificationReadIds(userId, notificationIds = []) {
  const user = String(userId || "").trim();
  const ids = [...new Set((notificationIds || []).map(id => String(id || "").trim()).filter(Boolean))];
  if (!user || !ids.length) return readNotificationReadIds(user);
  await request("notification_reads", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify(ids.map(notificationId => ({
      user_id: user,
      notification_id: notificationId
    })))
  }, "?on_conflict=user_id,notification_id");
  return readNotificationReadIds(user);
}

function orderNumberFromRawText(rawText) {
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (parsed.__orderNumber) return String(parsed.__orderNumber);
    const nested = parsed.primary || parsed.merged;
    return nested ? orderNumberFromRawText(nested) : "";
  } catch {
    return "";
  }
}

function normalizeOrderNumber(value) {
  return String(value || "").trim();
}

function orderMetadataFromRawText(rawText) {
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const nested = parsed.primary || parsed.merged;
    return {
      alternatePhone: parsed.__alternatePhone || (nested ? orderMetadataFromRawText(nested).alternatePhone : "") || "",
      originSource: parsed.__originSource || (nested ? orderMetadataFromRawText(nested).originSource : "") || "",
      originSourceOther: parsed.__originSourceOther || (nested ? orderMetadataFromRawText(nested).originSourceOther : "") || "",
      lineMessageId: parsed.__lineMessageId || (nested ? orderMetadataFromRawText(nested).lineMessageId : "") || "",
      duplicateFingerprint: parsed.__duplicateFingerprint || (nested ? orderMetadataFromRawText(nested).duplicateFingerprint : "") || "",
      productId: parsed.__productId || (nested ? orderMetadataFromRawText(nested).productId : "") || "",
      packageId: parsed.__packageId || (nested ? orderMetadataFromRawText(nested).packageId : "") || "",
      packageName: parsed.__packageName || (nested ? orderMetadataFromRawText(nested).packageName : "") || "",
      paidQuantity: Number(parsed.__paidQuantity ?? (nested ? orderMetadataFromRawText(nested).paidQuantity : 0) ?? 0),
      freeQuantity: Number(parsed.__freeQuantity ?? (nested ? orderMetadataFromRawText(nested).freeQuantity : 0) ?? 0),
      totalQuantityShipped: Number(parsed.__totalQuantityShipped ?? (nested ? orderMetadataFromRawText(nested).totalQuantityShipped : 0) ?? 0),
      packageExpenses: Array.isArray(parsed.__packageExpenses)
        ? parsed.__packageExpenses
        : (nested ? orderMetadataFromRawText(nested).packageExpenses : []) || [],
      revenueSnapshot: Number(parsed.__revenueSnapshot ?? (nested ? orderMetadataFromRawText(nested).revenueSnapshot : 0) ?? 0),
      productCostSnapshot: Number(parsed.__productCostSnapshot ?? (nested ? orderMetadataFromRawText(nested).productCostSnapshot : 0) ?? 0),
      packageExpenseSnapshot: Number(parsed.__packageExpenseSnapshot ?? (nested ? orderMetadataFromRawText(nested).packageExpenseSnapshot : 0) ?? 0),
      globalExpenseSnapshot: Number(parsed.__globalExpenseSnapshot ?? (nested ? orderMetadataFromRawText(nested).globalExpenseSnapshot : 0) ?? 0),
      profitBeforeAdsSnapshot: Number(parsed.__profitBeforeAdsSnapshot ?? (nested ? orderMetadataFromRawText(nested).profitBeforeAdsSnapshot : 0) ?? 0),
      profitAfterAdsSnapshot: Number(parsed.__profitAfterAdsSnapshot ?? (nested ? orderMetadataFromRawText(nested).profitAfterAdsSnapshot : 0) ?? 0),
      profitSnapshotVersion: Number(parsed.__profitSnapshotVersion ?? (nested ? orderMetadataFromRawText(nested).profitSnapshotVersion : 0) ?? 0),
      profitSnapshotCreatedAt: parsed.__profitSnapshotCreatedAt || (nested ? orderMetadataFromRawText(nested).profitSnapshotCreatedAt : "") || "",
      profitSnapshotUpdatedAt: parsed.__profitSnapshotUpdatedAt || (nested ? orderMetadataFromRawText(nested).profitSnapshotUpdatedAt : "") || "",
      profitSnapshotSource: parsed.__profitSnapshotSource || (nested ? orderMetadataFromRawText(nested).profitSnapshotSource : "") || ""
    };
  } catch {
    return {};
  }
}

function rawTextWithOrderMetadata(order) {
  const rawText = String(order.rawText || "");
  let parsed;
  try {
    parsed = JSON.parse(rawText || "{}");
  } catch {
    parsed = rawText ? { primary: rawText } : {};
  }
  if (!parsed || typeof parsed !== "object") parsed = rawText ? { primary: rawText } : {};
  return JSON.stringify({
    ...parsed,
    __orderNumber: normalizeOrderNumber(order.orderNumber),
    __alternatePhone: order.alternatePhone || "",
    __originSource: order.originSource || "",
    __originSourceOther: order.originSourceOther || "",
    __lineMessageId: order.lineMessageId || "",
    __duplicateFingerprint: order.duplicateFingerprint || "",
    __productId: order.productId || "",
    __packageId: order.packageId || "",
    __packageName: order.packageName || "",
    __paidQuantity: Number(order.paidQuantity || 0),
    __freeQuantity: Number(order.freeQuantity || 0),
    __totalQuantityShipped: Number(order.totalQuantityShipped || 0),
    __packageExpenses: Array.isArray(order.packageExpenses) ? order.packageExpenses : [],
    __revenueSnapshot: Number(order.revenueSnapshot || 0),
    __productCostSnapshot: Number(order.productCostSnapshot || 0),
    __packageExpenseSnapshot: Number(order.packageExpenseSnapshot || 0),
    __globalExpenseSnapshot: Number(order.globalExpenseSnapshot || 0),
    __profitBeforeAdsSnapshot: Number(order.profitBeforeAdsSnapshot || 0),
    __profitAfterAdsSnapshot: Number(order.profitAfterAdsSnapshot || 0),
    __profitSnapshotVersion: Number(order.profitSnapshotVersion || 0),
    __profitSnapshotCreatedAt: order.profitSnapshotCreatedAt || "",
    __profitSnapshotUpdatedAt: order.profitSnapshotUpdatedAt || "",
    __profitSnapshotSource: order.profitSnapshotSource || ""
  });
}

function fromSupabaseShape(data) {
  const customerTagMap = new Map();
  for (const row of data.customer_tags || []) {
    if (!customerTagMap.has(row.customer_id)) customerTagMap.set(row.customer_id, []);
    customerTagMap.get(row.customer_id).push(row.tag_name);
  }
  const mappedSettings = mapSettings(data.settings);
  return {
    settings: mappedSettings,
    followUpRules: (data.follow_up_rules || []).map(rule => ({ jars: rule.jars, days: rule.days })),
    tags: (data.tags || []).map(tag => tag.name),
    users: (data.users || []).map(user => ({
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      name: user.name,
      role: user.role,
      phone: user.phone || "",
      active: user.is_active,
      avatar: String(mappedSettings[`profile_avatar_${user.id}`] || ""),
      themePreference: String(mappedSettings[`theme_preference_${user.id}`] || "system")
    })),
    customers: (data.customers || []).map(customer => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.latest_address || "",
      tags: customerTagMap.get(customer.id) || [],
      note: customer.note || "",
      createdAt: customer.created_at?.slice(0, 10) || "",
      lastContactDate: customer.last_contact_date || "",
      lastContactNote: customer.last_contact_note || "",
      assignedTo: customer.assigned_to || ""
    })),
    orders: (data.orders || []).map(order => ({
      id: order.id,
      customerId: order.customer_id,
      orderNumber: normalizeOrderNumber(order.order_number) || orderNumberFromRawText(order.raw_text),
      customerName: order.customer_name || "",
      phone: order.phone || "",
      address: order.address || "",
      date: order.order_date,
      time: order.order_time || "",
      items: order.items || "Growup",
      jars: order.quantity,
      amount: order.amount,
      source: order.source || "",
      sourceChannel: order.source_channel || "",
      socialName: order.social_name || "",
      freeGift: order.free_gift || "",
      vipCardStatus: order.vip_card_status || "",
      rawText: order.raw_text || "",
      note: order.note || "",
      createdAt: order.created_at || "",
      updatedAt: order.updated_at || ""
    })).map(order => ({ ...order, ...orderMetadataFromRawText(order.rawText) })),
    lineMessages: (data.line_messages || []).map(message => ({
      id: message.id,
      receivedAt: message.created_at,
      rawEvent: message.raw_event || {},
      text: message.raw_text || "",
      raw_text: message.raw_text || ""
    })),
    contactLogs: (data.contact_logs || []).map(log => ({
      id: log.id,
      customerId: log.customer_id,
      date: log.contact_date,
      result: log.result,
      note: log.note || "",
      staff: log.contacted_by || "",
      nextFollowUpDate: log.next_follow_up_date || "",
      createdAt: log.created_at || "",
      orderId: opportunityLogOrderId(log)
    })),
    subscriptions: (data.subscriptions || []).map(subscription => ({
      id: subscription.id,
      tenantId: subscription.tenant_id,
      source: subscription.source || "",
      isInitial: subscription.is_initial !== false,
      plan: subscription.plan || "",
      billingInterval: subscription.billing_interval || "",
      status: subscription.status || "",
      currency: subscription.currency || "THB",
      baseAmountMinor: Number(subscription.base_amount_minor || 0),
      discountAmountMinor: Number(subscription.discount_amount_minor || 0),
      amountDueMinor: Number(subscription.amount_due_minor || 0),
      promotionCode: subscription.promotion_code || "",
      promotionBenefitType: subscription.promotion_benefit_type || "",
      promotionBenefitValue: subscription.promotion_benefit_value,
      promotionBenefitDescription: subscription.promotion_benefit_description || "",
      ...(require("../checkout-promo").checkoutPromoEnabled() ? { promotionSnapshot: subscription.promotion_snapshot || {} } : {}),
      extraTrialDays: Number(subscription.extra_trial_days || 0),
      freeMonths: Number(subscription.free_months || 0),
      trialStartedAt: subscription.trial_started_at || "",
      trialEndsAt: subscription.trial_ends_at || "",
      currentPeriodStartedAt: subscription.current_period_started_at || "",
      currentPeriodEndsAt: subscription.current_period_ends_at || "",
      nextRenewalAt: subscription.next_renewal_at || "",
      paymentDueAt: subscription.payment_due_at || "",
      createdAt: subscription.created_at || "",
      updatedAt: subscription.updated_at || ""
    })),
    payments: (data.payments || []).map(payment => ({
      id: payment.id,
      tenantId: payment.tenant_id,
      subscriptionId: payment.subscription_id,
      idempotencyKey: payment.idempotency_key || "",
      provider: payment.provider || "",
      providerPaymentReference: payment.provider_payment_reference || "",
      operation: payment.operation || payment.checkout_metadata?.operation || "",
      currentPlan: payment.current_plan || payment.checkout_metadata?.current_plan || "",
      targetPlan: payment.target_plan || payment.checkout_metadata?.target_plan || payment.plan || "",
      checkoutMetadata: payment.checkout_metadata || {},
      providerMetadata: payment.provider_metadata || {},
      status: payment.status || "",
      currency: payment.currency || "THB",
      amountMinor: Number(payment.amount_minor || 0),
      plan: payment.plan || "",
      billingInterval: payment.billing_interval || "",
      billingPeriodStartedAt: payment.billing_period_started_at || "",
      billingPeriodEndsAt: payment.billing_period_ends_at || "",
      createdAt: payment.created_at || "",
      updatedAt: payment.updated_at || "",
      paidAt: payment.paid_at || ""
    }))
  };
}

async function readDb() {
  const startedAt = Date.now();
  const tableTimings = {};
  async function timedSelect(table) {
    const tableStartedAt = Date.now();
    const rows = await select(table);
    tableTimings[table] = Date.now() - tableStartedAt;
    return rows;
  }
  const [
    users,
    customers,
    orders,
    line_messages,
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs,
    subscriptions,
    payments
  ] = await Promise.all([
    (async () => {
      const tableStartedAt = Date.now();
      const rows = await selectUsersForTenantContext();
      tableTimings.users = Date.now() - tableStartedAt;
      return rows;
    })(),
    timedSelect("customers"),
    timedSelect("orders"),
    timedSelect("line_messages"),
    timedSelect("follow_up_rules"),
    timedSelect("settings"),
    timedSelect("tags"),
    timedSelect("customer_tags"),
    timedSelect("contact_logs"),
    safeSelect("subscriptions"),
    safeSelect("payments")
  ]);
  const mapStartedAt = Date.now();
  const mapped = fromSupabaseShape({ users, customers, orders, line_messages, follow_up_rules, settings, tags, customer_tags, contact_logs, subscriptions, payments });
  const mapMs = Date.now() - mapStartedAt;
  const syncStartedAt = Date.now();
  const synced = synchronizeCustomers(mapped);
  readDb.lastTimings = {
    totalMs: Date.now() - startedAt,
    tables: tableTimings,
    mapMs,
    syncMs: Date.now() - syncStartedAt
  };
  return synced;
}

async function findUserForLogin(username) {
  const value = String(username || "").trim();
  if (!value) return null;
  let rows = await selectWhereUnscoped("users", `username=eq.${encodeURIComponent(value)}&limit=1`);
  if (!rows?.length) {
    rows = await selectWhereUnscoped("users", `id=eq.${encodeURIComponent(value)}&limit=1`);
  }
  const user = rows?.[0];
  if (!user) return null;
  if (user.is_active === false) return null;
  const tenant = await resolveTenantForUser(user.id);
  if (!tenant) return null;
  return withTenantContext(tenant, async () => {
    const [themeRows, avatarRows] = await Promise.all([
      selectWhere("settings", `key=eq.${encodeURIComponent(`theme_preference_${user.id}`)}&limit=1`),
      selectWhere("settings", `key=eq.${encodeURIComponent(`profile_avatar_${user.id}`)}&limit=1`)
    ]);
    return {
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      name: user.name,
      role: user.role,
      phone: user.phone || "",
      active: user.is_active,
      avatar: String(avatarRows?.[0]?.value || ""),
      themePreference: String(themeRows?.[0]?.value || "system"),
      ...tenant
    };
  });
}

async function readUserById(id) {
  const value = String(id || "").trim();
  if (!value) return null;
  const tenant = await resolveTenantForUser(value);
  if (!tenant) return null;
  const [users, avatarRows, themeRows] = await withTenantContext(tenant, () => Promise.all([
    selectWhereUnscoped("users", `id=eq.${encodeURIComponent(value)}&limit=1`),
    selectWhere("settings", `key=eq.${encodeURIComponent(`profile_avatar_${value}`)}&limit=1`),
    selectWhere("settings", `key=eq.${encodeURIComponent(`theme_preference_${value}`)}&limit=1`)
  ]));
  const user = users?.[0];
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    passwordHash: user.password_hash,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    active: user.is_active,
    avatar: String(avatarRows?.[0]?.value || ""),
    themePreference: String(themeRows?.[0]?.value || "system"),
    ...tenant
  };
}

async function createSignupTenantAccount(input = {}) {
  const rows = await rpc("growup_signup_bootstrap", {
    p_idempotency_key: String(input.idempotencyKey || ""),
    p_user_id: String(input.userId || ""),
    p_username: String(input.username || ""),
    p_password_hash: String(input.passwordHash || ""),
    p_name: String(input.name || ""),
    p_business_name: String(input.businessName || ""),
    p_defaults: input.defaults && typeof input.defaults === "object" ? input.defaults : {},
    p_promotion_code: String(input.promotionCode || ""),
    p_selected_plan: String(input.selectedPlan || ""),
    p_selected_billing: String(input.selectedBilling || "")
  }).catch(error => {
    const detail = String(error.detail || error.message || "");
    if (
      detail.includes("ACCOUNT_EXISTS")
      || (
        detail.includes("23505")
        && detail.includes("duplicate key")
        && detail.includes("users_username_key")
      )
    ) {
      const next = new Error("ACCOUNT_EXISTS");
      next.code = "ACCOUNT_EXISTS";
      throw next;
    }
    if (detail.includes("IDEMPOTENCY_CONFLICT")) {
      const next = new Error("IDEMPOTENCY_CONFLICT");
      next.code = "IDEMPOTENCY_CONFLICT";
      throw next;
    }
    if (detail.includes("INVALID_SIGNUP_INPUT")) {
      const next = new Error("INVALID_SIGNUP_INPUT");
      next.code = "INVALID_SIGNUP_INPUT";
      throw next;
    }
    for (const code of ["PROMOTION_CODE_INVALID", "PROMOTION_CODE_NOT_ALLOWED", "PROMOTION_CODE_EXPIRED", "PROMOTION_CODE_EXHAUSTED", "PROMOTION_CODE_PAYMENT_REQUIRED"]) {
      if (detail.includes(code)) {
        const next = new Error(code);
        next.code = code;
        throw next;
      }
    }
    throw error;
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.user_id || !row?.tenant_id) return null;
  return {
    id: row.user_id,
    username: row.username,
    passwordHash: input.passwordHash,
    name: row.name,
    role: row.role || "Owner",
    phone: row.phone || "",
    active: row.is_active !== false,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name || input.businessName || "",
    tenantRole: row.tenant_role || "Owner",
    themePreference: "system"
  };
}

async function validatePromotionCode(input = {}) {
  const rows = await rpc("growup_validate_promotion_code", {
    p_code: String(input.promotionCode || input.code || ""),
    p_selected_plan: String(input.selectedPlan || ""),
    p_selected_billing: String(input.selectedBilling || "")
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row?.valid) {
    return {
      valid: false,
      reason: String(row?.reason || "PROMOTION_CODE_INVALID")
    };
  }
  return {
    valid: true,
    code: String(row.code || ""),
    selectedPlan: String(row.selected_plan || ""),
    selectedBilling: String(row.selected_billing || ""),
    benefitType: String(row.benefit_type || ""),
    benefitDescription: String(row.benefit_description || "")
  };
}

async function quoteSignupPromotion(input = {}) {
  return normalizeRpcRow(await rpc("growup_quote_signup_promotion", {
    p_code: String(input.promotionCode || input.code || ""),
    p_selected_plan: String(input.selectedPlan || input.plan || ""),
    p_selected_billing: String(input.selectedBilling || input.billing || "")
  }));
}

function normalizeRpcRow(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

async function beginSubscriptionPayment(input = {}) {
  const row = normalizeRpcRow(await rpc("growup_begin_subscription_payment", {
    p_tenant_id: String(input.tenantId || input.tenant_id || ""),
    p_user_id: String(input.userId || input.user_id || ""),
    p_idempotency_key: String(input.idempotencyKey || input.idempotency_key || ""),
    p_provider: String(input.provider || "provider_required")
  }));
  if (!row) return null;
  return {
    id: row.payment_id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    plan: row.plan || "",
    billingInterval: row.billing_interval || "",
    idempotencyKey: row.idempotency_key || "",
    providerPaymentReference: row.provider_payment_reference || "",
    billingPeriodStartedAt: row.billing_period_started_at || "",
    billingPeriodEndsAt: row.billing_period_ends_at || "",
    createdAt: row.created_at || ""
  };
}

async function beginSubscriptionCheckout(input = {}) {
  const promoConsumer = require("../checkout-promo").checkoutPromoEnabled();
  const promotionCode = String(input.promotionCode || "").trim();
  if (promotionCode && !promoConsumer) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  const payload = {
    p_tenant_id: String(input.tenantId || input.tenant_id || ""),
    p_user_id: String(input.userId || input.user_id || ""),
    p_target_plan: String(input.targetPlan || input.target_plan || ""),
    p_billing_interval: String(input.billingInterval || input.billing_interval || ""),
    p_intent: String(input.intent || input.operation || ""),
    p_idempotency_key: String(input.idempotencyKey || input.idempotency_key || ""),
    p_provider: String(input.provider || "provider_required")
  };
  let row;
  try {
    row = normalizeRpcRow(await rpc(promoConsumer ? "growup_begin_subscription_promo_checkout" : "growup_begin_subscription_checkout",
      promoConsumer ? { ...payload, p_promotion_code: promotionCode } : payload));
  } catch (error) {
    if (promoConsumer) throw error; // Never fall back to an undiscounted/unchecked checkout.
    const detail = String(error.detail || error.message || "");
    if (!/unknown (?:rpc|table).*growup_begin_subscription_checkout|PGRST202|function public\.growup_begin_subscription_checkout/i.test(detail)) throw error;
    const legacy = payload.p_intent === "subscription_upgrade"
      ? await beginSubscriptionUpgrade(input)
      : await beginSubscriptionPayment(input);
    if (!legacy) return null;
    return {
      ...legacy,
      id: legacy.paymentId || legacy.id,
      paymentId: legacy.paymentId || legacy.id,
      currentPlan: legacy.currentPlan || "",
      targetPlan: legacy.targetPlan || legacy.plan || payload.p_target_plan,
      plan: legacy.targetPlan || legacy.plan || payload.p_target_plan,
      operation: payload.p_intent
    };
  }
  if (!row) return null;
  return {
    id: row.payment_id,
    paymentId: row.payment_id,
    upgradeId: row.upgrade_id || "",
    ...(promoConsumer ? { checkoutMetadata: row.checkout_metadata || {} } : {}),
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    currentPlan: row.current_plan || "",
    targetPlan: row.target_plan || "",
    plan: row.target_plan || "",
    operation: row.operation || "",
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    billingInterval: row.billing_interval || "monthly",
    idempotencyKey: row.idempotency_key || "",
    providerPaymentReference: row.provider_payment_reference || "",
    billingPeriodStartedAt: row.billing_period_started_at || "",
    billingPeriodEndsAt: row.billing_period_ends_at || "",
    createdAt: row.created_at || ""
  };
}

function subscriptionUpgradeRow(row = {}) {
  if (!row) return null;
  return {
    id: row.upgrade_id,
    paymentId: row.payment_id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    currentPlan: row.current_plan || "",
    targetPlan: row.target_plan || "",
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    billingInterval: row.billing_interval || "monthly",
    idempotencyKey: row.idempotency_key || "",
    providerPaymentReference: row.provider_payment_reference || "",
    billingPeriodStartedAt: row.billing_period_started_at || "",
    billingPeriodEndsAt: row.billing_period_ends_at || "",
    paidAt: row.paid_at || "",
    createdAt: row.created_at || ""
  };
}

async function beginSubscriptionUpgrade(input = {}) {
  const row = normalizeRpcRow(await rpc("growup_begin_subscription_upgrade", {
    p_tenant_id: String(input.tenantId || input.tenant_id || ""),
    p_user_id: String(input.userId || input.user_id || ""),
    p_target_plan: String(input.targetPlan || input.target_plan || ""),
    p_idempotency_key: String(input.idempotencyKey || input.idempotency_key || ""),
    p_provider: String(input.provider || "provider_required")
  }));
  return subscriptionUpgradeRow(row);
}

async function setPaymentProviderReference(input = {}) {
  const row = normalizeRpcRow(await rpc("growup_set_payment_provider_reference", {
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_tenant_id: String(input.tenantId || input.tenant_id || ""),
    p_provider: String(input.provider || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_status: String(input.status || "pending"),
    p_provider_metadata: input.providerMetadata && typeof input.providerMetadata === "object" ? input.providerMetadata : {}
  }));
  if (!row) return null;
  return {
    id: row.payment_id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    plan: row.plan || "",
    billingInterval: row.billing_interval || "",
    providerPaymentReference: row.provider_payment_reference || "",
    createdAt: row.created_at || ""
  };
}

async function recordProviderPaymentSuccess(input = {}) {
  return normalizeRpcRow(await rpc("growup_record_provider_payment_success", {
    p_provider: String(input.provider || ""),
    p_provider_event_id: String(input.providerEventId || input.provider_event_id || ""),
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_amount_minor: Number(input.amountMinor ?? input.amount_minor ?? 0),
    p_currency: String(input.currency || ""),
    p_raw_event: input.rawEvent && typeof input.rawEvent === "object" ? input.rawEvent : {}
  }));
}

async function recordSubscriptionCheckoutSuccess(input = {}) {
  const payload = {
    p_provider: String(input.provider || ""),
    p_provider_event_id: String(input.providerEventId || input.provider_event_id || ""),
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_amount_minor: Number(input.amountMinor ?? input.amount_minor ?? 0),
    p_currency: String(input.currency || ""),
    p_raw_event: input.rawEvent && typeof input.rawEvent === "object" ? input.rawEvent : {}
  };
  try {
    return normalizeRpcRow(await rpc("growup_record_subscription_checkout_success", payload));
  } catch (error) {
    const detail = String(error.detail || error.message || "");
    if (!/unknown (?:rpc|table).*growup_record_subscription_checkout_success|PGRST202|function public\.growup_record_subscription_checkout_success/i.test(detail)) throw error;
    return String(input.operation || "") === "subscription_upgrade"
      ? recordSubscriptionUpgradeSuccess(input)
      : recordProviderPaymentSuccess(input);
  }
}

async function recordProviderPaymentStatus(input = {}) {
  return normalizeRpcRow(await rpc("growup_record_provider_payment_status", {
    p_provider: String(input.provider || ""),
    p_provider_event_id: String(input.providerEventId || input.provider_event_id || ""),
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_amount_minor: Number(input.amountMinor ?? input.amount_minor ?? 0),
    p_currency: String(input.currency || ""),
    p_status: String(input.status || ""),
    p_raw_event: input.rawEvent && typeof input.rawEvent === "object" ? input.rawEvent : {}
  }));
}

async function recordSubscriptionUpgradeSuccess(input = {}) {
  return subscriptionUpgradeRow(normalizeRpcRow(await rpc("growup_record_subscription_upgrade_success", {
    p_provider: String(input.provider || ""),
    p_provider_event_id: String(input.providerEventId || input.provider_event_id || ""),
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_amount_minor: Number(input.amountMinor ?? input.amount_minor ?? 0),
    p_currency: String(input.currency || ""),
    p_raw_event: input.rawEvent && typeof input.rawEvent === "object" ? input.rawEvent : {}
  })));
}

async function recordSubscriptionUpgradeStatus(input = {}) {
  return subscriptionUpgradeRow(normalizeRpcRow(await rpc("growup_record_subscription_upgrade_status", {
    p_provider: String(input.provider || ""),
    p_provider_event_id: String(input.providerEventId || input.provider_event_id || ""),
    p_payment_id: String(input.paymentId || input.payment_id || ""),
    p_provider_payment_reference: String(input.providerPaymentReference || input.provider_payment_reference || ""),
    p_amount_minor: Number(input.amountMinor ?? input.amount_minor ?? 0),
    p_currency: String(input.currency || ""),
    p_status: String(input.status || ""),
    p_raw_event: input.rawEvent && typeof input.rawEvent === "object" ? input.rawEvent : {}
  })));
}

async function releaseCanceledPromoPayment(input = {}) {
  if (!require("../checkout-promo").checkoutPromoEnabled()) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  return normalizeRpcRow(await rpc("growup_release_canceled_promo_payment", {
    p_payment_id: input.paymentId, p_tenant_id: input.tenantId,
    p_reference: input.providerPaymentReference, p_amount: input.amountMinor,
    p_currency: input.currency, p_event_id: input.providerEventId
  }));
}

async function abandonPromoCheckout(input = {}) {
  if (!require("../checkout-promo").checkoutPromoEnabled()) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  return normalizeRpcRow(await rpc("growup_abandon_promo_checkout", {
    p_payment_id: input.paymentId,p_tenant_id: input.tenantId,p_user_id: input.userId,p_confirmed: input.confirmed === true
  }));
}

async function quoteCheckoutPromotion(input) {
  if (!require("../checkout-promo").checkoutPromoEnabled()) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  return normalizeRpcRow(await rpc("growup_quote_checkout_promotion",{
    p_tenant_id:input.tenantId,p_user_id:input.userId,p_code:input.code,p_plan:input.plan,p_billing:input.billing
  }));
}
async function redeemZeroPaymentPromo(input) {
  if (!require("../checkout-promo").checkoutPromoEnabled()) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  return normalizeRpcRow(await rpc("growup_redeem_zero_payment_promo",{
    p_tenant_id:input.tenantId,p_user_id:input.userId,p_code:input.code,p_plan:input.plan,p_billing:input.billing,
    p_request_key:input.requestKey,p_definition_version:input.definition_version
  }));
}

async function activateZeroAmountSubscriptionPayment(input = {}) {
  const row = normalizeRpcRow(await rpc("growup_activate_zero_amount_subscription_payment", {
    p_tenant_id: String(input.tenantId || input.tenant_id || ""),
    p_user_id: String(input.userId || input.user_id || ""),
    p_idempotency_key: String(input.idempotencyKey || input.idempotency_key || "")
  }));
  if (!row) return null;
  return {
    id: row.payment_id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    plan: row.plan || "",
    billingInterval: row.billing_interval || "",
    providerPaymentReference: row.provider_payment_reference || "",
    createdAt: row.created_at || ""
  };
}

async function readPaymentByProviderReference(provider, providerPaymentReference) {
  const cleanProvider = String(provider || "").trim();
  const cleanReference = String(providerPaymentReference || "").trim();
  if (!cleanProvider || !cleanReference) return null;
  const rows = await selectWhereUnscoped(
    "payments",
    `provider=eq.${encodeURIComponent(cleanProvider)}&provider_payment_reference=eq.${encodeURIComponent(cleanReference)}&limit=1`
  ).catch(() => []);
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subscriptionId: row.subscription_id,
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    plan: row.plan || "",
    billingInterval: row.billing_interval || "",
    providerPaymentReference: row.provider_payment_reference || "",
    operation: row.checkout_metadata?.operation || "",
    currentPlan: row.checkout_metadata?.current_plan || "",
    targetPlan: row.checkout_metadata?.target_plan || row.plan || "",
    checkoutMetadata: row.checkout_metadata && typeof row.checkout_metadata === "object" ? row.checkout_metadata : {},
    createdAt: row.created_at || "",
    paidAt: row.paid_at || ""
  };
}

async function readPendingSubscriptionUpgrades(tenantId) {
  const cleanTenantId = String(tenantId || "").trim();
  if (!cleanTenantId) return [];
  const rows = await selectWhere(
    "subscription_upgrade_attempts",
    `tenant_id=eq.${encodeURIComponent(cleanTenantId)}&status=in.(pending,processing)&order=created_at.desc&limit=20`
  ).catch(error => {
    const detail = String(error.detail || error.message || "");
    if (detail.includes("404") || detail.includes("PGRST205")) return [];
    throw error;
  });
  return (rows || []).map(row => ({
    id: row.id || "",
    paymentId: row.payment_id || "",
    tenantId: row.tenant_id || "",
    subscriptionId: row.subscription_id || "",
    currentPlan: row.current_plan || "",
    targetPlan: row.target_plan || "",
    provider: row.provider || "",
    status: row.status || "",
    currency: row.currency || "THB",
    amountMinor: Number(row.amount_minor || 0),
    billingInterval: row.billing_interval || "monthly",
    idempotencyKey: row.idempotency_key || "",
    providerPaymentReference: row.provider_payment_reference || "",
    billingPeriodStartedAt: row.billing_period_started_at || "",
    billingPeriodEndsAt: row.billing_period_ends_at || "",
    createdAt: row.created_at || ""
  }));
}

async function closeTerminalSubscriptionUpgradeAttempt(input = {}) {
  const attemptId = String(input.attemptId || input.attempt_id || "").trim();
  const tenantId = String(input.tenantId || input.tenant_id || "").trim();
  const status = String(input.status || "").trim().toLowerCase();
  if (!attemptId || !tenantId || !["failed", "cancelled", "expired"].includes(status)) return null;
  const now = new Date().toISOString();
  const patch = { status, updated_at: now };
  if (status === "failed") patch.failed_at = now;
  if (status === "cancelled") patch.cancelled_at = now;
  if (status === "expired") patch.expired_at = now;
  const rows = await request(
    "subscription_upgrade_attempts",
    { method: "PATCH", body: JSON.stringify(patch) },
    `?id=eq.${encodeURIComponent(attemptId)}&tenant_id=eq.${encodeURIComponent(tenantId)}&status=in.(pending,processing)&select=*`
  ).catch(error => {
    const detail = String(error.detail || error.message || "");
    if (detail.includes("404") || detail.includes("PGRST205")) return [];
    throw error;
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

async function platformAdminOverview(userId) {
  return rpc("growup_platform_admin_overview", { p_user_id: String(userId || "") });
}

async function platformAdminTenants(userId, input = {}) {
  return rpc("growup_platform_admin_tenants", {
    p_user_id: String(userId || ""),
    p_search: String(input.search || ""),
    p_limit: Number(input.limit || 50),
    p_offset: Number(input.offset || 0)
  });
}

async function platformAdminTenantDetail(userId, tenantId) {
  return rpc("growup_platform_admin_tenant_detail", {
    p_user_id: String(userId || ""),
    p_tenant_id: String(tenantId || "")
  });
}

async function platformAdminPayments(userId, input = {}) {
  return rpc("growup_platform_admin_payments", {
    p_user_id: String(userId || ""),
    p_status: String(input.status || ""),
    p_limit: Number(input.limit || 50),
    p_offset: Number(input.offset || 0)
  });
}

async function platformAdminPromotionCodes(userId) {
  return rpc("growup_platform_admin_promotion_codes", { p_user_id: String(userId || "") });
}

async function platformAdminUpsertPromotionCode(userId, input = {}) {
  return rpc("growup_platform_admin_upsert_promotion_code", {
    p_user_id: String(userId || ""),
    p_input: input && typeof input === "object" ? input : {}
  });
}

async function writeDb(db) {
  const context = requireTenantContext("settings", "write");
  synchronizeCustomers(db);
  await upsert("settings", settingsRows(db.settings));
  await upsert("follow_up_rules", (db.followUpRules || []).map(rule => ({ id: String(rule.jars), jars: rule.jars, days: rule.days })));
  await upsert("tags", (db.tags || []).map(name => ({ id: name, name })));
  await upsert("users", (db.users || []).map(user => ({
    id: user.id,
    username: user.username,
    password_hash: user.passwordHash,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    is_active: user.active !== false
  })));
  const tenantUsers = (db.users || []).filter(user => user?.id);
  if (tenantUsers.length) {
    const existingMemberships = await selectWhereUnscopedInChunks(
      "tenant_memberships",
      "user_id",
      tenantUsers.map(user => user.id),
      `tenant_id=eq.${encodeURIComponent(context.tenantId)}`
    ).catch(() => []);
    const membershipByUser = new Map((existingMemberships || []).map(row => [row.user_id, row]));
    await upsert("tenant_memberships", tenantUsers.map(user => {
      const existing = membershipByUser.get(user.id);
      return {
        id: existing?.id || deterministicTenantMembershipId(context.tenantId, user.id),
        user_id: user.id,
        role: user.role,
        is_active: user.active !== false
      };
    }));
  }
  const existingCustomers = await selectWhere("customers", "select=id");
  const nextCustomerIds = new Set((db.customers || []).map(customer => customer.id));
  const orphanCustomerIds = (existingCustomers || [])
    .map(customer => customer.id)
    .filter(id => !nextCustomerIds.has(id));
  await upsert("customers", (db.customers || []).map(customerRowPayload));
  const customerTags = [];
  for (const customer of db.customers || []) {
    for (const tag of customer.tags || []) {
      customerTags.push({ id: `${customer.id}_${tag}`, customer_id: customer.id, tag_name: tag });
    }
  }
  await upsert("orders", (db.orders || []).map(orderRowPayload));
  if (orphanCustomerIds.length) {
    await deleteIdsInChunks("customers", "id", orphanCustomerIds);
  }
  await request("customer_tags", { method: "DELETE" }, "?customer_id=not.is.null");
  await upsert("customer_tags", customerTags);
  await upsert("line_messages", (db.lineMessages || []).map(message => ({
    id: message.id,
    raw_text: message.text || message.raw_text || "",
    raw_event: message.rawEvent || {}
  })));
  await upsert("contact_logs", (db.contactLogs || []).map(log => ({
    id: log.id,
    customer_id: log.customerId,
    contact_date: log.date,
    contacted_by: log.staff || "",
    result: log.result,
    note: log.note || "",
    next_follow_up_date: log.nextFollowUpDate || null,
    created_at: log.createdAt || undefined
  })));
}

async function persistSettingsPatch(patch = {}) {
  await upsert("settings", settingsRows(patch));
}

async function persistUserProfile(userId, { displayName, avatar }) {
  const rows = await selectWhere("users", `id=eq.${encodeURIComponent(userId)}&limit=1`);
  const stored = rows?.[0];
  if (!stored) return null;
  await upsert("users", [{
    id: stored.id,
    username: stored.username,
    password_hash: stored.password_hash,
    name: displayName,
    role: stored.role,
    phone: stored.phone || "",
    is_active: stored.is_active !== false
  }]);
  await upsert("settings", [{
    id: `profile_avatar_${userId}`,
    key: `profile_avatar_${userId}`,
    value: avatar || ""
  }]);
  const themeRows = await selectWhere("settings", `key=eq.${encodeURIComponent(`theme_preference_${userId}`)}&limit=1`);
  return {
    id: stored.id,
    username: stored.username,
    passwordHash: stored.password_hash,
    name: displayName,
    role: stored.role,
    phone: stored.phone || "",
    active: stored.is_active !== false,
    avatar: avatar || "",
    themePreference: String(themeRows?.[0]?.value || "system")
  };
}

async function persistUserThemePreference(userId, themePreference) {
  const rows = await selectWhere("users", `id=eq.${encodeURIComponent(userId)}&limit=1`);
  const stored = rows?.[0];
  if (!stored) return null;
  const normalized = ["dark", "light", "system"].includes(themePreference) ? themePreference : "system";
  await upsert("settings", [{
    id: `theme_preference_${userId}`,
    key: `theme_preference_${userId}`,
    value: normalized
  }]);
  const avatarRows = await selectWhere("settings", `key=eq.${encodeURIComponent(`profile_avatar_${userId}`)}&limit=1`);
  return {
    id: stored.id,
    username: stored.username,
    passwordHash: stored.password_hash,
    name: stored.name,
    role: stored.role,
    phone: stored.phone || "",
    active: stored.is_active !== false,
    avatar: String(avatarRows?.[0]?.value || ""),
    themePreference: normalized
  };
}

async function persistOrderMutation(change = {}, settings = null) {
  const startedAt = Date.now();
  const timings = {};
  async function timedStep(name, task) {
    const stepStartedAt = Date.now();
    const result = await task();
    timings[name] = Date.now() - stepStartedAt;
    return result;
  }
  const affectedCustomerIds = Array.from(new Set(change.affectedCustomerIds || []));
  const settingsRowsForOrder = settings && typeof settings === "object" && Array.isArray(settings.products)
    ? [{ id: "products", key: "products", value: settings.products }]
    : [];
  if (change.customers?.length) {
    await timedStep("customersUpsertMs", () => upsert("customers", change.customers.map(customerRowPayload)));
  } else {
    timings.customersUpsertMs = 0;
  }
  const customerTags = [];
  for (const customer of change.customers || []) {
    for (const tag of customer.tags || []) {
      customerTags.push({ id: `${customer.id}_${tag}`, customer_id: customer.id, tag_name: tag });
    }
  }
  await Promise.all([
    settingsRowsForOrder.length
      ? timedStep("settingsProductsUpsertMs", () => upsert("settings", settingsRowsForOrder))
      : Promise.resolve(timings.settingsProductsUpsertMs = 0),
    change.deletedOrderId
      ? timedStep("orderDeleteMs", () => deleteOrder(change.deletedOrderId))
      : Promise.resolve(timings.orderDeleteMs = 0),
    change.order
      ? timedStep("orderUpsertMs", () => upsert("orders", [orderRowPayload(change.order)]))
      : Promise.resolve(timings.orderUpsertMs = 0),
    affectedCustomerIds.length
      ? timedStep("customerTagsDeleteMs", () => deleteIdsInChunks("customer_tags", "customer_id", affectedCustomerIds))
      : Promise.resolve(timings.customerTagsDeleteMs = 0),
    timedStep("tagsUpsertMs", () => upsert("tags", (change.tags || []).map(name => ({ id: name, name }))))
  ]);
  await timedStep("customerTagsUpsertMs", () => upsert("customer_tags", customerTags));
  if (change.deletedCustomerIds?.length) {
    await Promise.all([
      timedStep("deletedCustomersDeleteMs", () => deleteIdsInChunks("customers", "id", change.deletedCustomerIds)),
      timedStep("deletedContactLogsDeleteMs", () => deleteIdsInChunks("contact_logs", "customer_id", change.deletedCustomerIds))
    ]);
  } else {
    timings.deletedCustomersDeleteMs = 0;
    timings.deletedContactLogsDeleteMs = 0;
  }
  timings.totalMs = Date.now() - startedAt;
  return timings;
}

function lineMessageStorageId(messageId = "") {
  const normalized = String(messageId || "").trim();
  return normalized
    ? `line_event_${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`
    : uid("line_event");
}

function lineMessageRowPayload(message = {}) {
  return {
    id: message.id || lineMessageStorageId(message.messageId),
    raw_text: message.text || message.raw_text || "",
    raw_event: message.rawEvent || {},
    created_at: message.receivedAt || undefined
  };
}

function lineMessageProcessingStatus(message = {}) {
  return String(message.rawEvent?.__debug?.processing_status || "").trim().toLowerCase();
}

async function claimLineMessage(message = {}) {
  requireTenantContext("line_messages", "claim");
  const id = message.id || lineMessageStorageId(message.messageId);
  const existing = await selectWhere("line_messages", `id=eq.${encodeURIComponent(id)}&limit=1`);
  if (existing?.length) {
    const status = lineMessageProcessingStatus({ rawEvent: existing[0].raw_event || {} });
    if (status && status === "failed") {
      await request("line_messages", {
        method: "PATCH",
        body: JSON.stringify({ raw_text: message.text || message.raw_text || "", raw_event: message.rawEvent || {} })
      }, `?id=eq.${encodeURIComponent(id)}`);
      return { claimed: true, existing: true, id };
    }
    return { claimed: false, existing: true, id, status: status || "legacy" };
  }
  const inserted = await request("line_messages", {
    method: "POST",
    body: JSON.stringify([lineMessageRowPayload({ ...message, id })]),
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" }
  }, "?on_conflict=id");
  const rows = Array.isArray(inserted) ? inserted : [];
  return { claimed: rows.some(row => String(row?.id || "") === id), existing: false, id };
}

async function persistLineMessageRecord(message = {}) {
  requireTenantContext("line_messages", "write");
  const id = message.id || lineMessageStorageId(message.messageId);
  return upsert("line_messages", [lineMessageRowPayload({ ...message, id })]);
}

async function verifyPersistedOrder(order = {}) {
  const context = requireTenantContext("orders", "verify");
  const orderId = String(order.id || "").trim();
  const rows = orderId
    ? await selectWhere("orders", `id=eq.${encodeURIComponent(orderId)}&limit=1`)
    : [];
  const stored = rows?.[0] || null;
  const metadata = stored ? orderMetadataFromRawText(stored.raw_text || "") : {};
  const checks = {
    id: Boolean(stored),
    customerId: !order.customerId || String(stored?.customer_id || "") === String(order.customerId),
    date: !order.date || String(stored?.order_date || "") === String(order.date),
    lineMessageId: !order.lineMessageId || String(metadata.lineMessageId || "") === String(order.lineMessageId)
  };
  return {
    ok: Object.values(checks).every(Boolean),
    orderId,
    projectRef: databaseProjectFingerprint(),
    tenantId: context.tenantId,
    date: stored?.order_date || order.date || "",
    customerId: stored?.customer_id || order.customerId || "",
    lineMessageId: metadata.lineMessageId || order.lineMessageId || "",
    reason: Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key).join(",") || "verified"
  };
}

async function persistLineOrderMutation(change = {}, settings = null) {
  const timings = await persistOrderMutation(change, settings);
  const verification = await verifyPersistedOrder(change.order || {});
  if (!verification.ok) {
    const error = new Error(`LINE order write was not verified (${verification.reason}).`);
    error.code = "LINE_ORDER_NOT_VERIFIED";
    error.verification = verification;
    throw error;
  }
  return { timings, verification };
}

async function persistOrderProfitSnapshots(orders = []) {
  if (!orders.length) return;
  const rows = orders.map(orderRowPayload);
  for (let index = 0; index < rows.length; index += 100) {
    await upsert("orders", rows.slice(index, index + 100));
  }
}

async function verifyCustomerSync() {
  const [
    customers,
    orders,
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs
  ] = await Promise.all([
    select("customers"),
    select("orders"),
    select("follow_up_rules"),
    select("settings"),
    select("tags"),
    select("customer_tags"),
    select("contact_logs")
  ]);
  const raw = fromSupabaseShape({
    users: [],
    customers,
    orders,
    line_messages: [],
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs
  });
  const projected = synchronizeCustomers(JSON.parse(JSON.stringify(raw)));
  const rawCustomerIds = new Set((raw.customers || []).map(customer => customer.id));
  const projectedCustomerIds = new Set((projected.customers || []).map(customer => customer.id));
  const orderCustomerIds = new Set((raw.orders || []).map(order => order.customerId).filter(Boolean));
  const orphanCustomerCount = [...rawCustomerIds].filter(id => !orderCustomerIds.has(id)).length;
  const missingCustomerCount = [...orderCustomerIds].filter(id => !rawCustomerIds.has(id)).length;
  const projectedOnlyCustomerCount = [...projectedCustomerIds].filter(id => !rawCustomerIds.has(id)).length;
  const staleCustomerCount = [...rawCustomerIds].filter(id => !projectedCustomerIds.has(id)).length;
  return {
    ok: orphanCustomerCount === 0 && missingCustomerCount === 0 && projectedOnlyCustomerCount === 0 && staleCustomerCount === 0,
    provider: "supabase",
    orderCount: (raw.orders || []).length,
    storedCustomerCount: (raw.customers || []).length,
    projectedCustomerCount: (projected.customers || []).length,
    orphanCustomerCount,
    missingCustomerCount,
    projectedOnlyCustomerCount,
    staleCustomerCount
  };
}

module.exports = {
  provider: "supabase",
  readDb,
  findUserForLogin,
  readUserById,
  createSignupTenantAccount,
  writeDb,
  deleteUser,
  deleteOrder,
  deleteCustomer,
  getImportJob,
  getActiveImportJob,
  getLatestImportJob,
  previewLatestImportCleanup,
  cleanupImportJob,
  saveImportJob,
  importOrdersBatch,
  persistOrderMutation,
  persistLineOrderMutation,
  claimLineMessage,
  persistLineMessageRecord,
  verifyPersistedOrder,
  lineMessageStorageId,
  databaseProjectFingerprint,
  assertProductionDatabaseTarget,
  SAFE_PRODUCTION_SUPABASE_PROJECT_REF,
  persistOrderProfitSnapshots,
  createContactLogFast,
  persistUserProfile,
  persistUserThemePreference,
  persistSettingsPatch,
  readSettingsPatch,
  readNotificationReadIds,
  persistNotificationReadIds,
  validatePromotionCode,
  quoteSignupPromotion,
  beginSubscriptionPayment,
  beginSubscriptionCheckout,
  beginSubscriptionUpgrade,
  setPaymentProviderReference,
  recordProviderPaymentSuccess,
  recordSubscriptionCheckoutSuccess,
  recordProviderPaymentStatus,
  recordSubscriptionUpgradeSuccess,
  recordSubscriptionUpgradeStatus,
  releaseCanceledPromoPayment,
  abandonPromoCheckout,
  quoteCheckoutPromotion,
  redeemZeroPaymentPromo,
  activateZeroAmountSubscriptionPayment,
  readPaymentByProviderReference,
  readPendingSubscriptionUpgrades,
  closeTerminalSubscriptionUpgradeAttempt,
  platformAdminOverview,
  platformAdminTenants,
  platformAdminTenantDetail,
  platformAdminPayments,
  platformAdminPromotionCodes,
  platformAdminUpsertPromotionCode,
  withTenantContext,
  resolveTenantForUser,
  resolveTenantForLineWebhook,
  ensureProductImageBucket,
  uploadProductImageObject,
  productImagePublicUrl,
  productImagePublicBaseUrl,
  verifyPublicProductImageUrl,
  verifyCustomerSync,
  MAX_SUPABASE_FILTER_QUERY_LENGTH,
  COMPOSITE_CONFLICTS,
  diagnoseLineWebhookTenantRejection,
  tenantPrimitives,
  assertEnv
};
