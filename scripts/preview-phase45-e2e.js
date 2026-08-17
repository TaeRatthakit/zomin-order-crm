"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const mode = process.argv[2] || "";
const baseUrl = String(process.argv[3] || "").replace(/\/$/, "");
const stateFile = process.argv[4] || "/tmp/growup-phase45-e2e-users.json";

if (!["prepare", "verify"].includes(mode) || !baseUrl) {
  console.error("Usage: node scripts/preview-phase45-e2e.js <prepare|verify> <preview-url> [state-file]");
  process.exit(2);
}

function fail(message) {
  throw new Error(message);
}

function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/secret|clientSecret|imageUrl|hostedInstructionsUrl|data|reference/i.test(key)) return [key, "__redacted__"];
    return [key, redacted(item)];
  }));
}

function responseSummary(response) {
  return `${response.status} ${JSON.stringify(redacted(response.body))}`;
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function request(pathname, options = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return {
    status: res.status,
    headers: res.headers,
    text,
    body,
    cookie: res.headers.get("set-cookie") || ""
  };
}

async function signup({ username, password, businessName, plan, billing }) {
  const res = await request("/api/signup", {
    method: "POST",
    body: {
      username,
      password,
      businessName,
      displayName: businessName,
      landingSelectedPlan: plan,
      landingSelectedBilling: billing,
      signupRequestId: unique("phase45-signup")
    }
  });
  if (res.status !== 200) fail(`signup ${username} failed: ${res.status} ${res.text}`);
  if (!res.cookie) fail(`signup ${username} did not set a session cookie`);
  return { cookie: res.cookie, user: res.body.user };
}

async function login(username, password) {
  const res = await request("/api/login", {
    method: "POST",
    body: { username, password }
  });
  if (res.status !== 200) fail(`login ${username} failed: ${res.status} ${res.text}`);
  if (!res.cookie) fail(`login ${username} did not set a session cookie`);
  return res.cookie;
}

async function prepare() {
  const password = `Phase45-${crypto.randomBytes(4).toString("hex")}`;
  const businessUsername = `${unique("phase45-business")}@example.com`;
  const platformUsername = `${unique("phase45-platform")}@example.com`;
  const business = await signup({
    username: businessUsername,
    password,
    businessName: "Phase45 Business Pending",
    plan: "business",
    billing: "monthly"
  });
  const blockedState = await request("/api/state", { cookie: business.cookie });
  if (blockedState.status !== 402 || blockedState.body.code !== "SUBSCRIPTION_PAYMENT_REQUIRED") {
    fail(`business pending /api/state expected 402, got ${blockedState.status} ${blockedState.text}`);
  }
  const billing = await request("/api/billing/subscription", { cookie: business.cookie });
  if (billing.status !== 200 || billing.body.billing?.subscription?.status !== "pending_payment") {
    fail(`billing snapshot expected pending_payment, got ${billing.status} ${billing.text}`);
  }
  const checkout = await request("/api/billing/checkout", {
    method: "POST",
    cookie: business.cookie,
    body: {
      idempotencyKey: unique("phase45-checkout"),
      amountMinor: 1,
      currency: "USD",
      tenantId: "forged"
    }
  });
  if (checkout.status === 503 && checkout.body.code !== "PAYMENT_PROVIDER_REQUIRED") {
    fail(`checkout provider blocker returned unexpected code: ${responseSummary(checkout)}`);
  } else if (checkout.status === 200) {
    if (checkout.body.provider !== "stripe_promptpay" || checkout.body.billing?.paymentProvider?.stripe?.testMode !== true) {
      fail(`checkout expected Stripe PromptPay Test mode: ${responseSummary(checkout)}`);
    }
    if (checkout.body.payment?.status !== "processing" || !checkout.body.promptpay?.paymentIntentId) {
      fail(`checkout did not create a processing PromptPay Test payment: ${responseSummary(checkout)}`);
    }
  } else if (checkout.status !== 503) {
    fail(`checkout returned unexpected status: ${responseSummary(checkout)}`);
  }
  if (checkout.body.payment?.amountMinor !== billing.body.billing.subscription.amountDueMinor || checkout.body.payment?.currency !== "THB") {
    fail("checkout trusted browser-supplied amount/currency instead of subscription snapshot");
  }

  const platform = await signup({
    username: platformUsername,
    password,
    businessName: "Phase45 Platform Candidate",
    plan: "starter",
    billing: "monthly"
  });
  const denied = await request("/api/platform-admin/overview", { cookie: business.cookie });
  if (denied.status !== 403 || denied.body.code !== "PLATFORM_ADMIN_REQUIRED") {
    fail(`normal owner platform-admin denial expected 403, got ${denied.status} ${denied.text}`);
  }

  const out = {
    baseUrl,
    password,
    business: { username: businessUsername, user: business.user },
    platform: { username: platformUsername, user: platform.user }
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(out, null, 2));
}

async function verify() {
  const state = JSON.parse(fs.readFileSync(path.resolve(stateFile), "utf8"));
  const cookie = await login(state.platform.username, state.password);
  const overview = await request("/api/platform-admin/overview", { cookie });
  if (overview.status !== 200 || overview.body.overview?.role !== "super_admin") {
    fail(`platform overview expected super_admin, got ${overview.status} ${overview.text}`);
  }
  const tenants = await request("/api/platform-admin/tenants?limit=10", { cookie });
  if (tenants.status !== 200 || !Array.isArray(tenants.body.result?.items)) {
    fail(`platform tenants failed: ${tenants.status} ${tenants.text}`);
  }
  const shell = await request("/platform-admin", { cookie });
  if (shell.status !== 200 || !shell.text.includes("app.js")) {
    fail(`platform admin shell failed: ${shell.status}`);
  }
  const promoCode = unique("PHASE45").replace(/-/g, "").toUpperCase().slice(0, 32);
  const promo = await request("/api/platform-admin/promotions", {
    method: "POST",
    cookie,
    body: {
      code: promoCode,
      active: true,
      benefit_type: "percent_discount",
      benefit_value: 5,
      applicable_plans: ["business"],
      applicable_billing: ["monthly"],
      max_redemptions: 1,
      max_redemptions_per_tenant: 1
    }
  });
  if (promo.status !== 200 || promo.body.result?.promotion?.code !== promoCode) {
    fail(`platform promotion create failed: ${promo.status} ${promo.text}`);
  }
  console.log(JSON.stringify({ ok: true, platformUserId: state.platform.user.id, promoCode }, null, 2));
}

(mode === "prepare" ? prepare() : verify()).catch(error => {
  console.error(error);
  process.exit(1);
});
