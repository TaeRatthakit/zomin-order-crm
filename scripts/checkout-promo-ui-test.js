"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const baseline = "ee95f55433899ca163ba64ffe589273210cf43bd";

function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start);
  return text.slice(start, end + 2);
}

function fixture(plan = "business", interval = "monthly", status = "requires_action", operation = "subscription_upgrade") {
  const amountMinor = { starter: 49000, business: 99000, enterprise: 199000 }[plan] * (interval === "yearly" ? 10 : 1);
  return {
    currentUser: { id: "local-promo-ui-test-owner", role: "Owner" },
    data: { billing: { subscription: { plan: "starter", status: "active", billingInterval: interval } } },
    billingCheckout: {
      payment: { id: "local-ui-fixture-not-a-provider-payment", plan, targetPlan: plan, operation, amountMinor, billingInterval: interval, providerStatus: status, verifiedSuccess: status === "succeeded" },
      upgrade: { targetPlan: plan, currentPlan: "starter", billingInterval: interval },
      // Deliberately no generated/scannable QR or provider URL in isolated UI tests.
      promptpay: { amountMinor, status }
    }
  };
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
}

function node() {
  return { handlers: {}, attrs: {}, value: "", textContent: "", hidden: true, disabled: false,
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(key, value) { this.attrs[key] = value; }
  };
}

function mount(app = fixture(), text = source) {
  freeze(app.data);
  freeze(app.billingCheckout);
  const input = node(), button = node(), message = node(), form = node();
  form.querySelector = selector => ({ input, button, "[role=status]": message })[selector];
  const timers = [];
  let html = "", renders = 0;
  const content = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; renders += 1; },
    querySelector(selector) {
      if (!html.includes("data-subscription-promo-form")) return null;
      if (selector === "[data-subscription-promo-form]") return form;
      if (selector === "[data-subscription-promo-form] button") return button;
      return null;
    }
  };
  const context = {
    app, els: { content },
    escapeHtml: value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    iconSvg: () => "<svg aria-hidden=\"true\"></svg>",
    setTimeout: (callback, delay) => { assert.equal(delay, 600); timers.push(callback); },
    fetch() { throw new Error("Promo must not make network requests"); },
    api() { throw new Error("Promo must not call application APIs"); }
  };
  vm.runInNewContext(`${functionSource(text, "subscriptionPaymentDisplayStatus")}\n${functionSource(text, "renderSettingsSubscription")}\nrenderSettingsSubscription();`, context);
  return { app, context, input, button, message, form, content, timers,
    get renders() { return renders; },
    edit(value) { input.value = value; input.handlers.input(); },
    submit() { let prevented = false, stopped = false; form.handlers.submit({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }); assert.equal(prevented, true); assert.equal(stopped, true); },
    release() { timers.splice(0).forEach(callback => callback()); }
  };
}

function normalizeCheckout(html) {
  return html.replace(/<form class="subscription-promo"[\s\S]*?<\/form>/g, "").replace(/>\s+</g, "><").trim();
}

function main() {
  const oldSource = execFileSync("git", ["show", `${baseline}:public/app.js`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const test = mount();
  const before = JSON.stringify({ data: test.app.data, checkout: test.app.billingCheckout });
  assert.ok(test.content.innerHTML.indexOf('class="subscription-promo"') < test.content.innerHTML.indexOf('class="subscription-summary-total"'));
  assert.match(test.content.innerHTML, /โค้ดส่วนลด/);
  assert.match(test.content.innerHTML, /placeholder="กรอกโค้ดโปรโมชั่น"/);
  test.submit();
  assert.equal(test.message.textContent, "กรุณากรอกโค้ดโปรโมชั่น");
  assert.equal(test.input.attrs["aria-invalid"], "true");
  assert.equal(test.button.disabled, true);
  test.submit();
  assert.equal(test.timers.length, 1, "Rapid clicks are ignored");
  test.release();
  assert.equal(test.button.disabled, false);
  let enterSubmits = 0;
  test.form.requestSubmit = () => { enterSubmits += 1; test.submit(); };
  test.input.handlers.keydown({ key: "Enter", isComposing: true });
  assert.equal(enterSubmits, 0, "Do not submit while composing text");
  test.input.handlers.keydown({ key: "Enter", preventDefault() {} });
  assert.equal(enterSubmits, 1, "Enter uses the same submit handler");
  test.release();
  test.edit("   "); test.submit();
  assert.equal(test.input.value, "");
  assert.equal(test.message.textContent, "กรุณากรอกโค้ดโปรโมชั่น");
  test.release();
  test.edit("  Summer_2026-10.test  ");
  assert.equal(test.message.hidden, true);
  test.submit();
  assert.equal(test.input.value, "Summer_2026-10.test");
  assert.equal(test.input.attrs["aria-invalid"], "false");
  assert.equal(test.message.textContent, "ระบบโค้ดโปรโมชั่นกำลังเตรียมพร้อมใช้งาน");
  assert.equal(JSON.stringify({ data: test.app.data, checkout: test.app.billingCheckout }), before);
  assert.equal(test.renders, 1, "Promo submission must not remount checkout or QR");
  assert.equal(normalizeCheckout(test.content.innerHTML), normalizeCheckout(mount(fixture(), oldSource).content.innerHTML));
  test.release();
  test.edit('\"><img src=x onerror=alert(1)>');
  test.context.renderSettingsSubscription();
  assert.ok(!test.content.innerHTML.includes('<img src=x'));
  assert.match(test.content.innerHTML, /&quot;&gt;&lt;img/);
  test.app.billingCheckout = freeze({ ...fixture().billingCheckout, payment: { ...fixture().billingCheckout.payment, id: "different-checkout" } });
  test.context.renderSettingsSubscription();
  assert.equal(test.app.subscriptionPromoUi.code, "", "Draft must not leak into a different checkout");
  for (const plan of ["starter", "business", "enterprise"]) {
    for (const interval of ["monthly", "yearly"]) {
      for (const operation of ["subscription_renewal", "subscription_upgrade"]) {
        for (const status of ["requires_action", "processing", "failed", "canceled", "succeeded"]) {
          const current = mount(fixture(plan, interval, status, operation));
          const old = mount(fixture(plan, interval, status, operation), oldSource);
          assert.equal(normalizeCheckout(current.content.innerHTML), normalizeCheckout(old.content.innerHTML), `${plan}/${interval}/${operation}/${status}: existing checkout changed`);
          if (status === "succeeded") assert.ok(!current.content.innerHTML.includes("data-subscription-promo-form"));
          else { current.edit("TEST-NO-DISCOUNT"); current.submit(); assert.equal(current.renders, 1); }
        }
      }
    }
  }
  assert.equal(functionSource(source, "hydrateSubscriptionCheckout"), functionSource(oldSource, "hydrateSubscriptionCheckout"));
  assert.equal(functionSource(source, "renderPricing"), functionSource(oldSource, "renderPricing"));
  assert.equal(functionSource(source, "subscriptionPaymentDisplayStatus"), functionSource(oldSource, "subscriptionPaymentDisplayStatus"));
  console.log("Checkout promo UI passed: 60 baseline-identical payment render cases; trim/empty/neutral/rapid-submit/XSS/draft-isolation; zero API calls, zero payment mutations, no QR remount. Pricing/hydration/success logic unchanged.");
}

module.exports = { functionSource, fixture, mount, source, root };
if (require.main === module) main();
