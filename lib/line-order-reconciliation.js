"use strict";

const crypto = require("crypto");

const SUCCESS_REPLY_PREFIX = "✅ นำเข้าออเดอร์เรียบร้อยแล้ว\nGrowup Pilot บันทึกข้อมูลเรียบร้อย";
const CLASSIFICATIONS = new Set([
  "PRESENT_EXACT",
  "RECOVERED",
  "INTENTIONAL_AUDITED_DELETE",
  "MISSING_UNRESOLVED",
  "DUPLICATE",
  "WRONG_TENANT",
  "SYNTHETIC_TEST"
]);

function safeHash(value) {
  const normalized = String(value || "");
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16) : "";
}

function safeErrorCategory(error) {
  const value = String(error?.code || error?.message || "RECONCILIATION_FAILED").toUpperCase();
  const known = value.match(/(?:RECONCILIATION|RECOVERY|DATABASE|SUPABASE)_[A-Z0-9_]+/);
  return (known?.[0] || "RECONCILIATION_FAILED").slice(0, 120);
}

function projectRefFromUrl(value = "") {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.endsWith(".supabase.co") ? host.split(".")[0] : host;
  } catch {
    return "";
  }
}

function parseBusinessDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw Object.assign(new Error("RECONCILIATION_DATE_INVALID"), { code: "RECONCILIATION_DATE_INVALID" });
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw Object.assign(new Error("RECONCILIATION_DATE_INVALID"), { code: "RECONCILIATION_DATE_INVALID" });
  }
  return text;
}

