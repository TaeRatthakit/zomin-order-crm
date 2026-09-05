"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");

function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = text.indexOf("\n}\n", start);
  assert.ok(end > start, `Incomplete ${name}`);
  return text.slice(start, end + 2);
}

function node() {
  return {
    handlers: {}, attrs: {}, value: "", textContent: "", hidden: true, disabled: false,
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(key, value) { this.attrs[key] = value; },
    remove() { this.removed = true; }
  };
}

function mount() {
  const app = {
    currentUser: { id: "owner-preview", role: "Owner" },
    data: { billing: { checkoutPromoEnabled: true, subscription: { plan: "starter", status: "active", billingInterval: "monthly" }, latestPayments: [] } },
    billingCheckout: null,
    subscriptionCheckoutDraft: {
      targetPlan: "business",
      billingInterval: "monthly",
      action: "upgrade",
      baseQuote: { plan: "business", billing: "monthly", mode: "payment", base_amount_minor: 99000, discount_amount_minor: 0, amount_minor: 99000 }
    },
    checkoutPromotionCode: "",
    checkoutPromotionError: "",
    checkoutPromoQuote: null,
    subscriptionQuoteLoading: false,
    pricingUpgradeLoading: "",
    subscriptionPromoUi: null,
    subscriptionQrLoadState: null
  };
  const input = node();
  const button = node();
  const message = node();
  const total = node();
  const selectedAmount = node();
  const method = node();
  const confirm = node();
  const result = node();
  const form = node();
  form.querySelector = selector => ({ input, button, "[role=status]": message })[selector] || null;
  form.requestSubmit = () => form.handlers.submit({ preventDefault() {}, stopPropagation() {} });
  let html = "";
  const content = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; input.value = app.checkoutPromotionCode || ""; },
    querySelector(selector) {
      if (selector === "[data-subscription-promo-form]") return html.includes("data-subscription-promo-form") ? form : null;
      if (selector === "[data-subscription-promo-form] button") return button;
      if (selector === "[data-subscription-final-amount]") return total;
      if (selector === "[data-subscription-selected-amount]") return selectedAmount;
      if (selector === "[data-subscription-payment-method]") return method;
      if (selector === "[data-subscription-checkout-confirm]") return confirm;
      if (selector === ".subscription-promo-result") return result;
      return null;
    }
  };
  const requests = [];
  const context = {
    app,
    els: { content },
    escapeHtml: value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]),
    moneyMinorText: value => `THB ${(Number(value || 0) / 100).toFixed(2)}`,
    iconSvg: () => "<svg aria-hidden=\"true\"></svg>",
    setTimeout,
    console,
    render: () => context.renderSettingsSubscription(),
    api: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        quoteToken: "signed-preview-quote",
        quote: { code: "REVIEW20260903", plan: "business", billing: "monthly", mode: "payment", base_amount_minor: 99000, discount_amount_minor: 9900, amount_minor: 89100 }
      };
    }
  };
  vm.runInNewContext(`${functionSource(source, "subscriptionPaymentDisplayStatus")}\n${functionSource(source, "renderSettingsSubscription")}\nrenderSettingsSubscription();`, context);
  return { app, content, input, form, requests, context, total, selectedAmount };
}

async function main() {
  const pricingSource = functionSource(source, "renderPricing");
  assert.doesNotMatch(pricingSource, /checkoutPromotionCode|authenticated-pricing-promo|โค้ดโปรโมชั่น/,
    "Pricing must only select a package");

  const page = mount();
  assert.match(page.content.innerHTML, /Business/);
  assert.match(page.content.innerHTML, /THB 990\.00/);
  assert.match(page.content.innerHTML, /data-subscription-promo-form/);
  assert.match(page.content.innerHTML, /data-subscription-checkout-confirm/);
  assert.match(page.content.innerHTML, /ยังไม่ได้สร้างรายการชำระเงิน/);
  assert.doesNotMatch(page.content.innerHTML, /data-subscription-qr-image/,
    "No QR exists before explicit payment confirmation");
  assert.equal(page.requests.length, 0, "Rendering the payment page creates no PaymentIntent or reservation");

  page.input.value = "REVIEW20260903";
  page.input.handlers.input();
  await page.form.handlers.submit({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(page.requests, [{
    url: "/api/billing/promo/quote",
    body: { promotionCode: "REVIEW20260903", targetPlan: "business", billingInterval: "monthly" }
  }]);
  assert.equal(page.app.checkoutPromoQuote.quote.amount_minor, 89100);
  assert.equal(page.app.billingCheckout, null, "Applying a code must not create checkout/payment state");
  assert.match(page.content.innerHTML, /THB 99\.00/);
  assert.match(page.content.innerHTML, /฿891\.00/);

  const remountedInput = page.context.els.content.querySelector("[data-subscription-promo-form]").querySelector("input");
  remountedInput.value = "CHANGED";
  remountedInput.handlers.input();
  assert.equal(page.app.checkoutPromoQuote, null, "Editing an applied code invalidates the old quote");
  assert.equal(page.app.billingCheckout, null);
  assert.equal(page.total.textContent, "฿990.00", "Editing an applied code restores the summary total");
  assert.equal(page.selectedAmount.textContent, "฿990", "Editing an applied code restores the selected-plan amount");

  assert.match(source, /data-subscription-checkout-confirm/);
  assert.match(source, /beginSubscriptionCheckoutForUi\([\s\S]*promotionCode: applied\?\.quote\?\.code \|\| ""/,
    "Only the explicit confirmation handler starts checkout with the applied server quote");
  assert.match(serverSource, /url\.pathname === "\/api\/billing\/quote"[\s\S]*PRICE_CATALOG_MINOR\[targetPlan\]\?\.\[billingInterval\]/,
    "Base price quote comes from the server catalog");
  assert.match(serverSource, /url\.pathname === "\/api\/billing\/quote"[\s\S]*discount_amount_minor: 0[\s\S]*amount_minor: amountMinor/);
  const upgradeStart = serverSource.indexOf('url.pathname === "/api/billing/upgrade"');
  const upgradeEnd = serverSource.indexOf('url.pathname === "/api/billing/checkout"', upgradeStart);
  const upgradeSource = serverSource.slice(upgradeStart, upgradeEnd > upgradeStart ? upgradeEnd : undefined);
  const providerReconcile = upgradeSource.indexOf("const reconciledStatus = await reconcileResumablePayment");
  const activePromoConflict = upgradeSource.indexOf('if (promotionCode && publicCheckoutPromotion(pendingCandidate.payment)?.code !== promotionCode.toUpperCase())');
  assert.ok(providerReconcile >= 0 && activePromoConflict > providerReconcile,
    "upgrade must reconcile authoritative Stripe state before applying promo conflict to a provider-backed checkout");
  console.log("Pricing selection -> Subscription quote -> explicit confirmation UI passed; no pre-confirm PaymentIntent/QR path remains.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
