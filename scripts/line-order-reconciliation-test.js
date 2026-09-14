"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SUCCESS_REPLY_PREFIX,
  authoritativeOrderFromMessage,
  bangkokBusinessDateBounds,
  deduplicateAcks,
  messageBusinessDate,
  previousBangkokBusinessDate,
  reconciliationRequestAuthorized,
  runLineOrderReconciliation
} = require("../lib/line-order-reconciliation");

const PREVIEW_REF = "enwabsfsmwwcwwirdwok";
const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const BUSINESS_DATE = "2026-09-13";

function orderText(sequence, overrides = {}) {
  const values = {
    items: "Growup Test Product",
    orderNumber: `RECON-${sequence}`,
    date: "12/9/69",
    name: `Preview Customer ${sequence}`,
    phone: `0812345${String(sequence).padStart(3, "0")}`.slice(-10),
    address: `Preview Address ${sequence}`,
    quantity: "1",
    amount: "280",
    ...overrides
  };
  return [
    `สินค้า: ${values.items}`,
    `เลขออเดอร์: ${values.orderNumber}`,
    `วันที่ซื้อ: ${values.date}`,
    "ช่องทางการสั่งซื้อ: LINE",
    `ชื่อลูกค้า: ${values.name}`,
    `เบอร์โทร: ${values.phone}`,
    `ที่อยู่จัดส่ง: ${values.address}`,
    `จำนวน: ${values.quantity}`,
    `ยอดซื้อ: ${values.amount}`
  ].join("\n");
}

function ack(sequence, options = {}) {
  const tenantId = options.tenantId || TENANT_A;
  const eventId = options.eventId || `line-event-${sequence}`;
  const messageId = options.messageId || `line-message-${sequence}`;
  const internalOrderId = options.internalOrderId || `o_line_${String(sequence).padStart(24, "0")}`;
  const rawText = orderText(sequence, options.overrides);
  return {
    id: eventId,
    tenant_id: tenantId,
    raw_text: rawText,
    created_at: options.createdAt || "2026-09-13T06:00:00.000Z",
    raw_event: {
      timestamp: options.timestamp ?? Date.parse(options.createdAt || "2026-09-13T06:00:00.000Z"),
      message: { id: messageId, type: "text", text: rawText },
      __debug: {
        processing_status: "replied",
        reply_text: `${SUCCESS_REPLY_PREFIX}แล้ว`,
        failure_category: "",
        internal_order_id: internalOrderId,
        ...(options.synthetic ? { synthetic_test: true } : {}),
        ...(options.safe ? { reconciliation_recovery_safe: true, reconciliation_side_effect_state: "missing" } : {})
      }
    }
  };
}

function orderFor(message, overrides = {}) {
  const payload = authoritativeOrderFromMessage(message);
  return {
    id: payload.internalOrderId,
    tenant_id: message.tenant_id,
    order_number: payload.orderNumber,
    order_date: payload.date,
    customer_name: payload.name,
    phone: payload.phone,
    address: payload.address,
    items: payload.items,
    quantity: payload.quantity,
    amount: payload.amount,
    raw_text: JSON.stringify({ primary: message.raw_text, __lineMessageId: payload.lineMessageId }),
    ...overrides
  };
}

class FakeStore {
  constructor({ messages = [], tenants, orders = [], deletions = [], recoveryAudits = [], recoveryFailures = [] } = {}) {
    this.projectRef = PREVIEW_REF;
    this.messages = messages;
    this.tenants = tenants || [
      { id: TENANT_A, name: "Tenant A", status: "active" },
      { id: TENANT_B, name: "Tenant B", status: "active" }
    ];
    this.orders = orders;
    this.deletions = deletions;
    this.recoveryAudits = recoveryAudits;
    this.recoveryFailures = new Set(recoveryFailures);
    this.jobs = [];
    this.runs = [];
    this.items = [];
    this.recoveryCalls = [];
  }