function bangkokDateAt(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function previousBangkokBusinessDate(instant = new Date()) {
  const current = parseBusinessDate(bangkokDateAt(instant));
  const date = new Date(`${current}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function bangkokBusinessDateBounds(value) {
  const businessDate = parseBusinessDate(value);
  const localMidnightAsUtc = new Date(`${businessDate}T00:00:00.000Z`);
  const start = new Date(localMidnightAsUtc.getTime() - 7 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { businessDate, start: start.toISOString(), end: end.toISOString() };
}

function debugFor(message = {}) {
  return message.raw_event?.__debug || message.rawEvent?.__debug || {};
}

function eventObject(message = {}) {
  return message.raw_event || message.rawEvent || {};
}

function eventMessageId(message = {}) {
  const event = eventObject(message);
  return String(event.message?.id || event.message?.messageId || "").trim();
}

function eventText(message = {}) {
  const event = eventObject(message);
  return String(message.raw_text || message.text || event.message?.text || "");
}

function eventOccurredAt(message = {}) {
  const event = eventObject(message);
  const sourceTimestamp = Number(event.timestamp);
  if (Number.isFinite(sourceTimestamp) && sourceTimestamp > 0) return new Date(sourceTimestamp);
  return new Date(message.created_at || message.receivedAt || 0);
}

function messageBusinessDate(message = {}) {
  const occurredAt = eventOccurredAt(message);
  return Number.isFinite(occurredAt.getTime()) ? bangkokDateAt(occurredAt) : "";
}

function isRealSuccessAck(message = {}) {
  const debug = debugFor(message);
  return String(debug.processing_status || "").trim().toLowerCase() === "replied"
    && !String(debug.failure_category || "").trim()
    && String(debug.reply_text || "").startsWith(SUCCESS_REPLY_PREFIX);
}

function isConclusiveSynthetic(message = {}) {
  const debug = debugFor(message);
  return debug.synthetic_test === true || debug.test_fixture === true;
}

function labelValue(text, labels) {
  const pattern = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return String(text || "").match(new RegExp(`^\\s*(?:${pattern})\\s*[:：]\\s*([^\\r\\n]*)`, "im"))?.[1]?.trim() || "";
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function parseAmount(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = text.replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseQuantity(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isInteger(number) ? number : null;
}

function normalizeOrderDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    try { return parseBusinessDate(text); } catch { return ""; }
  }
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return "";
  let year = Number(match[3]);
  if (year < 100) year = year >= 50 ? year + 1957 : year + 2000;
  else if (year > 2400) year -= 543;
  const iso = `${year}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  try { return parseBusinessDate(iso); } catch { return ""; }
}

function authoritativeOrderFromMessage(message = {}) {
  const text = eventText(message);
  const parsed = {
    items: labelValue(text, ["สินค้า", "product"]),
    orderNumber: labelValue(text, ["เลขออเดอร์", "order_number", "order number"]),
    date: normalizeOrderDate(labelValue(text, ["วันที่ซื้อ", "order_date", "order date"])),
    name: labelValue(text, ["ชื่อลูกค้า", "ชื่อ", "customer_name", "customer name"]),
    phone: normalizePhone(labelValue(text, ["เบอร์โทร", "โทร", "phone"])),
    address: labelValue(text, ["ที่อยู่จัดส่ง", "ที่อยู่", "shipping_address", "shipping address"]),
    quantity: parseQuantity(labelValue(text, ["จำนวนกระปุก", "จำนวน", "quantity"])),
    amount: parseAmount(labelValue(text, ["ยอดซื้อ", "ยอดรวม", "total_amount", "total amount"])),
    lineMessageId: eventMessageId(message),
    internalOrderId: String(debugFor(message).internal_order_id || "").trim()
  };
  parsed.complete = Boolean(
    parsed.items && parsed.orderNumber && parsed.date && parsed.name
    && parsed.phone.length >= 9 && parsed.address
    && Number.isInteger(parsed.quantity) && parsed.quantity > 0
    && Number.isFinite(parsed.amount) && parsed.amount >= 0
  );
  parsed.fingerprint = parsed.complete ? orderFingerprint(parsed) : "";
  return parsed;
}

function orderMetadata(rawText = "") {
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const nested = parsed.primary || parsed.merged;
    const inherited = nested ? orderMetadata(typeof nested === "string" ? nested : JSON.stringify(nested)) : {};
    return {
      lineMessageId: String(parsed.__lineMessageId || inherited.lineMessageId || "").trim(),
      duplicateFingerprint: String(parsed.__duplicateFingerprint || inherited.duplicateFingerprint || "").trim()
    };
  } catch {
    return {};
  }
}

function orderFingerprint(order = {}) {
  return safeHash(JSON.stringify({
    orderNumber: normalizeText(order.orderNumber ?? order.order_number),
    date: normalizeOrderDate(order.date ?? order.order_date),
    items: normalizeText(order.items),
    name: normalizeText(order.name ?? order.customer_name),
    phone: normalizePhone(order.phone),
    address: normalizeText(order.address),
    quantity: Number(order.quantity ?? order.jars),
    amount: Number(order.amount)
  }));
}

function orderMatchesPayload(order, payload) {
  if (!payload.complete) return true;
  const payloadItem = normalizeText(payload.items);
  const orderItem = normalizeText(order.items);
  const productMatches = payloadItem === orderItem
    || (payloadItem && orderItem && (payloadItem.includes(orderItem) || orderItem.includes(payloadItem)));
  return normalizeText(order.order_number) === normalizeText(payload.orderNumber)
    && normalizeOrderDate(order.order_date) === payload.date
    && productMatches
    && normalizeText(order.customer_name) === normalizeText(payload.name)
    && normalizePhone(order.phone) === payload.phone
    && normalizeText(order.address) === normalizeText(payload.address)
    && Number(order.quantity) === Number(payload.quantity)
    && Number(order.amount) === Number(payload.amount);
}

function uniqueRows(rows = []) {
  const seen = new Map();
  for (const row of rows) seen.set(`${row.tenant_id || ""}:${row.id || ""}`, row);
  return [...seen.values()];
}

function orderCandidates(payload, orders, recoveryAudit) {
  const scored = new Map();
  function add(row, score, reason) {
    const key = `${row.tenant_id || ""}:${row.id || ""}`;
    const current = scored.get(key);
    if (!current || score < current.score) scored.set(key, { row, score, reason });
  }
  for (const order of orders) {
    const metadata = orderMetadata(order.raw_text || "");
    if (payload.internalOrderId && String(order.id) === payload.internalOrderId) add(order, 1, "internal_order_id");
    if (payload.lineMessageId && metadata.lineMessageId === payload.lineMessageId) add(order, 2, "line_message_id");
    if (recoveryAudit?.original_order_id && String(order.id) === String(recoveryAudit.original_order_id)) add(order, 4, "recovery_audit");
    if (payload.orderNumber && payload.date
      && normalizeText(order.order_number) === normalizeText(payload.orderNumber)
      && normalizeOrderDate(order.order_date) === payload.date) add(order, 5, "order_number_date");
    if (payload.fingerprint && orderFingerprint(order) === payload.fingerprint) add(order, 6, "payload_fingerprint");
  }
  return [...scored.values()].sort((a, b) => a.score - b.score);
}

function deletionFor(message, payload, deletions = []) {
  const eventAt = Date.parse(message.created_at || message.receivedAt || 0);
  return deletions
    .filter(row => String(row.tenant_id || "") === String(message.tenant_id || ""))
    .filter(row => !payload.internalOrderId || String(row.order_id || "") === payload.internalOrderId)
    .filter(row => String(row.action || "order_delete") === "order_delete")
    .filter(row => !Number.isFinite(eventAt) || Date.parse(row.deleted_at || 0) >= eventAt)
    .sort((a, b) => String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")))[0] || null;
}

function recoverySafety(message, payload, candidates, deletion) {
  const debug = debugFor(message);
  const explicitSideEffectProof = debug.reconciliation_recovery_safe === true
    && String(debug.reconciliation_side_effect_state || "") === "missing";
  return Boolean(
    payload.complete
    && payload.internalOrderId
    && payload.lineMessageId
    && candidates.length === 0
    && !deletion
    && explicitSideEffectProof
  );
}

function classifyMessage(message, context) {
  const tenantId = String(message.tenant_id || "");
  const payload = authoritativeOrderFromMessage(message);
  const recoveryAudit = context.recoveryAudits.find(row => String(row.tenant_id || "") === tenantId && String(row.line_event_id || "") === String(message.id || ""));
  const candidates = orderCandidates(payload, context.orders, recoveryAudit);
  const sameTenant = candidates.filter(candidate => String(candidate.row.tenant_id || "") === tenantId);
  const wrongTenant = candidates.filter(candidate => String(candidate.row.tenant_id || "") !== tenantId);
  const deletion = deletionFor(message, payload, context.deletions);
  const base = {
    message,
    payload,
    initiallyMissing: sameTenant.length === 0,
    matchedOrderId: sameTenant[0]?.row?.id || "",
    recoveryAuditId: recoveryAudit?.id || "",
    safeToRecover: false,
    reason: ""
  };
  if (isConclusiveSynthetic(message)) return { ...base, classification: "SYNTHETIC_TEST", reason: "explicit_test_marker" };
  if (wrongTenant.some(candidate => candidate.score <= 2)) {
    return { ...base, classification: "WRONG_TENANT", reason: wrongTenant[0].reason };
  }
  if (sameTenant.length > 1) return { ...base, classification: "DUPLICATE", reason: sameTenant.map(item => item.reason).join(",") };
  if (sameTenant.length === 1) {
    if (!orderMatchesPayload(sameTenant[0].row, payload)) {
      return { ...base, classification: "MISSING_UNRESOLVED", reason: "matched_identity_payload_mismatch" };
    }
    return { ...base, classification: "PRESENT_EXACT", reason: sameTenant[0].reason };
  }
  if (wrongTenant.length) return { ...base, classification: "WRONG_TENANT", reason: wrongTenant[0].reason };
  if (deletion) return { ...base, classification: "INTENTIONAL_AUDITED_DELETE", reason: "audited_order_delete" };
  const safeToRecover = recoverySafety(message, payload, candidates, deletion);
  return {
    ...base,
    classification: "MISSING_UNRESOLVED",
    reason: safeToRecover ? "safe_to_recover" : (payload.complete ? "side_effect_safety_not_proven" : "authoritative_payload_incomplete"),
    safeToRecover
  };
}

function deduplicateAcks(messages = []) {
  const unique = new Map();
  let duplicateRetries = 0;
  const duplicateRetriesByTenant = new Map();
  for (const message of messages.filter(isRealSuccessAck).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))) {
    const messageId = eventMessageId(message);
    const tenantId = String(message.tenant_id || "");
    const key = messageId ? `tenant:${tenantId}:message:${messageId}` : `tenant:${tenantId}:event:${message.id || ""}`;
    if (unique.has(key)) {
      duplicateRetries += 1;
      duplicateRetriesByTenant.set(tenantId, (duplicateRetriesByTenant.get(tenantId) || 0) + 1);
    }
    else unique.set(key, message);
  }
  return { messages: [...unique.values()], duplicateRetries, duplicateRetriesByTenant };
}

