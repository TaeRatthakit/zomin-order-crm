"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `Missing ${name}`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start);
  return source.slice(start, end + 2);
}

function mount(response, editingOrderId = "") {
  const effects = { applies: 0, patches: 0, resets: 0, closes: 0, toasts: [], requests: [] };
  const form = { id: "orderForm", dataset: {}, matches: () => false, reset() { effects.resets += 1; } };
  let listener;
  const context = {
    crypto, performance, console, FormData: class { entries() { return Object.entries({ date: "2026-10-03", name: "QA customer", phone: "0800012345", amount: "100", jars: "1" }); } },
    app: { editingOrderId, orderSavePending: false, data: { summary: {}, settings: {} } },
    els: { orderSubmitButton: { disabled: false, textContent: "บันทึกออเดอร์", dataset: {} }, workDate: { value: "2026-10-03" }, orderDialog: { close() { effects.closes += 1; } } },
    document: { addEventListener(type, handler) { assert.equal(type, "submit"); listener = handler; } },
    can: () => true, elementId: element => element.id, setSettingsSaveState() {}, setProfileSaveState() {},
    createOrderSaveProfiler: () => ({ mark() {}, cancel() {}, finish() {} }),
    decodedOrderSaveTimings: () => null, normalizeCustomerSourceKey: value => value,
    ADD_CUSTOMER_SOURCE_VALUE: "other", syncOrderProductSelection: () => ({ id: "qa-product", name: "QA product" }),
    todayISO: () => "2026-10-03", applyOrderMutation() { effects.applies += 1; },
    patchOrdersView() { effects.patches += 1; }, refreshVisibleCustomerPanels() {},
    api: async (_url, options) => {
      const body = JSON.parse(options.body); effects.requests.push(body);
      return response(body, context);
    },
    showToast(message, status) { effects.toasts.push({ message, tone: context.toastStatusFor(message, status) }); }
  };
  const submitStart = source.indexOf('document.addEventListener("submit"');
  const submitEnd = source.indexOf('window.addEventListener("hashchange"', submitStart);
  vm.createContext(context);
  vm.runInContext(["toastStatusFor", "setOrderSaveState", "submitOrder"].map(functionSource).join("\n")
    + "\n" + source.slice(submitStart, submitEnd), context);
  return { context, effects, form, submit: () => listener({ target: form, preventDefault() {} }) };
}

async function main() {
  for (const response of [() => ({ ok: true, mutation: {} }), () => ({ ok: true }),
    () => ({ ok: true, mutation: { order: { id: 123 } } }),
    () => ({ ok: true, mutation: { order: { id: "x", customerId: "c" }, clientMutationId: "wrong" } })]) {
    const page = mount(response);
    await page.submit();
    assert.equal(page.effects.resets + page.effects.closes + page.effects.applies + page.effects.patches, 0,
      "ambiguous response must not execute any success-only mutation");
    assert.equal(page.effects.toasts.length, 1);
    assert.equal(page.effects.toasts[0].tone, "error", "actual submit listener and shared toast must present error styling");
    assert.ok(page.form.dataset.clientMutationId);
    assert.equal(page.context.app.orderSavePending, false);
    assert.equal(page.context.els.orderSubmitButton.disabled, false);
    assert.equal(page.context.els.orderSubmitButton.textContent, "บันทึกออเดอร์");
    await page.submit();
    assert.equal(page.effects.requests[0].clientMutationId, page.effects.requests[1].clientMutationId);
  }
  const retry = mount((body, ctx) => {
    if (ctx.responseLost !== false) { ctx.responseLost = false; throw new Error("บันทึกไม่สำเร็จ"); }
    return { ok: true, mutation: { order: { id: "saved", customerId: "customer" }, clientMutationId: body.clientMutationId } };
  });
  await retry.submit();
  assert.equal(retry.effects.toasts[0].tone, "error");
  assert.equal(retry.effects.resets, 0);
  await retry.submit();
  assert.equal(retry.effects.requests[0].clientMutationId, retry.effects.requests[1].clientMutationId);
  assert.equal(retry.effects.applies, 1); assert.equal(retry.effects.resets, 1); assert.equal(retry.effects.closes, 1);
  assert.equal(retry.effects.toasts[1].tone, "success");
  assert.equal(retry.form.dataset.clientMutationId, undefined);
  await retry.submit();
  assert.notEqual(retry.effects.requests[1].clientMutationId, retry.effects.requests[2].clientMutationId);
  const wrongEdit = mount(body => ({ ok: true, mutation: { order: { id: "different", customerId: "c" }, clientMutationId: body.clientMutationId } }), "editing");
  await wrongEdit.submit(); assert.equal(wrongEdit.effects.resets, 0); assert.equal(wrongEdit.context.app.editingOrderId, "editing");
  let resolve;
  const pending = mount(body => new Promise(done => { resolve = () => done({ ok: true, mutation: { order: { id: "once", customerId: "c" }, clientMutationId: body.clientMutationId } }); }));
  const first = pending.submit(); await pending.submit(); assert.equal(pending.effects.requests.length, 1);
  resolve(); await first; assert.equal(pending.effects.applies, 1);
  console.log("Order-save runtime confirmation, actual error styling, retained form, stable retry token, retirement, Edit identity and repeated-submit guards passed.");
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, mount };