  async listLineMessages(_bounds, tenantIds) {
    return this.messages.filter(row => !tenantIds.length || tenantIds.includes(String(row.tenant_id || "")));
  }
  async listActiveTenants(tenantIds) { return this.tenants.filter(row => tenantIds.includes(row.id)); }
  async listOrders(orderDates, referencedOrderIds) {
    return this.orders.filter(row => orderDates.includes(row.order_date) || referencedOrderIds.includes(row.id));
  }
  async listDeletionAudits(orderIds) { return this.deletions.filter(row => orderIds.includes(row.order_id)); }
  async listRecoveryAudits(eventIds) { return this.recoveryAudits.filter(row => eventIds.includes(row.line_event_id)); }
  async beginJob(row) { this.jobs.push({ ...row }); }
  async completeJob(id, status, tenantRunCount, counts) { Object.assign(this.jobs.find(row => row.id === id), { status, tenantRunCount, counts }); }
  async failJob(id, category) { Object.assign(this.jobs.find(row => row.id === id), { status: "failed", category }); }
  async beginRun(row) { this.runs.push({ ...row }); }
  async completeRun(id, tenantId, status, counts, items) {
    Object.assign(this.runs.find(row => row.id === id && row.tenant_id === tenantId), { status, counts });
    this.items.push(...items);
  }
  async failRun(id, tenantId, category) { Object.assign(this.runs.find(row => row.id === id && row.tenant_id === tenantId), { status: "failed", category }); }
  async recoverFromEvent(tenantId, lineEventId) {
    this.recoveryCalls.push({ tenantId, lineEventId });
    if (this.recoveryFailures.has(lineEventId)) throw Object.assign(new Error("RECOVERY_AUDIT_WRITE_FAILED"), { code: "RECOVERY_AUDIT_WRITE_FAILED" });
    const message = this.messages.find(row => row.id === lineEventId && row.tenant_id === tenantId);
    const payload = authoritativeOrderFromMessage(message);
    const existing = this.orders.find(row => row.id === payload.internalOrderId && row.tenant_id === tenantId);
    if (existing) return { ok: true, status: "already_exists", order_id: existing.id };
    this.orders.push(orderFor(message));
    this.recoveryAudits.push({ id: `recovery-${lineEventId}`, tenant_id: tenantId, line_event_id: lineEventId, original_order_id: payload.internalOrderId, status: "recovered" });
    return { ok: true, status: "recovered", order_id: payload.internalOrderId };
  }
  async getOrder(orderId) { return this.orders.filter(row => row.id === orderId); }
}

async function run(store, options = {}) {
  return runLineOrderReconciliation({
    store,
    businessDate: BUSINESS_DATE,
    expectedProjectRef: PREVIEW_REF,
    trigger: "preview_e2e",
    ...options
  });
}

async function testExactTenAndRetryDeduplication() {
  const messages = Array.from({ length: 10 }, (_, index) => ack(index + 1));
  const retry = { ...messages[0], id: "line-event-1-retry", created_at: "2026-09-13T06:00:01.000Z" };
  const store = new FakeStore({ messages: [...messages, retry], orders: messages.map(orderFor) });
  const result = await run(store);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.summary.realSuccessAckCount, 10);
  assert.strictEqual(result.summary.exactMatchCount, 10);
  assert.strictEqual(result.summary.duplicateRetryCount, 1);
  assert.strictEqual(store.items.length, 10);
  assert(store.items.every(item => item.classification === "PRESENT_EXACT"));
  const safeAudit = JSON.stringify(store.items);
  assert(!safeAudit.includes("0812345"), "audit rows must not persist phone data");
  assert(!safeAudit.includes("Preview Address"), "audit rows must not persist address data");
  assert(!safeAudit.includes("Preview Customer"), "audit rows must not persist customer names");
}

async function testSafeRecoveryAndIdempotentRerun() {
  const message = ack(20, { safe: true });
  const store = new FakeStore({ messages: [message] });
  const first = await run(store, { applyRecovery: true });
  assert.strictEqual(first.summary.recoveredCount, 1);
  assert.strictEqual(store.orders.filter(row => row.id === authoritativeOrderFromMessage(message).internalOrderId).length, 1);
  assert.strictEqual(store.recoveryCalls.length, 1);
  const second = await run(store, { applyRecovery: true });
  assert.strictEqual(second.summary.exactMatchCount, 1);
  assert.strictEqual(second.summary.recoveredCount, 0);
  assert.strictEqual(store.orders.length, 1);
  assert.strictEqual(store.recoveryCalls.length, 1);
}