function countsFor(items, duplicateRetryCount = 0) {
  const count = classification => items.filter(item => item.classification === classification).length;
  return {
    realSuccessAckCount: items.filter(item => item.classification !== "SYNTHETIC_TEST").length,
    exactMatchCount: count("PRESENT_EXACT"),
    initialMissingCount: items.filter(item => item.initiallyMissing && item.classification !== "SYNTHETIC_TEST").length,
    recoveredCount: count("RECOVERED"),
    duplicateCount: count("DUPLICATE"),
    wrongTenantCount: count("WRONG_TENANT"),
    intentionalDeleteCount: count("INTENTIONAL_AUDITED_DELETE"),
    unresolvedCount: count("MISSING_UNRESOLVED"),
    duplicateRetryCount
  };
}

function auditItem(runId, businessDate, item) {
  const payload = item.payload;
  const details = {
    identity_method: item.reason || "",
    safe_to_recover: item.safeToRecover === true
  };
  return {
    id: crypto.randomUUID(),
    run_id: runId,
    tenant_id: String(item.message.tenant_id || ""),
    business_date: businessDate,
    line_event_id: String(item.message.id || ""),
    line_message_id_hash: safeHash(payload.lineMessageId),
    internal_order_id_hash: safeHash(payload.internalOrderId),
    order_number: String(payload.orderNumber || "").slice(0, 160),
    source_fingerprint: payload.fingerprint || "",
    classification: item.classification,
    reason: String(item.reason || "").slice(0, 160),
    matched_order_id_hash: safeHash(item.matchedOrderId),
    recovery_audit_id: item.recoveryAuditId || null,
    details
  };
}

