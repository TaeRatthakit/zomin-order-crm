const fs = require("fs");
const http = require("http");
const path = require("path");
const { hashPassword } = require("../lib/auth");

const tmpDb = path.join("/tmp", `zomin-permission-test-${Date.now()}.json`);
process.env.DATABASE_PROVIDER = "json";
process.env.JSON_DB_PATH = tmpDb;
process.env.PORT = "0";

const now = new Date().toISOString();
fs.writeFileSync(tmpDb, JSON.stringify({
  settings: {
    businessName: "Permission Test",
    defaultJarPrice: 750,
    vipThresholds: { vip: 5000, vvip: 10000, superVip: 20000 },
    messageTemplates: { normal: "", vip: "" },
    followUpDaysPerUnit: 15,
    products: [{ id: "product_1", name: "Test Product", status: "พร้อมขาย", stockQuantity: 10, costPerItem: 100 }],
    productCosts: [{ id: "product_1", name: "Test Product", costPerJar: 100, enabled: true }],
    additionalCosts: [],
    lineWebhookEnabled: false,
    rolePermissions: {
      Admin: {
        "orders.view": true,
        "orders.create": true,
        "orders.edit": true,
        "orders.delete": false,
        "orders.status": true,
        "orders.export": false,
        "customers.view": true,
        "customers.edit": true,
        "customers.delete": false,
        "customers.export": false,
        "customers.import": false,
        "products.view": true,
        "products.edit": false,
        "products.delete": false,
        "products.stock": false,
        "reports.sales": true,
        "reports.costs": false,
        "reports.profit": false,
        "reports.finance": false,
        "reports.export": false,
        "system.users": false,
        "system.permissions": false,
        "system.business": false,
        "system.integrations": false,
        "system.danger": false
      },
      Staff: {}
    }
  },
  followUpRules: [],
  tags: [],
  users: [
    { id: "u_owner", username: "owner", name: "Owner", role: "Owner", active: true, passwordHash: hashPassword("pass123") },
    { id: "u_admin", username: "admin", name: "Admin", role: "Admin", active: true, passwordHash: hashPassword("pass123") },
    { id: "u_staff", username: "staff", name: "Staff", role: "Staff", active: true, passwordHash: hashPassword("pass123") }
  ],
  customers: [
    { id: "c1", name: "Customer One", phone: "0811111111", tags: [] }
  ],
  orders: [
    { id: "o1", customerId: "c1", customerName: "Customer One", phone: "0811111111", date: "2026-07-11", items: "Test Product", jars: 1, amount: 750, productId: "product_1" }
  ],
  contactLogs: [],
  lineMessages: [],
  createdAt: now
}, null, 2));

const appHandler = require("../server");
const server = http.createServer(appHandler);

function fail(message) {
  throw new Error(message);
}