async function testUnresolvedAndRecoveryFailureAreNonMutating() {
  const incomplete = ack(21, { safe: true, overrides: { phone: "" } });
  const failing = ack(22, { safe: true });
  const store = new FakeStore({ messages: [incomplete, failing], recoveryFailures: [failing.id] });
  const result = await run(store, { applyRecovery: true });
  assert.strictEqual(result.summary.unresolvedCount, 2);
  assert.strictEqual(store.orders.length, 0);
  assert.deepStrictEqual(store.recoveryCalls, [{ tenantId: TENANT_A, lineEventId: failing.id }]);
  assert(result.results[0].items.some(item => item.reason === "authoritative_payload_incomplete"));
  assert(result.results[0].items.some(item => item.reason === "RECOVERY_AUDIT_WRITE_FAILED"));
}

async function testDeletionDuplicateWrongTenantSyntheticAndIsolation() {
  const deleted = ack(30);
  const duplicate = ack(31);
  const wrongTenant = ack(32, { tenantId: TENANT_A });
  const synthetic = ack(33, { synthetic: true });
  const tenantBExact = ack(34, { tenantId: TENANT_B });
  const duplicatePrimary = orderFor(duplicate);
  const wrongTenantOrder = orderFor(wrongTenant, { tenant_id: TENANT_B });
  const store = new FakeStore({
    messages: [deleted, duplicate, wrongTenant, synthetic, tenantBExact],
    orders: [
      duplicatePrimary,
      { ...duplicatePrimary, id: "duplicate-secondary" },
      wrongTenantOrder,
      orderFor(tenantBExact)
    ],
    deletions: [{
      id: "delete-audit-30",
      tenant_id: TENANT_A,
      order_id: authoritativeOrderFromMessage(deleted).internalOrderId,
      action: "order_delete",
      deleted_at: "2026-09-13T07:00:00.000Z"
    }]
  });
  const onlyA = await run(store, { applyRecovery: true, tenantIds: [TENANT_A] });
  assert.strictEqual(onlyA.tenantRunCount, 1);
  assert.strictEqual(onlyA.summary.intentionalDeleteCount, 1);
  assert.strictEqual(onlyA.summary.duplicateCount, 1);
  assert.strictEqual(onlyA.summary.wrongTenantCount, 1);
  assert.strictEqual(onlyA.summary.realSuccessAckCount, 3);
  assert.strictEqual(store.recoveryCalls.length, 0);
  assert.strictEqual(store.orders.length, 4);
  assert.strictEqual(store.items.filter(item => item.classification === "SYNTHETIC_TEST").length, 1);
  assert(store.runs.every(row => row.tenant_id === TENANT_A));
}

async function testBangkokBoundaryAndDifferentPurchaseDate() {
  const beforeMidnight = ack(40, { createdAt: "2026-09-12T16:59:59.000Z", timestamp: Date.parse("2026-09-12T16:59:59.000Z") });
  const atMidnight = ack(41, { createdAt: "2026-09-12T17:00:00.000Z", timestamp: Date.parse("2026-09-12T17:00:00.000Z") });
  assert.strictEqual(messageBusinessDate(beforeMidnight), "2026-09-12");
  assert.strictEqual(messageBusinessDate(atMidnight), "2026-09-13");
  const store = new FakeStore({ messages: [beforeMidnight, atMidnight], orders: [orderFor(beforeMidnight), orderFor(atMidnight)] });
  const result = await runLineOrderReconciliation({ store, businessDate: "2026-09-12", expectedProjectRef: PREVIEW_REF });
  assert.strictEqual(result.summary.realSuccessAckCount, 1);
  assert.strictEqual(result.summary.exactMatchCount, 1);
  assert.deepStrictEqual(bangkokBusinessDateBounds("2026-09-13"), {
    businessDate: "2026-09-13",
    start: "2026-09-12T17:00:00.000Z",
    end: "2026-09-13T17:00:00.000Z"
  });
  assert.strictEqual(previousBangkokBusinessDate(new Date("2026-09-13T18:00:00.000Z")), "2026-09-13");
}