class SupabaseReconciliationStore {
  constructor(options = {}) {
    this.origin = new URL(options.supabaseUrl || process.env.SUPABASE_URL).origin;
    this.key = String(options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || "");
    this.projectRef = projectRefFromUrl(this.origin);
    if (!this.key) throw Object.assign(new Error("RECONCILIATION_SUPABASE_CREDENTIALS_MISSING"), { code: "RECONCILIATION_SUPABASE_CREDENTIALS_MISSING" });
    this.headers = { apikey: this.key, Authorization: `Bearer ${this.key}`, "content-type": "application/json" };
  }

  async request(pathname, options = {}) {
    const response = await fetch(`${this.origin}/rest/v1/${pathname}`, { ...options, headers: { ...this.headers, ...(options.headers || {}) } });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const error = new Error(`RECONCILIATION_DATABASE_REQUEST_FAILED_${response.status}`);
      error.code = "RECONCILIATION_DATABASE_REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async all(table, params = new URLSearchParams()) {
    const rows = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const query = new URLSearchParams(params);
      query.set("limit", String(pageSize));
      query.set("offset", String(offset));
      const page = await this.request(`${table}?${query}`);
      rows.push(...(Array.isArray(page) ? page : []));
      if (!Array.isArray(page) || page.length < pageSize) return rows;
    }
  }

  async listLineMessages(bounds, tenantIds = []) {
    const params = new URLSearchParams({ select: "id,tenant_id,raw_text,raw_event,created_at", order: "created_at.asc" });
    const paddedStart = new Date(Date.parse(bounds.start) - 24 * 60 * 60 * 1000).toISOString();
    const paddedEnd = new Date(Date.parse(bounds.end) + 24 * 60 * 60 * 1000).toISOString();
    params.append("created_at", `gte.${paddedStart}`);
    params.append("created_at", `lt.${paddedEnd}`);
    if (tenantIds.length) params.set("tenant_id", `in.(${tenantIds.join(",")})`);
    return this.all("line_messages", params);
  }

  async listActiveTenants(tenantIds = []) {
    if (!tenantIds.length) return [];
    const params = new URLSearchParams({ select: "id,name,status", id: `in.(${tenantIds.join(",")})` });
    return this.all("tenants", params);
  }

  async listOrders(orderDates = [], referencedOrderIds = []) {
    const dates = [...new Set(orderDates.filter(Boolean))];
    const rows = [];
    if (dates.length) {
      const dateParams = new URLSearchParams({
        select: "id,tenant_id,order_number,order_date,customer_name,phone,address,items,quantity,amount,raw_text",
        order_date: dates.length === 1 ? `eq.${dates[0]}` : `in.(${dates.join(",")})`
      });
      rows.push(...await this.all("orders", dateParams));
    }
    for (let index = 0; index < referencedOrderIds.length; index += 100) {
      const ids = referencedOrderIds.slice(index, index + 100).map(value => `\"${String(value).replace(/\"/g, "") }\"`);
      if (!ids.length) continue;
      const params = new URLSearchParams({
        select: "id,tenant_id,order_number,order_date,customer_name,phone,address,items,quantity,amount,raw_text",
        id: `in.(${ids.join(",")})`
      });
      rows.push(...await this.all("orders", params));
    }
    return uniqueRows(rows);
  }

  async listDeletionAudits(orderIds = []) {
    if (!orderIds.length) return [];
    const rows = [];
    for (let index = 0; index < orderIds.length; index += 100) {
      const ids = orderIds.slice(index, index + 100).map(value => `\"${String(value).replace(/\"/g, "")}\"`);
      const params = new URLSearchParams({ select: "id,tenant_id,order_id,action,deleted_at", order_id: `in.(${ids.join(",")})` });
      rows.push(...await this.all("order_deletion_audit", params));
    }
    return rows;
  }

  async listRecoveryAudits(eventIds = []) {
    if (!eventIds.length) return [];
    const rows = [];
    for (let index = 0; index < eventIds.length; index += 100) {
      const ids = eventIds.slice(index, index + 100).map(value => `\"${String(value).replace(/\"/g, "")}\"`);
      const params = new URLSearchParams({ select: "id,tenant_id,line_event_id,original_order_id,status", line_event_id: `in.(${ids.join(",")})` });
      rows.push(...await this.all("line_order_recovery_audit", params));
    }
    return rows;
  }

  async beginRun(row) {
    const rows = await this.request("line_order_reconciliation_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([row])
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw Object.assign(new Error("RECONCILIATION_RUN_START_FAILED"), { code: "RECONCILIATION_RUN_START_FAILED" });
  }

  async beginJob(row) {
    const rows = await this.request("line_order_reconciliation_jobs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([row])
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw Object.assign(new Error("RECONCILIATION_JOB_START_FAILED"), { code: "RECONCILIATION_JOB_START_FAILED" });
  }

  async completeJob(jobId, status, tenantRunCount, counts) {
    const rows = await this.request(`line_order_reconciliation_jobs?id=eq.${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status,
        completed_at: new Date().toISOString(),
        tenant_run_count: tenantRunCount,
        real_success_ack_count: counts.realSuccessAckCount,
        exact_match_count: counts.exactMatchCount,
        initial_missing_count: counts.initialMissingCount,
        recovered_count: counts.recoveredCount,
        duplicate_count: counts.duplicateCount,
        wrong_tenant_count: counts.wrongTenantCount,
        intentional_delete_count: counts.intentionalDeleteCount,
        unresolved_count: counts.unresolvedCount,
        duplicate_retry_count: counts.duplicateRetryCount,
        updated_at: new Date().toISOString()
      })
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw Object.assign(new Error("RECONCILIATION_JOB_COMPLETE_FAILED"), { code: "RECONCILIATION_JOB_COMPLETE_FAILED" });
  }

  async failJob(jobId, category) {
    await this.request(`line_order_reconciliation_jobs?id=eq.${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), error_category: category, updated_at: new Date().toISOString() })
    });
  }

  async completeRun(runId, tenantId, status, counts, items) {
    if (items.length) {
      await this.request("line_order_reconciliation_items", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(items)
      });
    }
    const rows = await this.request(`line_order_reconciliation_runs?id=eq.${encodeURIComponent(runId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status,
        completed_at: new Date().toISOString(),
        real_success_ack_count: counts.realSuccessAckCount,
        exact_match_count: counts.exactMatchCount,
        initial_missing_count: counts.initialMissingCount,
        recovered_count: counts.recoveredCount,
        duplicate_count: counts.duplicateCount,
        wrong_tenant_count: counts.wrongTenantCount,
        intentional_delete_count: counts.intentionalDeleteCount,
        unresolved_count: counts.unresolvedCount,
        duplicate_retry_count: counts.duplicateRetryCount,
        updated_at: new Date().toISOString()
      })
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw Object.assign(new Error("RECONCILIATION_RUN_COMPLETE_FAILED"), { code: "RECONCILIATION_RUN_COMPLETE_FAILED" });
  }

  async failRun(runId, tenantId, category) {
    await this.request(`line_order_reconciliation_runs?id=eq.${encodeURIComponent(runId)}&tenant_id=eq.${encodeURIComponent(tenantId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "failed", completed_at: new Date().toISOString(), error_category: category, updated_at: new Date().toISOString() })
    });
  }

  async recoverFromEvent(tenantId, lineEventId) {
    const result = await this.request("rpc/recover_historical_line_order_from_event", {
      method: "POST",
      body: JSON.stringify({ p_tenant_id: tenantId, p_line_event_id: lineEventId })
    });
    return typeof result === "string" ? JSON.parse(result) : result;
  }

  async getOrder(orderId) {
    const params = new URLSearchParams({
      select: "id,tenant_id,order_number,order_date,customer_name,phone,address,items,quantity,amount,raw_text",
      id: `eq.${orderId}`,
      limit: "2"
    });
    const rows = await this.request(`orders?${params}`);
    return Array.isArray(rows) ? rows : [];
  }
}

