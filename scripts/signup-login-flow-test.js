"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "supabase";
process.env.SUPABASE_URL = "https://signup-login-test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "signup-login-test-session-secret";
process.env.AUTH_RATE_LIMIT_MAX = "200";

const { Readable } = require("stream");
const crypto = require("crypto");
const appHandler = require("../server");
const { hashPassword } = require("../lib/auth");

const db = {
  tenants: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Tenant A", status: "active" },
    { id: "22222222-2222-4222-8222-222222222222", name: "Tenant B", status: "active" },
    { id: "33333333-3333-4333-8333-333333333333", name: "Tenant Suspended", status: "suspended" }
  ],
  tenant_memberships: [
    { id: "m_a_owner", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_owner", role: "Owner", is_active: true },
    { id: "m_a_admin", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_admin", role: "Admin", is_active: true },
    { id: "m_a_staff", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_staff", role: "Staff", is_active: true },
    { id: "m_b_owner", tenant_id: "22222222-2222-4222-8222-222222222222", user_id: "u_b_owner", role: "Owner", is_active: true },
    { id: "m_inactive", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_inactive_membership", role: "Owner", is_active: false },
    { id: "m_suspended", tenant_id: "33333333-3333-4333-8333-333333333333", user_id: "u_suspended", role: "Owner", is_active: true },
    { id: "m_multi_a", tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u_multi", role: "Owner", is_active: true },
    { id: "m_multi_b", tenant_id: "22222222-2222-4222-8222-222222222222", user_id: "u_multi", role: "Owner", is_active: true }
  ],
  users: [
    { id: "u_owner", username: "owner@example.com", password_hash: hashPassword("pass12345"), name: "Owner A", role: "Owner", phone: "", is_active: true },
    { id: "u_admin", username: "admin@example.com", password_hash: hashPassword("pass12345"), name: "Admin A", role: "Admin", phone: "", is_active: true },
    { id: "u_staff", username: "staff@example.com", password_hash: hashPassword("pass12345"), name: "Staff A", role: "Staff", phone: "", is_active: true },
    { id: "u_b_owner", username: "owner-b@example.com", password_hash: hashPassword("pass12345"), name: "Owner B", role: "Owner", phone: "", is_active: true },
    { id: "u_no_membership", username: "nomember@example.com", password_hash: hashPassword("pass12345"), name: "No Member", role: "Owner", phone: "", is_active: true },
    { id: "u_inactive_membership", username: "inactive-member@example.com", password_hash: hashPassword("pass12345"), name: "Inactive Member", role: "Owner", phone: "", is_active: true },
    { id: "u_disabled", username: "disabled@example.com", password_hash: hashPassword("pass12345"), name: "Disabled", role: "Owner", phone: "", is_active: false },
    { id: "u_suspended", username: "suspended@example.com", password_hash: hashPassword("pass12345"), name: "Suspended", role: "Owner", phone: "", is_active: true },
    { id: "u_multi", username: "multi@example.com", password_hash: hashPassword("pass12345"), name: "Multi", role: "Owner", phone: "", is_active: true }
  ],
  settings: [
    { id: "11111111-1111-4111-8111-111111111111:businessName", key: "businessName", value: "Tenant A", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "11111111-1111-4111-8111-111111111111:products", key: "products", value: [{ id: "product_a", name: "Product A", stockQuantity: 5 }], tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "22222222-2222-4222-8222-222222222222:businessName", key: "businessName", value: "Tenant B", tenant_id: "22222222-2222-4222-8222-222222222222" },
    { id: "22222222-2222-4222-8222-222222222222:products", key: "products", value: [{ id: "product_b", name: "Product B", stockQuantity: 5 }], tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  follow_up_rules: [
    { id: "11111111-1111-4111-8111-111111111111:1", jars: 1, days: 15, tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "22222222-2222-4222-8222-222222222222:1", jars: 1, days: 15, tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  customers: [
    { id: "c_a", name: "A Customer", phone: "0811111111", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "c_b", name: "B Customer", phone: "0822222222", tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  orders: [
    { id: "o_a", customer_id: "c_a", items: "Product A", quantity: 1, amount: 100, order_date: "2026-08-09", tenant_id: "11111111-1111-4111-8111-111111111111" },
    { id: "o_b", customer_id: "c_b", items: "Product B", quantity: 1, amount: 100, order_date: "2026-08-09", tenant_id: "22222222-2222-4222-8222-222222222222" }
  ],
  line_messages: [],
  tags: [],
  customer_tags: [],
  contact_logs: [],
  notification_reads: [],
  tenant_role_permissions: [],
  tenant_settings: [],
  signup_bootstraps: []
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
    } else if (value.startsWith("in.")) {
      const values = new Set(parseIn(value.slice(3)));
      out = out.filter(row => values.has(String(row[key])));
    }
  }
  const limit = Number(params.get("limit") || 0);
  return limit ? out.slice(0, limit) : out;
}

function conflictKey(row, params) {
  return String(params.get("on_conflict") || "id").split(",").map(key => `${key}:${row[key]}`).join("|");
}

function rpcError(message) {
  return new Response(JSON.stringify({ message }), { status: 400 });
}

function signupBootstrap(payload = {}) {
  const key = String(payload.p_idempotency_key || "").trim();
  const username = String(payload.p_username || "").trim().toLowerCase();
  const existingBootstrap = db.signup_bootstraps.find(row => row.idempotency_key === key);
  if (existingBootstrap) {
    if (existingBootstrap.username !== username) return rpcError("IDEMPOTENCY_CONFLICT");
    return new Response(JSON.stringify(signupResult(existingBootstrap.user_id, existingBootstrap.tenant_id)), { status: 200 });
  }
  if (db.users.some(row => row.username.toLowerCase() === username)) return rpcError("ACCOUNT_EXISTS");
  if (!key || !username || !payload.p_password_hash || !payload.p_business_name) return rpcError("INVALID_SIGNUP_INPUT");
  const tenantId = crypto.randomUUID();
  const userId = String(payload.p_user_id || `u_${crypto.randomUUID()}`);
  db.users.push({
    id: userId,
    username,
    password_hash: payload.p_password_hash,
    name: String(payload.p_name || payload.p_business_name),
    role: "Owner",
    phone: "",
    is_active: true
  });
  db.tenants.push({ id: tenantId, name: String(payload.p_business_name), status: "active", metadata: { source: "public_signup" } });
  db.tenant_memberships.push({ id: crypto.randomUUID(), tenant_id: tenantId, user_id: userId, role: "Owner", is_active: true });
  for (const role of ["Owner", "Admin", "Staff"]) {
    db.tenant_role_permissions.push({ tenant_id: tenantId, role, permissions: {} });
  }
  const defaults = payload.p_defaults || {};
  for (const [settingKey, value] of Object.entries(defaults.settings || {})) {
    db.settings.push({ id: `${tenantId}:${settingKey}`, key: settingKey, value, tenant_id: tenantId });
  }
  for (const rule of defaults.followUpRules || []) {
    db.follow_up_rules.push({ id: `${tenantId}:${rule.jars}`, jars: rule.jars, days: rule.days, tenant_id: tenantId });
  }
  db.signup_bootstraps.push({ idempotency_key: key, username, user_id: userId, tenant_id: tenantId, status: "completed" });
  return new Response(JSON.stringify(signupResult(userId, tenantId)), { status: 200 });
}

function signupResult(userId, tenantId) {
  const user = db.users.find(row => row.id === userId);
  const tenant = db.tenants.find(row => row.id === tenantId);
  const membership = db.tenant_memberships.find(row => row.user_id === userId && row.tenant_id === tenantId && row.is_active);
  return [{
    user_id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    phone: user.phone,
    is_active: user.is_active,
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    tenant_role: membership.role
  }];
}

global.fetch = async function mockFetch(input, options = {}) {
  const url = new URL(String(input));
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-2) === "rpc" && parts.at(-1) === "growup_signup_bootstrap") {
    return signupBootstrap(JSON.parse(options.body || "{}"));
  }
  const table = parts.at(-1);
  if (!Object.prototype.hasOwnProperty.call(db, table)) {
    return new Response(JSON.stringify({ message: `unknown table ${table}` }), { status: 404 });
  }
  const method = String(options.method || "GET").toUpperCase();
  if (method === "GET") {
    const rows = applyFilters(db[table], url.searchParams);
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (method === "POST") {
    const rows = JSON.parse(options.body || "[]");
    for (const row of rows) {
      const key = conflictKey(row, url.searchParams);
      const index = db[table].findIndex(existing => conflictKey(existing, url.searchParams) === key);
      if (index === -1) db[table].push({ ...row });
      else db[table][index] = { ...db[table][index], ...row };
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (method === "DELETE") {
    const rows = new Set(applyFilters(db[table], url.searchParams));
    db[table] = db[table].filter(row => !rows.has(row));
    return new Response(null, { status: 204 });
  }
  if (method === "PATCH") {
    const patch = JSON.parse(options.body || "{}");
    for (const row of applyFilters(db[table], url.searchParams)) Object.assign(row, patch);
    return new Response(null, { status: 204 });
  }
  return new Response("unsupported", { status: 405 });
};

function header(headers, name) {
  const found = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found ? found[1] : "";
}

function makeRequest(path, options = {}) {
  const body = options.body || "";
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || "GET";
  req.url = path;
  req.headers = {
    host: "127.0.0.1",
    ...(options.headers || {})
  };
  return req;
}

function makeResponse(resolve) {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolve({
        status: this.statusCode,
        headers: this.headers,
        text: Buffer.concat(chunks).toString("utf8"),
        json() {
          return this.text ? JSON.parse(this.text) : {};
        }
      });
    }
  };
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      }
    });
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

async function login(username, password = "pass12345") {
  const res = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  if (res.status !== 200) fail(`${username} login returned ${res.status}: ${res.text}`);
  const cookie = header(res.headers, "set-cookie");
  if (!cookie) fail(`${username} login did not set cookie`);
  return { cookie, body: res.json() };
}

(async () => {
  try {
    const runtime = await request("/api/verify/runtime");
    if (runtime.status !== 200) fail(`runtime verify returned ${runtime.status}`);
    const runtimeBody = runtime.json();
    if (JSON.stringify(runtimeBody).includes("test-service-role-key")) fail("runtime verify leaked service role key");

    const owner = await login("owner@example.com");
    const admin = await login("admin@example.com");
    const staff = await login("staff@example.com");
    if (owner.body.user.role !== "Owner" || admin.body.user.role !== "Admin" || staff.body.user.role !== "Staff") fail("login roles were not preserved");
    if (owner.body.user.tenantId !== "11111111-1111-4111-8111-111111111111") fail("owner login did not resolve tenant A");

    for (const username of ["owner@example.com", "nomember@example.com", "inactive-member@example.com", "disabled@example.com", "suspended@example.com", "multi@example.com"]) {
      const res = await request("/api/login", {
        method: "POST",
        body: JSON.stringify({ username, password: username === "owner@example.com" ? "wrongpass" : "pass12345" })
      });
      if (res.status !== 401) fail(`${username} unsafe login returned ${res.status}`);
      if (!res.text.includes("Username หรือ Password ไม่ถูกต้อง")) fail(`${username} login leaked auth details: ${res.text}`);
    }

    const spoofedState = await request("/api/state", {
      headers: { cookie: owner.cookie, "x-tenant-id": "22222222-2222-4222-8222-222222222222" }
    });
    if (spoofedState.status !== 200) fail(`spoofed state returned ${spoofedState.status}`);
    const spoofedBody = spoofedState.json();
    if ((spoofedBody.orders || []).some(order => order.id === "o_b")) fail("tenant spoofing exposed tenant B order");

    const crossDelete = await request("/api/orders/o_b", { method: "DELETE", headers: { cookie: owner.cookie } });
    if (crossDelete.status !== 404) fail(`cross-tenant delete returned ${crossDelete.status}: ${crossDelete.text}`);
    const ownerB = await login("owner-b@example.com");
    const tenantBState = (await request("/api/state", { headers: { cookie: ownerB.cookie } })).json();
    if (!(tenantBState.orders || []).some(order => order.id === "o_b")) fail("tenant A direct-ID attempt deleted tenant B order");

    const signupPayload = {
      username: "new_owner",
      password: "newpass123",
      businessName: "New Pilot Co",
      displayName: "New Owner",
      signupRequestId: "signup-test-1"
    };
    const signup = await request("/api/signup", { method: "POST", body: JSON.stringify(signupPayload) });
    if (signup.status !== 200) fail(`signup returned ${signup.status}: ${signup.text}`);
    const signupCookie = header(signup.headers, "set-cookie");
    const signupUser = signup.json().user;
    if (signupUser.role !== "Owner" || signupUser.tenantRole !== "Owner" || !signupUser.tenantId) fail("signup did not create Owner tenant session");
    const signupTenantId = signupUser.tenantId;
    const newTenantSettings = db.settings.filter(row => row.tenant_id === signupTenantId);
    if (!newTenantSettings.some(row => row.key === "businessName" && row.value === "New Pilot Co")) fail("signup did not initialize tenant businessName");
    if (db.tenant_memberships.filter(row => row.tenant_id === signupTenantId && row.role === "Owner").length !== 1) fail("signup created duplicate Owner membership");

    const duplicateSubmit = await request("/api/signup", { method: "POST", body: JSON.stringify(signupPayload) });
    if (duplicateSubmit.status !== 200) fail(`duplicate idempotent signup returned ${duplicateSubmit.status}: ${duplicateSubmit.text}`);
    if (db.tenants.filter(row => row.name === "New Pilot Co").length !== 1) fail("duplicate signup created another tenant");
    if (db.tenant_memberships.filter(row => row.tenant_id === signupTenantId && row.role === "Owner").length !== 1) fail("duplicate signup created another Owner");

    const existingAccount = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({ ...signupPayload, signupRequestId: "signup-test-2" })
    });
    if (existingAccount.status !== 409) fail(`existing account signup returned ${existingAccount.status}`);

    const newState = (await request("/api/state", { headers: { cookie: signupCookie } })).json();
    if (newState.settings?.businessName !== "New Pilot Co") fail("new signup session did not enter new tenant state");
    if ((newState.orders || []).some(order => ["o_a", "o_b"].includes(order.id))) fail("new tenant can see another tenant order");
    const tenantBAfterSignup = (await request("/api/state", { headers: { cookie: ownerB.cookie } })).json();
    if ((tenantBAfterSignup.users || []).some(user => user.username === "new-owner@example.com")) fail("tenant B can see new tenant user");

    const badSignup = await request("/api/signup", {
      method: "POST",
      body: JSON.stringify({ username: "bad", password: "short", businessName: "" })
    });
    if (badSignup.status !== 400) fail(`invalid signup returned ${badSignup.status}`);

    const logout = await request("/api/logout", { method: "POST", headers: { cookie: signupCookie } });
    if (logout.status !== 200 || !header(logout.headers, "set-cookie").includes("Expires=Thu, 01 Jan 1970")) fail("logout did not clear cookie");
    const privateState = await request("/api/state");
    if (privateState.status !== 401) fail(`private state returned ${privateState.status}: ${privateState.text}`);
    const privateRoute = await request("/dashboard");
    if (privateRoute.status !== 302 || header(privateRoute.headers, "location") !== "/login") fail("private route was accessible after logout without cookie");
    const usernameLogin = await login("new_owner", "newpass123");
    const usernameState = (await request("/api/state", { headers: { cookie: usernameLogin.cookie } })).json();
    if (usernameState.settings?.businessName !== "New Pilot Co") fail("username signup login did not enter bootstrapped tenant state");
    if (usernameLogin.body.user.username !== "new_owner") fail("username signup login returned the wrong user");

    console.log("Signup/Login flow security test passed.");
  } finally {}
})().catch(error => {
  console.error(error);
  process.exit(1);
});