async function testZeroActivityAuditAndProjectGuard() {
  const store = new FakeStore();
  const result = await run(store);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.tenantRunCount, 0);
  assert.strictEqual(store.jobs.length, 1);
  assert.strictEqual(store.jobs[0].status, "passed");
  const mismatched = new FakeStore();
  await assert.rejects(
    () => runLineOrderReconciliation({ store: mismatched, businessDate: BUSINESS_DATE, expectedProjectRef: "wrong-project" }),
    error => error.code === "RECONCILIATION_PROJECT_REF_MISMATCH"
  );
  assert.strictEqual(mismatched.jobs.length, 0);
}

function testAuthorizationAndDedupAcrossTenants() {
  assert.strictEqual(reconciliationRequestAuthorized({ headers: { authorization: "Bearer cron-value" } }, { CRON_SECRET: "cron-value" }), true);
  assert.strictEqual(reconciliationRequestAuthorized({ headers: { authorization: "Bearer wrong" } }, { CRON_SECRET: "cron-value" }), false);
  assert.strictEqual(reconciliationRequestAuthorized({ headers: {} }, { CRON_SECRET: "" }), false);
  assert.strictEqual(reconciliationRequestAuthorized({ headers: { "x-line-recovery-token": "runner" } }, { LINE_RECOVERY_RUNNER_TOKEN: "runner" }), true);
  const sameMessageA = ack(50, { tenantId: TENANT_A, messageId: "shared-message" });
  const sameMessageB = ack(51, { tenantId: TENANT_B, messageId: "shared-message" });
  const deduped = deduplicateAcks([sameMessageA, sameMessageB]);
  assert.strictEqual(deduped.messages.length, 2, "different tenants must never be deduplicated together");
}

function testMigrationAndFrontendContracts() {
  const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "20260913091328_line_order_daily_reconciliation.sql"), "utf8");
  assert(migration.includes("create table if not exists public.line_order_reconciliation_jobs"));
  assert(migration.includes("line_messages_reconciliation_created_tenant_idx"));
  assert(migration.includes("create table if not exists public.line_order_reconciliation_runs"));
  assert(migration.includes("create table if not exists public.line_order_reconciliation_items"));
  assert(migration.includes("enable row level security"));
  assert(migration.includes("revoke all on table public.line_order_reconciliation_jobs from public, anon, authenticated"));
  assert(migration.includes("grant select, insert, update on table public.line_order_reconciliation_jobs to service_role"));
  assert(!/^\s*(?:update|delete|truncate|drop|alter\s+column)\s+/im.test(migration), "migration must not mutate existing business rows or drop/change columns");
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  assert.deepStrictEqual(vercel.crons, [{ path: "/api/internal/line-order-reconciliation", schedule: "0 18 * * *" }]);
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = server.slice(server.indexOf('url.pathname === "/api/internal/line-order-reconciliation"'), server.indexOf("const dbReadStartedAt", server.indexOf('url.pathname === "/api/internal/line-order-reconciliation"')));
  assert(route.includes("reconciliationRequestAuthorized(req)"), "reconciliation route must require server authorization");
  assert(route.indexOf("reconciliationRequestAuthorized(req)") < route.indexOf("readBody(req)"), "authorization must happen before reading the manual request body");
  assert(route.includes("LINE_RECONCILIATION_AUTO_RECOVERY_ENABLED"), "Production recovery must remain explicitly gated");
  assert(route.includes("KNOWN_PRODUCTION_SUPABASE_REF"), "Production endpoint must enforce the known Production database ref");
  const changed = require("child_process").execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert(!changed.split(/\r?\n/).some(file => /^(?:public\/|ui-baselines\/)/.test(file)), "frontend or Golden UI files changed");
}

(async () => {
  await testExactTenAndRetryDeduplication();
  await testSafeRecoveryAndIdempotentRerun();
  await testUnresolvedAndRecoveryFailureAreNonMutating();
  await testDeletionDuplicateWrongTenantSyntheticAndIsolation();
  await testBangkokBoundaryAndDifferentPurchaseDate();
  await testZeroActivityAuditAndProjectGuard();
  testAuthorizationAndDedupAcrossTenants();
  testMigrationAndFrontendContracts();
  console.log("LINE order reconciliation tests passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
