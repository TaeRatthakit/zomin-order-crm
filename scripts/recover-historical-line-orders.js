/*
 * One-shot recovery. Defaults to dry-run.  It never sends LINE replies.
 * Apply only after the same candidate set has passed Preview verification.
 */
const crypto = require('crypto');
require('../lib/env').loadEnv();
const db = require('../lib/db/supabase-adapter');
const app = require('../server');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const origin = new URL(process.env.SUPABASE_URL).origin;
const projectRef = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
const safeHash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
const get = async (table, query) => {
  const response = await fetch(`${origin}/rest/v1/${table}?${query}`, { headers });
  if (!response.ok) throw new Error(`${table} read failed: ${response.status}`);
  return response.json();
};
function debug(message) { return message?.rawEvent?.__debug || message?.raw_event?.__debug || {}; }
function messageId(message) { const event = message?.rawEvent || message?.raw_event || {}; return String(event?.message?.id || event?.message?.messageId || '').trim(); }
function isSuccessAck(message) {
  const state = String(debug(message).processing_status || '').toLowerCase();
  const reply = String(debug(message).reply_text || '');
  return state === 'replied' && !String(debug(message).failure_category || '') && reply.startsWith('✅ นำเข้าออเดอร์เรียบร้อยแล้ว');
}
function complete(order) {
  return ['items', 'name', 'phone', 'address', 'orderNumber', 'date'].every(key => String(order[key] || '').trim())
    && Number.isFinite(Number(order.jars)) && Number(order.jars) > 0
    && Number.isFinite(Number(order.amount)) && Number(order.amount) >= 0;
}
function hasExplicitOrderDate(message) {
  return /(?:วันที่ซื้อ|order[_ ]?date)\s*[:：]\s*[0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}/im.test(String(message?.text || message?.raw_text || ''));
}
function eventSnapshot(message, parsed) {
  return { line_event_id: String(message.id || ''), line_message_id: messageId(message), original_order_id: String(debug(message).internal_order_id || ''), raw_text: String(message.text || message.raw_text || ''), parsed_order: parsed };
}
function safeFailureCategory(error) {
  const value = String(error?.detail || error?.message || 'RECOVERY_FAILED');
  const known = value.match(/RECOVERY_[A-Z_]+/);
  if (known) return known[0];
  const databaseCode = value.match(/"code"\s*:\s*"([A-Z0-9]+)"/i);
  if (databaseCode) return `DATABASE_${databaseCode[1].toUpperCase()}`;
  const errorCode = String(error?.code || '').replace(/[^A-Z0-9_]/gi, '').toUpperCase();
  if (errorCode) return errorCode;
  const errorName = String(error?.name || '').replace(/[^A-Z0-9_]/gi, '').toUpperCase();
  return errorName ? `RUNTIME_${errorName}` : 'RECOVERY_FAILED';
}
async function runTenant(tenant, options) {
  return db.withTenantContext({ tenantId: tenant.id, tenantName: tenant.name || '', tenantRole: 'Owner', userId: '' }, async () => {
    const state = await db.readDb();
    const seen = new Set();
    const candidates = [];
    for (const message of state.lineMessages || []) {
      if (!isSuccessAck(message)) continue;
      if (options.apply && !options.allowedEventIds.has(String(message.id || ''))) continue;
      const originalOrderId = String(debug(message).internal_order_id || '');
      if (!originalOrderId || state.orders.some(order => String(order.id) === originalOrderId)) continue;
      const parsed = app.normalizedOrderForStorage({ ...(await app.parseOrderWithAI(String(message.text || message.raw_text || ''), state.settings || {})), lineMessageId: messageId(message), id: originalOrderId });
      if (!hasExplicitOrderDate(message) || !complete(parsed)) continue;
      const key = `${parsed.orderNumber}|${parsed.date}`;
      if (seen.has(key) || state.orders.some(order => String(order.orderNumber || '') === parsed.orderNumber)) continue;
      seen.add(key);
      candidates.push({ message, parsed, originalOrderId });
    }
    const results = [];
    for (const candidate of candidates) {
      const snapshot = eventSnapshot(candidate.message, candidate.parsed);
      if (!options.apply) { results.push({ event: safeHash(snapshot.line_event_id), order: candidate.parsed.orderNumber, status: 'dry_run' }); continue; }
      const current = await db.readDb();
      try {
        const productRows = await get('settings', `select=value,updated_at&tenant_id=eq.${encodeURIComponent(tenant.id)}&key=eq.products&limit=1`);
        const productsBefore = productRows[0]?.value ?? null;
        const productsUpdatedAt = productRows[0]?.updated_at || null;
        const order = app.addOrder(current, { ...candidate.parsed, id: candidate.originalOrderId, rawText: snapshot.raw_text, allowProductContainsMatch: true });
        const productsAfter = app.adjustInventoryForOrderChange(current, null, order);
        const mutation = app.orderMutationPayload(current, { orderId: order.id, selectedDate: order.date });
        const customer = mutation.customers.find(item => item.id === order.customerId);
        if (!customer) throw Object.assign(new Error('RECOVERY_CUSTOMER_SNAPSHOT_MISSING'), { code: 'RECOVERY_CUSTOMER_SNAPSHOT_MISSING' });
        const customerRows = await get('customers', `select=updated_at&tenant_id=eq.${encodeURIComponent(tenant.id)}&id=eq.${encodeURIComponent(customer.id)}&limit=1`);
        const persisted = await db.persistHistoricalLineRecovery({
          tenantId: tenant.id,
          lineEventId: snapshot.line_event_id,
          lineMessageId: snapshot.line_message_id,
          originalOrderId: candidate.originalOrderId,
          customer,
          order,
          productsBefore: productsAfter ? productsBefore : null,
          productsAfter: productsAfter ? current.settings.products : null,
          productsUpdatedAt: productsAfter ? productsUpdatedAt : null,
          customerUpdatedAt: customerRows[0]?.updated_at || null,
          sourceSnapshot: snapshot
        });
        const verification = persisted.status === 'recovered' || persisted.status === 'already_recovered'
          ? await db.verifyPersistedOrder(order)
          : { ok: true };
        if (!verification.ok) throw Object.assign(new Error('RECOVERY_READBACK_FAILED'), { code: 'RECOVERY_READBACK_FAILED' });
        results.push({ event: safeHash(snapshot.line_event_id), order: candidate.parsed.orderNumber, status: persisted.status });
      } catch (error) {
        results.push({ event: safeHash(snapshot.line_event_id), order: candidate.parsed.orderNumber, status: 'failed', category: safeFailureCategory(error) });
      }
    }
    return results;
  });
}
async function runRecovery(options = {}) {
  const apply = Boolean(options.apply);
  const allowedEventIds = options.allowedEventIds instanceof Set
    ? options.allowedEventIds
    : new Set(Array.isArray(options.allowedEventIds) ? options.allowedEventIds.map(String) : []);
  if (apply && !allowedEventIds.size) throw new Error('Explicit recovery event allowlist is required.');
  if (options.expectedProjectRef && projectRef !== options.expectedProjectRef) throw new Error('RECOVERY_PROJECT_REF_MISMATCH');
  const tenants = await get('tenants', 'select=id,name,status');
  const eventTenantQuery = apply
    ? `select=tenant_id&id=in.(${[...allowedEventIds].map(encodeURIComponent).join(',')})`
    : 'select=tenant_id';
  const eventTenants = await get('line_messages', eventTenantQuery);
  const targetTenantIds = new Set(eventTenants.map(row => String(row.tenant_id || '')).filter(Boolean));
  const results = [];
  const runOptions = { apply, allowedEventIds };
  for (const tenant of tenants.filter(row => row.status === 'active' && targetTenantIds.has(String(row.id)))) {
    try {
      results.push(...await runTenant(tenant, runOptions));
    } catch (error) {
      results.push({ tenant: safeHash(tenant.id), status: 'tenant_failed', category: safeFailureCategory(error) });
    }
  }
  return { apply, projectRef, results, count: results.length };
}
module.exports = { runRecovery };
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const allowedEventIds = new Set(String(process.env.LINE_RECOVERY_EVENT_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
  runRecovery({ apply, allowedEventIds, expectedProjectRef: process.env.LINE_RECOVERY_EXPECTED_PROJECT_REF || '' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message || String(error)); process.exitCode = 1; });
}