async function runLineOrderReconciliation(options = {}) {
  const store = options.store || new SupabaseReconciliationStore(options);
  const businessDate = parseBusinessDate(options.businessDate || previousBangkokBusinessDate(options.now || new Date()));
  const bounds = bangkokBusinessDateBounds(businessDate);
  const expectedProjectRef = String(options.expectedProjectRef || "").trim();
  if (expectedProjectRef && store.projectRef !== expectedProjectRef) {
    throw Object.assign(new Error("RECONCILIATION_PROJECT_REF_MISMATCH"), { code: "RECONCILIATION_PROJECT_REF_MISMATCH" });
  }
  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const trigger = options.trigger || "manual";
  const mode = options.applyRecovery ? "apply" : "dry_run";
  await store.beginJob({
    id: jobId,
    business_date: businessDate,
    trigger,
    mode,
    status: "running",
    started_at: startedAt,
    created_at: startedAt,
    updated_at: startedAt
  });
  try {
  const tenantFilter = [...new Set((options.tenantIds || []).map(String).filter(Boolean))];
  const sourceMessages = (await store.listLineMessages(bounds, tenantFilter))
    .filter(message => messageBusinessDate(message) === businessDate);
  const successMessages = sourceMessages.filter(isRealSuccessAck);
  if (successMessages.some(message => !String(message.tenant_id || "").trim())) {
    throw Object.assign(new Error("RECONCILIATION_TENANT_REQUIRED"), { code: "RECONCILIATION_TENANT_REQUIRED" });
  }
  const deduped = deduplicateAcks(successMessages);
  const tenantIds = [...new Set(deduped.messages.map(row => String(row.tenant_id || "")).filter(Boolean))];
  const tenants = await store.listActiveTenants(tenantIds);
  if (tenants.length !== tenantIds.length) {
    throw Object.assign(new Error("RECONCILIATION_TENANT_NOT_FOUND"), { code: "RECONCILIATION_TENANT_NOT_FOUND" });
  }
  const activeTenantIds = new Set(tenants.map(row => String(row.id)));
  const messages = deduped.messages.filter(row => activeTenantIds.has(String(row.tenant_id || "")));
  const payloads = messages.map(authoritativeOrderFromMessage);
  const referencedOrderIds = [...new Set(payloads.map(row => row.internalOrderId).filter(Boolean))];
  const orderDates = [...new Set(payloads.map(row => row.date).filter(Boolean))];
  const [orders, deletions, recoveryAudits] = await Promise.all([
    store.listOrders(orderDates, referencedOrderIds),
    store.listDeletionAudits(referencedOrderIds),
    store.listRecoveryAudits(messages.map(row => String(row.id || "")).filter(Boolean))
  ]);
  const results = [];
  for (const tenant of tenants) {
    const tenantId = String(tenant.id || "");
    const tenantMessages = messages.filter(row => String(row.tenant_id || "") === tenantId);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await store.beginRun({
      id: runId,
      job_id: jobId,
      tenant_id: tenantId,
      business_date: businessDate,
      trigger,
      mode,
      status: "running",
      started_at: startedAt,
      created_at: startedAt,
      updated_at: startedAt
    });
    try {
      const context = { orders, deletions, recoveryAudits };
      const items = tenantMessages.map(message => classifyMessage(message, context));
      if (options.applyRecovery) {
        for (const item of items.filter(row => row.classification === "MISSING_UNRESOLVED" && row.safeToRecover)) {
          try {
            const recovered = await store.recoverFromEvent(tenantId, String(item.message.id || ""));
            const recoveredOrderId = String(recovered?.order_id || item.payload.internalOrderId || "");
            const storedOrders = recoveredOrderId ? await store.getOrder(recoveredOrderId) : [];
            const exact = storedOrders.find(order => String(order.tenant_id || "") === tenantId && orderMatchesPayload(order, item.payload));
            if (!exact || !["recovered", "already_recovered", "already_exists"].includes(String(recovered?.status || ""))) {
              throw Object.assign(new Error("RECONCILIATION_RECOVERY_READBACK_FAILED"), { code: "RECONCILIATION_RECOVERY_READBACK_FAILED" });
            }
            item.classification = "RECOVERED";
            item.reason = String(recovered.status || "recovered");
            item.matchedOrderId = exact.id;
          } catch (error) {
            item.classification = "MISSING_UNRESOLVED";
            item.reason = safeErrorCategory(error);
            item.safeToRecover = false;
          }
        }
      }
      for (const item of items) {
        if (!CLASSIFICATIONS.has(item.classification)) throw Object.assign(new Error("RECONCILIATION_UNCLASSIFIED_EVENT"), { code: "RECONCILIATION_UNCLASSIFIED_EVENT" });
      }
      const tenantDuplicateRetries = deduped.duplicateRetriesByTenant.get(tenantId) || 0;
      const counts = countsFor(items, tenantDuplicateRetries);
      const attention = counts.unresolvedCount > 0 || counts.duplicateCount > 0 || counts.wrongTenantCount > 0;
      const status = attention ? "attention_required" : "passed";
      await store.completeRun(runId, tenantId, status, counts, items.map(item => auditItem(runId, businessDate, item)));
      if (attention) {
        console.error("LINE_ORDER_RECONCILIATION_ALERT", JSON.stringify({
          runId,
          tenantIdHash: safeHash(tenantId),
          businessDate,
          unresolved: counts.unresolvedCount,
          duplicates: counts.duplicateCount,
          wrongTenant: counts.wrongTenantCount,
          references: items.filter(item => ["MISSING_UNRESOLVED", "DUPLICATE", "WRONG_TENANT"].includes(item.classification)).map(item => ({
            event: safeHash(item.message.id),
            orderNumber: item.payload.orderNumber,
            type: item.classification
          }))
        }));
      }
      results.push({ runId, tenantIdHash: safeHash(tenantId), status, counts, items: items.map(item => ({
        event: safeHash(item.message.id),
        orderNumber: item.payload.orderNumber,
        classification: item.classification,
        reason: item.reason
      })) });
    } catch (error) {
      const category = safeErrorCategory(error);
      await store.failRun(runId, tenantId, category).catch(() => {});
      console.error("LINE_ORDER_RECONCILIATION_FAILED", JSON.stringify({ runId, tenantIdHash: safeHash(tenantId), businessDate, category }));
      results.push({ runId, tenantIdHash: safeHash(tenantId), status: "failed", category, counts: countsFor([]) });
    }
  }
  const summary = results.reduce((total, result) => {
    for (const [key, value] of Object.entries(result.counts || {})) total[key] = (total[key] || 0) + Number(value || 0);
    return total;
  }, countsFor([]));
  const attentionRequired = results.some(row => row.status !== "passed");
  const finalStatus = attentionRequired ? "attention_required" : "passed";
  await store.completeJob(jobId, finalStatus, results.length, summary);
  return {
    ok: !attentionRequired,
    jobId,
    projectRef: store.projectRef,
    businessDate,
    bangkokBounds: bounds,
    mode: options.applyRecovery ? "apply" : "dry_run",
    tenantRunCount: results.length,
    summary,
    results,
    attentionRequired
  };
  } catch (error) {
    const category = safeErrorCategory(error);
    await store.failJob(jobId, category).catch(() => {});
    console.error("LINE_ORDER_RECONCILIATION_JOB_FAILED", JSON.stringify({ jobId, businessDate, category }));
    throw error;
  }
}

function secureTokenMatches(provided, configured) {
  const left = Buffer.from(String(provided || ""));
  const right = Buffer.from(String(configured || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reconciliationRequestAuthorized(req, env = process.env) {
  const authorization = String(req?.headers?.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const configuredCron = String(env.CRON_SECRET || env.LINE_RECONCILIATION_CRON_SECRET || "");
  const recoveryHeader = String(req?.headers?.["x-line-recovery-token"] || "");
  const configuredRecovery = String(env.LINE_RECOVERY_RUNNER_TOKEN || "");
  return secureTokenMatches(bearer, configuredCron) || secureTokenMatches(recoveryHeader, configuredRecovery);
}

module.exports = {
  SUCCESS_REPLY_PREFIX,
  SupabaseReconciliationStore,
  authoritativeOrderFromMessage,
  bangkokBusinessDateBounds,
  classifyMessage,
  deduplicateAcks,
  messageBusinessDate,
  isRealSuccessAck,
  previousBangkokBusinessDate,
  projectRefFromUrl,
  reconciliationRequestAuthorized,
  runLineOrderReconciliation,
  safeHash
};