function request(baseUrl, pathValue, options = {}) {
  return fetch(`${baseUrl}${pathValue}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

async function login(baseUrl, username) {
  const res = await request(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password: "pass123" })
  });
  if (res.status !== 200) fail(`${username} login returned ${res.status}`);
  const cookie = res.headers.get("set-cookie");
  if (!cookie) fail(`${username} login did not set cookie`);
  return cookie;
}

async function expectStatus(baseUrl, pathValue, cookie, status, options = {}) {
  const res = await request(baseUrl, pathValue, {
    ...options,
    headers: { cookie, ...(options.headers || {}) }
  });
  if (res.status !== status) {
    const text = await res.text();
    fail(`${options.method || "GET"} ${pathValue} returned ${res.status}, expected ${status}: ${text}`);
  }
  return res;
}

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const ownerCookie = await login(baseUrl, "owner");
    const adminCookie = await login(baseUrl, "admin");
    const staffCookie = await login(baseUrl, "staff");

    const ownerState = await (await expectStatus(baseUrl, "/api/state", ownerCookie, 200)).json();
    if (!ownerState.currentPermissions["system.permissions"]) fail("Owner did not receive full permissions");
    if ((ownerState.users || []).length !== 3) fail("Owner did not receive full user list");

    const adminState = await (await expectStatus(baseUrl, "/api/state", adminCookie, 200)).json();
    if ((adminState.users || []).length !== 1) fail("Admin received user list");
    if (adminState.currentPermissions["orders.delete"]) fail("Admin unexpectedly has order delete");

    const staffState = await (await expectStatus(baseUrl, "/api/state", staffCookie, 200)).json();
    if ((staffState.users || []).length !== 1) fail("Staff received user list");
    if (!staffState.currentPermissions["orders.create"]) fail("Staff with Add order enabled did not receive orders.create");
    if (staffState.currentPermissions["customers.import"]) fail("Staff unexpectedly has import permission");
    if (staffState.currentPermissions["customers.edit"]) fail("Staff unexpectedly has standalone customer edit permission");
    if (staffState.currentPermissions["system.business"]) fail("Staff unexpectedly has business settings permission");

    const avatarPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const adminProfile = await (await expectStatus(baseUrl, "/api/profile", adminCookie, 200, {
      method: "PUT",
      body: JSON.stringify({ displayName: "Admin", avatar: avatarPng, userId: "u_owner" })
    })).json();
    if (adminProfile.user?.id !== "u_admin" || adminProfile.user?.avatar !== avatarPng) {
      fail("Admin profile update must only update the authenticated admin avatar");
    }
    const ownerAfterAdminProfile = await (await expectStatus(baseUrl, "/api/state", ownerCookie, 200)).json();
    const ownerUserAfterAdminProfile = (ownerAfterAdminProfile.users || []).find(user => user.id === "u_owner");
    if (ownerUserAfterAdminProfile?.avatar === avatarPng) fail("Admin profile update changed the Owner avatar");

    const staffProfile = await (await expectStatus(baseUrl, "/api/profile", staffCookie, 200, {
      method: "PUT",
      body: JSON.stringify({ displayName: "Staff", avatar: avatarPng, targetUserId: "u_owner" })
    })).json();
    if (staffProfile.user?.id !== "u_staff" || staffProfile.user?.avatar !== avatarPng) {
      fail("Staff profile update must only update the authenticated staff avatar");
    }
    await expectStatus(baseUrl, "/api/profile", staffCookie, 400, {
      method: "PUT",
      body: JSON.stringify({ displayName: "Staff", avatar: "data:text/plain;base64,SGVsbG8=" })
    });
    await expectStatus(baseUrl, "/api/profile", staffCookie, 400, {
      method: "PUT",
      body: JSON.stringify({ displayName: "Staff", avatar: `data:image/png;base64,${"A".repeat(2_600_000)}` })
    });

    await expectStatus(baseUrl, "/settings/users", adminCookie, 403);
    await expectStatus(baseUrl, "/api/permissions", adminCookie, 403);
    await expectStatus(baseUrl, "/api/team", adminCookie, 403, {
      method: "POST",
      body: JSON.stringify({ name: "Bad", username: "bad", password: "pass123", role: "Staff" })
    });
    await expectStatus(baseUrl, "/api/orders/o1", adminCookie, 403, { method: "DELETE" });
    await expectStatus(baseUrl, "/api/orders", adminCookie, 200, {
      method: "POST",
      body: JSON.stringify({ name: "Allowed", phone: "0899999999", items: "Test Product", jars: 1, amount: 750, date: "2026-07-11" })
    });
    const staffSource = await (await expectStatus(baseUrl, "/api/customer-sources", staffCookie, 200, {
      method: "POST",
      body: JSON.stringify({ name: "Staff Manual Source" })
    })).json();
    if (staffSource.source?.key !== "staff_manual_source") fail("Staff order source was not saved through orders.create");
    if (!Array.isArray(staffSource.settings?.customerSources)) fail("Staff order source response did not return customerSources");
    if (staffSource.settings?.products || staffSource.settings?.profile_avatar_u_staff) fail("Staff order source response returned unrelated settings");
    const staffExistingSourceOrder = await (await expectStatus(baseUrl, "/api/orders", staffCookie, 200, {
      method: "POST",
      body: JSON.stringify({
        orderNumber: "staff-existing-source-1",
        name: "Staff Existing Source Customer",
        phone: "0888888811",
        address: "Staff existing source address",
        items: "Test Product",
        productId: "product_1",
        jars: 1,
        totalQuantityShipped: 1,
        amount: 750,
        date: "2026-07-12",
        originSource: "facebook",
        tags: "staff-test"
      })
    })).json();
    if (staffExistingSourceOrder.mutation?.order?.originSource !== "facebook") fail("Staff order with existing source did not persist source");
    const staffOrderPayload = await (await expectStatus(baseUrl, "/api/orders", staffCookie, 200, {
      method: "POST",
      body: JSON.stringify({
        orderNumber: "staff-allowed-1",
        name: "Staff Allowed Customer",
        phone: "0888888888",
        address: "Staff test address",
        items: "Test Product",
        productId: "product_1",
        jars: 2,
        totalQuantityShipped: 2,
        amount: 1500,
        date: "2026-07-12",
        originSource: staffSource.source.key,
        tags: "staff-test"
      })
    })).json();
    if (staffOrderPayload.mutation?.order?.customerName !== "Staff Allowed Customer") fail("Staff order was not returned in mutation");
    if (staffOrderPayload.mutation?.order?.createdBy !== "u_staff") fail("Staff order did not record authenticated creator");
    if (staffOrderPayload.mutation?.order?.originSource !== staffSource.source.key) fail("Staff custom source order did not persist source");
    if (staffOrderPayload.mutation?.customers?.[0]?.phone !== "0888888888") fail("Staff order did not create/update customer");
    const productAfterStaffOrder = (staffOrderPayload.mutation?.settings?.products || []).find(product => product.id === "product_1");
    if (Number(productAfterStaffOrder?.stockQuantity) !== 6) fail(`Staff order did not deduct stock correctly: ${productAfterStaffOrder?.stockQuantity}`);
    const staffStateAfterOrder = await (await expectStatus(baseUrl, "/api/state?date=2026-07-12", staffCookie, 200)).json();
    const persistedStaffOrder = (staffStateAfterOrder.orders || []).find(order => order.orderNumber === "staff-allowed-1");
    if (!persistedStaffOrder) fail("Staff order did not appear in reloaded order state");
    if (persistedStaffOrder.customerName !== "Staff Allowed Customer") fail("Reloaded Staff order lost customer name");
    if (Number(persistedStaffOrder.amount) !== 1500) fail("Reloaded Staff order lost amount");
    const persistedStaffCustomer = (staffStateAfterOrder.customers || []).find(customer => customer.phone === "0888888888");
    if (!persistedStaffCustomer) fail("Staff-created customer did not persist");
    const productAfterReload = (staffStateAfterOrder.settings?.products || []).find(product => product.id === "product_1");
    if (Number(productAfterReload?.stockQuantity) !== 6) fail("Staff order stock deduction did not persist after reload");
    await expectStatus(baseUrl, "/api/import", staffCookie, 403, {
      method: "POST",
      body: JSON.stringify({ type: "csv", content: "" })
    });
    const permissionsForStaffDeny = await (await expectStatus(baseUrl, "/api/permissions", ownerCookie, 200)).json();
    permissionsForStaffDeny.rolePermissions.Staff["orders.create"] = false;
    await expectStatus(baseUrl, "/api/permissions", ownerCookie, 200, {
      method: "PUT",
      body: JSON.stringify({ rolePermissions: permissionsForStaffDeny.rolePermissions })
    });
    const staffDeniedCookie = await login(baseUrl, "staff");
    const deniedStaffState = await (await expectStatus(baseUrl, "/api/state", staffDeniedCookie, 200)).json();
    if (deniedStaffState.currentPermissions["orders.create"]) fail("Staff denied Add order still received orders.create");
    await expectStatus(baseUrl, "/api/customer-sources", staffDeniedCookie, 403, {
      method: "POST",
      body: JSON.stringify({ name: "Blocked Staff Source" })
    });
    await expectStatus(baseUrl, "/api/orders", staffDeniedCookie, 403, {
      method: "POST",
      body: JSON.stringify({ name: "Blocked Staff", phone: "0877777777", items: "Test Product", productId: "product_1", jars: 1, amount: 750, date: "2026-07-12" })
    });
    await expectStatus(baseUrl, "/api/products", adminCookie, 403, {
      method: "POST",
      body: JSON.stringify({ name: "Blocked Product" })
    });
    await expectStatus(baseUrl, "/api/export/orders", adminCookie, 403);

    const permissions = await (await expectStatus(baseUrl, "/api/permissions", ownerCookie, 200)).json();
    permissions.rolePermissions.Admin["orders.delete"] = true;
    permissions.rolePermissions.Admin["orders.export"] = true;
    permissions.rolePermissions.Staff["orders.create"] = true;
    await expectStatus(baseUrl, "/api/permissions", ownerCookie, 200, {
      method: "PUT",
      body: JSON.stringify({ rolePermissions: permissions.rolePermissions })
    });

    const adminCookieAfter = await login(baseUrl, "admin");
    const adminStateAfter = await (await expectStatus(baseUrl, "/api/state", adminCookieAfter, 200)).json();
    if (!adminStateAfter.currentPermissions["orders.delete"]) fail("Permission did not persist after re-login");
    await expectStatus(baseUrl, "/api/export/orders", adminCookieAfter, 200);
    await expectStatus(baseUrl, "/settings/users", staffCookie, 403);

    console.log("Permission smoke test passed.");
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmpDb, { force: true });
  }
});
