const { Readable } = require("stream");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.LINE_WEBHOOK_ENABLED = "true";
if (!process.env.JSON_DB_PATH) {
  process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-smoke-${process.pid}.json`);
  fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), process.env.JSON_DB_PATH);
}
const appHandler = require("../server");

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
  const res = {
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
        text: Buffer.concat(chunks).toString("utf8")
      });
    }
  };
  return res;
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, options);
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] || "";
}

function fail(message) {
  throw new Error(`Smoke test failed: ${message}`);
}

function bangkokNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`
  };
}

function shiftDate(dateValue, days) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function main() {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "zomin-smoke-test-secret";

  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) fail(`admin login returned ${login.status}: ${login.text}`);
  const cookie = header(login.headers, "set-cookie");
  if (!cookie || !cookie.includes("HttpOnly")) fail("admin login did not set an HttpOnly session cookie");

  const adminState = await request("/api/state", { headers: { cookie } });
  if (adminState.status !== 200) fail(`admin state returned ${adminState.status}: ${adminState.text}`);
  const parsedAdminState = JSON.parse(adminState.text);
  if (!parsedAdminState.currentUser || parsedAdminState.currentUser.role !== "Owner") {
    fail("state did not return Owner session");
  }
  const ownerUser = parsedAdminState.currentUser;
  const originalOwnerName = ownerUser.name;
  const originalOwnerAvatar = ownerUser.avatar || "";
  const profileSyncName = `Smoke Owner ${crypto.randomBytes(3).toString("hex")}`;
  const profileSyncAvatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const profileUpdate = await request("/api/profile", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ displayName: profileSyncName, avatar: profileSyncAvatar })
  });
  if (profileUpdate.status !== 200) fail(`profile update returned ${profileUpdate.status}: ${profileUpdate.text}`);
  const staleCookieSession = await request("/api/session", { headers: { cookie } });
  if (staleCookieSession.status !== 200) fail(`fresh session from stale cookie returned ${staleCookieSession.status}: ${staleCookieSession.text}`);
  const staleCookieUser = JSON.parse(staleCookieSession.text).user;
  if (staleCookieUser?.name !== profileSyncName || staleCookieUser?.avatar !== profileSyncAvatar) {
    fail("session endpoint did not refresh profile from the database");
  }
  const stateAfterProfile = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  if (
    stateAfterProfile.currentUser?.name !== profileSyncName
    || stateAfterProfile.currentUser?.avatar !== profileSyncAvatar
    || !stateAfterProfile.users.find(user => user.id === ownerUser.id && user.name === profileSyncName && user.avatar === profileSyncAvatar)
  ) {
    fail("state endpoint did not synchronize current user and users profile fields");
  }
  const profileRestore = await request("/api/profile", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ displayName: originalOwnerName, avatar: originalOwnerAvatar })
  });
  if (profileRestore.status !== 200) fail(`profile restore returned ${profileRestore.status}: ${profileRestore.text}`);

  const downgradeLastOwner = await request(`/api/team/${encodeURIComponent(ownerUser.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "Admin" })
  });
  if (downgradeLastOwner.status !== 409) fail(`last Owner downgrade returned ${downgradeLastOwner.status}: ${downgradeLastOwner.text}`);

  const disableLastOwner = await request(`/api/team/${encodeURIComponent(ownerUser.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ active: false })
  });
  if (disableLastOwner.status !== 409) fail(`last Owner disable returned ${disableLastOwner.status}: ${disableLastOwner.text}`);

  const deleteLastOwner = await request(`/api/team/${encodeURIComponent(ownerUser.id)}`, {
    method: "DELETE",
    headers: { cookie }
  });
  if (deleteLastOwner.status !== 409) fail(`last Owner delete returned ${deleteLastOwner.status}: ${deleteLastOwner.text}`);

  const managerUsername = `manager_${crypto.randomBytes(3).toString("hex")}`;
  const managerPassword = "manager123";
  const createManager = await request("/api/team", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Smoke Manager",
      username: managerUsername,
      password: managerPassword,
      role: "Admin"
    })
  });
  if (createManager.status !== 200) fail(`creating Admin manager returned ${createManager.status}: ${createManager.text}`);
  const createdManager = JSON.parse(createManager.text).user;

  const managerLogin = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: managerUsername, password: managerPassword })
  });
  if (managerLogin.status !== 200) fail(`manager login returned ${managerLogin.status}: ${managerLogin.text}`);
  const managerCookie = header(managerLogin.headers, "set-cookie");

  const adminEditsOwner = await request(`/api/team/${encodeURIComponent(ownerUser.id)}`, {
    method: "PUT",
    headers: { cookie: managerCookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "Admin" })
  });
  if (adminEditsOwner.status !== 403) fail(`Admin editing Owner returned ${adminEditsOwner.status}: ${adminEditsOwner.text}`);

  const adminDeletesOwner = await request(`/api/team/${encodeURIComponent(ownerUser.id)}`, {
    method: "DELETE",
    headers: { cookie: managerCookie }
  });
  if (adminDeletesOwner.status !== 403) fail(`Admin deleting Owner returned ${adminDeletesOwner.status}: ${adminDeletesOwner.text}`);

  const downgradeManager = await request(`/api/team/${encodeURIComponent(createdManager.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "Staff" })
  });
  if (downgradeManager.status !== 200) fail(`downgrading manager returned ${downgradeManager.status}: ${downgradeManager.text}`);
  const staleManagerSession = await request("/api/session", { headers: { cookie: managerCookie } });
  if (staleManagerSession.status !== 200) fail(`manager fresh session returned ${staleManagerSession.status}: ${staleManagerSession.text}`);
  if (JSON.parse(staleManagerSession.text).user?.role !== "Staff") {
    fail("session endpoint did not refresh a changed role from the database");
  }
  const staleManagerSettingsWrite = await request("/api/settings", {
    method: "PUT",
    headers: { cookie: managerCookie, "content-type": "application/json" },
    body: JSON.stringify({ businessName: "Stale Manager Should Not Save" })
  });
  if (staleManagerSettingsWrite.status !== 403) {
    fail(`stale Admin cookie was allowed to save settings after downgrade: ${staleManagerSettingsWrite.status}`);
  }

  const financeSettings = await request("/api/settings", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      productCosts: [{ id: "pc_smoke", name: "Zomin", costPerJar: 48, enabled: true }],
      additionalCosts: [
        { id: "ac_order", name: "ค่ากล่อง", amount: 5, type: "fixed_per_order", enabled: true },
        { id: "ac_item", name: "ค่าแพ็ก", amount: 2, type: "per_item", enabled: true },
        { id: "ac_cod", name: "ค่า COD", amount: 2.5, type: "percent_sales", enabled: true }
      ]
    })
  });
  if (financeSettings.status !== 200) fail(`finance settings returned ${financeSettings.status}: ${financeSettings.text}`);
  const savedFinanceSettings = JSON.parse(financeSettings.text).settings;
  if (savedFinanceSettings.productCosts?.[0]?.costPerJar !== 48) fail("product cost did not persist");
  if (
    savedFinanceSettings.additionalCosts?.map(item => item.type).join(",")
    !== "fixed_per_order,per_item,percent_sales"
  ) {
    fail("additional cost calculation types did not persist");
  }

  const productSuffix = crypto.randomBytes(3).toString("hex");
  const zominImageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const acnaImageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8zwAAAgEBAScY42YAAAAASUVORK5CYII=";
  const zominPackages = Array.from({ length: 25 }, (_, packageIndex) => ({
    id: `z_pkg_${packageIndex + 1}`,
    name: `Zomin Package ${packageIndex + 1}`,
    paidQuantity: packageIndex + 1,
    freeQuantity: 1,
    totalQuantityShipped: packageIndex + 2,
    salePrice: 750 * (packageIndex + 1),
    enabled: true,
    expenses: Array.from({ length: 12 }, (_, expenseIndex) => ({
      id: `z_pkg_${packageIndex + 1}_expense_${expenseIndex + 1}`,
      name: `Zomin Expense ${packageIndex + 1}-${expenseIndex + 1}`,
      amount: expenseIndex + 0.5,
      enabled: expenseIndex % 2 === 0
    }))
  }));
  zominPackages.splice(1, 0, {
    ...zominPackages[0],
    id: "z_pkg_duplicate",
    name: "Zomin Package 1 สำเนา",
    expenses: zominPackages[0].expenses.map(expense => ({
      ...expense,
      id: `${expense.id}_duplicate`
    }))
  });
  const zominProductInput = {
    name: "Zomin",
    sku: `ZOMIN-${productSuffix}`,
    image: zominImageDataUrl,
    description: "รายละเอียดสินค้า Zomin เดิม",
    salePrice: 750,
    costPerItem: 46.85,
    stockQuantity: 120,
    lowStockAlert: 10,
    status: "พร้อมขาย",
    salesPackages: zominPackages
  };
  const createZomin = await request("/api/products", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(zominProductInput)
  });
  if (createZomin.status !== 200) fail(`Zomin product creation returned ${createZomin.status}: ${createZomin.text}`);
  const savedZomin = JSON.parse(createZomin.text).product;

  const acnaProductInput = {
    ...zominProductInput,
    name: "ACNA",
    sku: `ACNA-${productSuffix}`,
    image: acnaImageDataUrl,
    description: "รายละเอียดสินค้า ACNA",
    salesPackages: [{
      id: "acna_pkg_1",
      name: "ACNA Starter",
      paidQuantity: 2,
      freeQuantity: 0,
      totalQuantityShipped: 2,
      salePrice: 990,
      enabled: true,
      expenses: [
        { id: "acna_box", name: "ACNA Box", amount: 8, enabled: true },
        { id: "acna_shipping", name: "ACNA Shipping", amount: 45, enabled: true }
      ]
    }]
  };
  const createAcna = await request("/api/products", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(acnaProductInput)
  });
  if (createAcna.status !== 200) fail(`ACNA product creation returned ${createAcna.status}: ${createAcna.text}`);
  const savedAcna = JSON.parse(createAcna.text).product;
  if (!savedZomin.id || !savedAcna.id || savedZomin.id === savedAcna.id) {
    fail("new products did not receive separate unique ids");
  }

  const lineOrderText = (productLine, suffix) => [
    `สินค้า : ${productLine}`,
    `เลขออเดอร์ : LINE-NORM-${suffix}`,
    "วันที่ซื้อ : 3/7/2569",
    "ช่องทางการสั่งซื้อ : ไลน์บริษัท",
    "Facebook / LINE ลูกค้า : line-normalize-test",
    "",
    `ชื่อลูกค้า : คุณ Normalize ${suffix}`,
    `เบอร์โทร : 082${String(suffix).padStart(7, "0").slice(-7)}`,
    "เบอร์โทรสำรอง : 0891234567",
    `ที่อยู่จัดส่ง : 99 Test Road ${suffix}`,
    "",
    "จำนวน : 1",
    "ยอดซื้อ : 750 บาท",
    "",
    "สถานะบัตร VIP : ยังไม่ได้ส่งบัตร",
    "อาการลูกค้า : ทดสอบ",
    "หมายเหตุ : normalize product test"
  ].join("\n");
  const lineProductCases = [
    ["Zomin", "Zomin"],
    ["สินค้า : Zomin", "Zomin"],
    ["zomin", "Zomin"],
    ["   Zomin    ", "Zomin"],
    ["สินค้าZomin", "Zomin"],
    ["ค้าค้าzomin", "Zomin"],
    ["สินค้าซื้อ zomin", "Zomin"],
    ["ข้อความมั่ว zomin", "Zomin"]
  ];
  for (let index = 0; index < lineProductCases.length; index += 1) {
    const [inputProduct, expectedProduct] = lineProductCases[index];
    const suffix = `${productSuffix}${index}`;
    const mock = await request("/api/line/mock", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: lineOrderText(inputProduct, suffix) })
    });
    if (mock.status !== 200) fail(`LINE mock normalization returned ${mock.status}: ${mock.text}`);
    const rows = JSON.parse(mock.text).rows || [];
    if (rows[0]?.items !== expectedProduct) {
      fail(`LINE product normalization failed for "${inputProduct}": got "${rows[0]?.items}"`);
    }
  }
  const zominLabelProduct = await request("/api/products", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...zominProductInput,
      id: "",
      name: "สินค้า : zomin",
      sku: ""
    })
  });
  if (zominLabelProduct.status !== 200) fail(`normalized existing product save returned ${zominLabelProduct.status}: ${zominLabelProduct.text}`);
  const normalizedExistingProduct = JSON.parse(zominLabelProduct.text).product;
  if (normalizedExistingProduct.id !== savedZomin.id || normalizedExistingProduct.name !== "Zomin") {
    fail("normalized product label did not prefer existing Zomin product");
  }
  const zominPlusProductInput = {
    ...zominProductInput,
    id: "",
    name: "Zomin Plus",
    sku: "",
    salesPackages: []
  };
  const createZominPlusForMatching = await request("/api/products", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(zominPlusProductInput)
  });
  if (createZominPlusForMatching.status !== 200) {
    fail(`Zomin Plus product creation returned ${createZominPlusForMatching.status}: ${createZominPlusForMatching.text}`);
  }
  const longestMatchMock = await request("/api/line/mock", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: lineOrderText("ข้อความมั่ว zomin plus", `${productSuffix}long`) })
  });
  if (longestMatchMock.status !== 200) fail(`longest product match returned ${longestMatchMock.status}: ${longestMatchMock.text}`);
  const longestRows = JSON.parse(longestMatchMock.text).rows || [];
  if (longestRows[0]?.items !== "Zomin Plus") {
    fail(`longest product match did not choose Zomin Plus: got "${longestRows[0]?.items}"`);
  }
  const trulyNewProductName = `สินค้าใหม่ Normalize ${productSuffix}`;
  const trulyNewOrderProduct = `ข้อความสินค้าใหม่ ${productSuffix}`;
  const trulyNewOrderMock = await request("/api/line/mock", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: lineOrderText(trulyNewOrderProduct, `${productSuffix}new`) })
  });
  if (trulyNewOrderMock.status !== 200) fail(`new product order match returned ${trulyNewOrderMock.status}: ${trulyNewOrderMock.text}`);
  const trulyNewOrderRows = JSON.parse(trulyNewOrderMock.text).rows || [];
  if (trulyNewOrderRows[0]?.items !== trulyNewOrderProduct) {
    fail("text without existing product keyword did not remain a new product name");
  }
  const trulyNewProduct = await request("/api/products", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...zominProductInput,
      id: "",
      name: trulyNewProductName,
      sku: "",
      salesPackages: []
    })
  });
  if (trulyNewProduct.status !== 200) fail(`truly new product save returned ${trulyNewProduct.status}: ${trulyNewProduct.text}`);
  const savedTrulyNewProduct = JSON.parse(trulyNewProduct.text).product;
  if (!savedTrulyNewProduct.id || savedTrulyNewProduct.id === savedZomin.id || savedTrulyNewProduct.name !== trulyNewProductName) {
    fail("truly new product was not created after normalization changes");
  }
  const productsAfterProductNormalization = JSON.parse((await request("/api/state", { headers: { cookie } })).text).settings.products;
  if (productsAfterProductNormalization.some(product => /^สินค้า\s*[:：]/.test(product.name))) {
    fail("normalized product label created a bad duplicate product");
  }

  const productsAfterCreate = JSON.parse((await request("/api/state", { headers: { cookie } })).text).settings.products;
  const unchangedZomin = productsAfterCreate.find(product => product.id === savedZomin.id);
  const independentAcna = productsAfterCreate.find(product => product.id === savedAcna.id);
  if (
    unchangedZomin?.image !== zominProductInput.image
    || unchangedZomin?.salePrice !== zominProductInput.salePrice
    || unchangedZomin?.stockQuantity !== zominProductInput.stockQuantity
    || unchangedZomin?.costPerItem !== 46.85
    || unchangedZomin?.description !== zominProductInput.description
  ) {
    fail("adding ACNA overwrote Zomin product fields");
  }
  if (
    independentAcna?.name !== acnaProductInput.name
    || independentAcna?.image !== acnaProductInput.image
    || independentAcna?.costPerItem !== acnaProductInput.costPerItem
    || independentAcna?.stockQuantity !== acnaProductInput.stockQuantity
    || unchangedZomin?.salesPackages?.length !== 26
    || unchangedZomin?.salesPackages?.[0]?.expenses?.length !== 12
    || independentAcna?.salesPackages?.length !== 1
  ) {
    fail("ACNA product fields were not saved independently");
  }
  if (
    unchangedZomin.salesPackages[0].id === unchangedZomin.salesPackages[1].id
    || unchangedZomin.salesPackages[0].expenses[0].id === unchangedZomin.salesPackages[1].expenses[0].id
  ) {
    fail("duplicated package or expenses reused ids");
  }

  const editZomin = await request(`/api/products/${encodeURIComponent(savedZomin.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ stockQuantity: 119, description: "Zomin edited independently" })
  });
  const editAcna = await request(`/api/products/${encodeURIComponent(savedAcna.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ salePrice: 790, image: "https://example.com/images/acna-v2.png" })
  });
  if (editZomin.status !== 200 || editAcna.status !== 200) fail("one or both products could not be opened and edited by id");

  const productsAfterEdit = JSON.parse((await request("/api/state", { headers: { cookie } })).text).settings.products;
  const editedZomin = productsAfterEdit.find(product => product.id === savedZomin.id);
  const editedAcna = productsAfterEdit.find(product => product.id === savedAcna.id);
  if (editedZomin?.stockQuantity !== 119 || editedZomin?.image !== zominProductInput.image) {
    fail("editing Zomin changed the wrong fields or lost its image");
  }
  if (editedAcna?.salePrice !== 790 || editedAcna?.image !== "https://example.com/images/acna-v2.png") {
    fail("editing ACNA did not persist its own fields");
  }
  if (
    editedZomin?.salesPackages?.[0]?.expenses?.[0]?.amount !== 0.5
    || editedAcna?.salesPackages?.[0]?.expenses?.[0]?.amount !== 8
  ) {
    fail("package expenses leaked between products");
  }
  const productCostsAfterEdit = JSON.parse((await request("/api/state", { headers: { cookie } })).text).settings.productCosts;
  if (
    !productCostsAfterEdit.find(item => item.id === savedZomin.id && item.name === "Zomin" && item.costPerJar === 46.85)
    || !productCostsAfterEdit.find(item => item.id === savedAcna.id && item.name === "ACNA" && item.costPerJar === 46.85)
  ) {
    fail("product cost rows were not kept separate by product id");
  }

  const packageOrderExpenses = editedZomin.salesPackages[0].expenses.map(expense => ({ ...expense }));
  const packageOrder = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      orderNumber: `PKG-${productSuffix}`,
      items: "Zomin",
      name: "ลูกค้าแพ็กเกจทดสอบ",
      phone: `086${Date.now().toString().slice(-7)}`,
      address: "กรุงเทพฯ",
      date: bangkokNow().date,
      jars: 2,
      amount: 750,
      productId: savedZomin.id,
      packageId: editedZomin.salesPackages[0].id,
      packageName: editedZomin.salesPackages[0].name,
      paidQuantity: editedZomin.salesPackages[0].paidQuantity,
      freeQuantity: editedZomin.salesPackages[0].freeQuantity,
      totalQuantityShipped: editedZomin.salesPackages[0].totalQuantityShipped,
      packageExpenses: packageOrderExpenses
    })
  });
  if (packageOrder.status !== 200) fail(`package order returned ${packageOrder.status}: ${packageOrder.text}`);
  const packageOrderId = JSON.parse(packageOrder.text).mutation?.order?.id;
  const packageOrderAfterSave = JSON.parse((await request("/api/state", { headers: { cookie } })).text)
    .orders.find(order => order.id === packageOrderId);
  if (
    packageOrderAfterSave?.productId !== savedZomin.id
    || packageOrderAfterSave?.packageId !== editedZomin.salesPackages[0].id
    || packageOrderAfterSave?.packageExpenses?.length !== 12
    || packageOrderAfterSave?.totalQuantityShipped !== 2
  ) {
    fail("package order snapshot did not persist");
  }
  const enabledPackageExpenseTotal = packageOrderExpenses
    .filter(expense => expense.enabled)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const expectedGlobalExpense = 5 + (2 * 2) + (750 * 0.025);
  const expectedInitialProfit = 750 - (46.85 * 2) - enabledPackageExpenseTotal - expectedGlobalExpense;
  if (
    packageOrderAfterSave.revenueSnapshot !== 750
    || packageOrderAfterSave.productCostSnapshot !== 93.7
    || packageOrderAfterSave.packageExpenseSnapshot !== enabledPackageExpenseTotal
    || packageOrderAfterSave.globalExpenseSnapshot !== expectedGlobalExpense
    || packageOrderAfterSave.profitBeforeAdsSnapshot !== expectedInitialProfit
    || packageOrderAfterSave.profitAfterAdsSnapshot !== expectedInitialProfit
    || packageOrderAfterSave.profitSnapshotVersion !== 1
    || packageOrderAfterSave.profitSnapshotSource !== "created"
    || !packageOrderAfterSave.profitSnapshotCreatedAt
    || !packageOrderAfterSave.profitSnapshotUpdatedAt
  ) {
    fail("package order immutable profit snapshot was not calculated correctly");
  }

  const originalProfitSnapshot = {
    productCostSnapshot: packageOrderAfterSave.productCostSnapshot,
    packageExpenseSnapshot: packageOrderAfterSave.packageExpenseSnapshot,
    globalExpenseSnapshot: packageOrderAfterSave.globalExpenseSnapshot,
    profitBeforeAdsSnapshot: packageOrderAfterSave.profitBeforeAdsSnapshot,
    profitAfterAdsSnapshot: packageOrderAfterSave.profitAfterAdsSnapshot,
    profitSnapshotCreatedAt: packageOrderAfterSave.profitSnapshotCreatedAt
  };
  const changedPackages = editedZomin.salesPackages.map((salesPackage, index) => (
    index === 0
      ? {
          ...salesPackage,
          expenses: salesPackage.expenses.map((expense, expenseIndex) => (
            expenseIndex === 0 ? { ...expense, amount: 999 } : expense
          ))
        }
      : salesPackage
  ));
  const changePackageExpense = await request(`/api/products/${encodeURIComponent(savedZomin.id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ salesPackages: changedPackages })
  });
  if (changePackageExpense.status !== 200) fail("package expense change failed during snapshot regression");

  const settingsBeforeCostChange = JSON.parse((await request("/api/state", { headers: { cookie } })).text).settings;
  const changedProductCosts = settingsBeforeCostChange.productCosts.map(item => (
    item.id === savedZomin.id || item.name === "Zomin"
      ? { ...item, costPerJar: 99 }
      : item
  ));
  const changeProductCost = await request("/api/settings", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ productCosts: changedProductCosts })
  });
  if (changeProductCost.status !== 200) fail("product cost change failed during snapshot regression");

  const packageOrderAfterCostChanges = JSON.parse((await request("/api/state", { headers: { cookie } })).text)
    .orders.find(order => order.id === packageOrderId);
  for (const [field, value] of Object.entries(originalProfitSnapshot)) {
    if (packageOrderAfterCostChanges?.[field] !== value) {
      fail(`historical order snapshot changed after product/package cost edit: ${field}`);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 5));
  const editPackageOrder = await request(`/api/orders/${encodeURIComponent(packageOrderId)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ amount: 800, selectedDate: bangkokNow().date })
  });
  if (editPackageOrder.status !== 200) fail(`package order edit returned ${editPackageOrder.status}`);
  const editedPackageOrder = JSON.parse((await request("/api/state", { headers: { cookie } })).text)
    .orders.find(order => order.id === packageOrderId);
  const expectedEditedGlobalExpense = 5 + (2 * 2) + (800 * 0.025);
  const expectedEditedProfit = 800 - (99 * 2) - enabledPackageExpenseTotal - expectedEditedGlobalExpense;
  if (
    editedPackageOrder?.revenueSnapshot !== 800
    || editedPackageOrder?.productCostSnapshot !== 198
    || editedPackageOrder?.packageExpenseSnapshot !== enabledPackageExpenseTotal
    || editedPackageOrder?.globalExpenseSnapshot !== expectedEditedGlobalExpense
    || editedPackageOrder?.profitBeforeAdsSnapshot !== expectedEditedProfit
    || editedPackageOrder?.profitAfterAdsSnapshot !== expectedEditedProfit
    || editedPackageOrder?.profitSnapshotSource !== "edited"
    || editedPackageOrder?.profitSnapshotCreatedAt !== originalProfitSnapshot.profitSnapshotCreatedAt
    || editedPackageOrder?.profitSnapshotUpdatedAt === originalProfitSnapshot.profitSnapshotCreatedAt
  ) {
    fail("editing an order did not recalculate and update its immutable profit snapshot");
  }

  const adTestDate = bangkokNow().date;
  const adStateBefore = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  const zominOrdersForAdDate = adStateBefore.orders.filter(order => (
    order.date === adTestDate
    && (order.productId === savedZomin.id || order.items === "Zomin")
  ));
  const zominSalesForAdDate = zominOrdersForAdDate
    .reduce((sum, order) => sum + Number(order.revenueSnapshot ?? order.amount ?? 0), 0);
  const profitBeforeAdsForDate = adStateBefore.orders
    .filter(order => order.date === adTestDate)
    .reduce((sum, order) => sum + Number(order.profitBeforeAdsSnapshot || 0), 0);
  const profitSnapshotBeforeAdvertising = editedPackageOrder.profitBeforeAdsSnapshot;
  const adInputs = [
    {
      date: adTestDate,
      productId: savedZomin.id,
      productName: "Zomin",
      platformId: "facebook_ads",
      costMode: "fixed_amount",
      value: 120,
      enabled: true
    },
    {
      date: adTestDate,
      productId: savedZomin.id,
      productName: "Zomin",
      platformId: "tiktok_ads",
      costMode: "percent_sales",
      value: 10,
      enabled: true
    },
    {
      date: adTestDate,
      productId: savedZomin.id,
      productName: "Zomin",
      platformId: "google_ads",
      costMode: "cost_per_order",
      value: 30,
      enabled: true
    }
  ];
  const savedAdRecords = [];
  for (const adInput of adInputs) {
    const response = await request("/api/ad-costs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(adInput)
    });
    if (response.status !== 200) fail(`ad cost creation returned ${response.status}: ${response.text}`);
    savedAdRecords.push(JSON.parse(response.text).record);
  }
  const adPerformanceResponse = await request(`/api/marketing-performance?date=${adTestDate}`, {
    headers: { cookie }
  });
  if (adPerformanceResponse.status !== 200) fail("marketing performance endpoint failed");
  const adPerformance = JSON.parse(adPerformanceResponse.text).performance;
  const expectedFixedAdCost = 120;
  const expectedPercentAdCost = zominSalesForAdDate * 0.1;
  const expectedPerOrderAdCost = zominOrdersForAdDate.length * 30;
  const expectedAdCost = expectedFixedAdCost + expectedPercentAdCost + expectedPerOrderAdCost;
  if (Math.abs(adPerformance.adCost - expectedAdCost) > 0.000001) {
    fail("fixed, percent-of-sales, or cost-per-order ad cost calculation is incorrect");
  }
  const zominProductPerformance = adPerformance.productPerformance
    .find(row => row.productId === savedZomin.id || row.productName === "Zomin");
  if (!zominProductPerformance || Math.abs(zominProductPerformance.adCost - expectedAdCost) > 0.000001) {
    fail("product-level ad cost was not grouped correctly");
  }
  const expectedPlatformCosts = {
    facebook_ads: expectedFixedAdCost,
    tiktok_ads: expectedPercentAdCost,
    google_ads: expectedPerOrderAdCost
  };
  for (const [platformId, expectedCost] of Object.entries(expectedPlatformCosts)) {
    const row = adPerformance.platformPerformance.find(item => item.platformId === platformId);
    if (!row || Math.abs(row.adCost - expectedCost) > 0.000001) {
      fail(`platform-level ad cost was not grouped correctly: ${platformId}`);
    }
  }
  if (
    Math.abs(adPerformance.profitBeforeAds - profitBeforeAdsForDate) > 0.000001
    || Math.abs(adPerformance.profitAfterAds - (profitBeforeAdsForDate - expectedAdCost)) > 0.000001
  ) {
    fail("profit before ads changed or profit after ads did not subtract advertising cost");
  }
  const stateAfterAdvertising = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  const orderAfterAdvertising = stateAfterAdvertising.orders.find(order => order.id === packageOrderId);
  if (
    orderAfterAdvertising?.profitBeforeAdsSnapshot !== profitSnapshotBeforeAdvertising
    || orderAfterAdvertising?.profitAfterAdsSnapshot !== profitSnapshotBeforeAdvertising
  ) {
    fail("advertising cost mutated an existing order profit snapshot");
  }

  const historicalAdDate = shiftDate(adTestDate, -1);
  const historicalAd = await request("/api/ad-costs", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      date: historicalAdDate,
      productId: savedZomin.id,
      productName: "Zomin",
      platformId: "facebook_ads",
      costMode: "fixed_amount",
      value: 77,
      enabled: true
    })
  });
  if (historicalAd.status !== 200) fail("historical ad cost creation failed");
  const historicalBeforeEdit = JSON.parse((await request(
    `/api/marketing-performance?date=${historicalAdDate}`,
    { headers: { cookie } }
  )).text).performance;
  const editTodayAd = await request(`/api/ad-costs/${encodeURIComponent(savedAdRecords[0].id)}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ value: 140 })
  });
  if (editTodayAd.status !== 200) fail("editing today's ad cost failed");
  const historicalAfterEdit = JSON.parse((await request(
    `/api/marketing-performance?date=${historicalAdDate}`,
    { headers: { cookie } }
  )).text).performance;
  if (historicalBeforeEdit.adCost !== 77 || historicalAfterEdit.adCost !== 77) {
    fail("editing today's ad cost changed a previous day's advertising cost");
  }

  const legacyOrderId = `legacy_profit_${productSuffix}`;
  const legacyDb = JSON.parse(fs.readFileSync(process.env.JSON_DB_PATH, "utf8"));
  legacyDb.orders.push({
    id: legacyOrderId,
    customerId: packageOrderAfterSave.customerId,
    orderNumber: `LEGACY-${productSuffix}`,
    items: "Zomin",
    customerName: "ลูกค้า Legacy Profit",
    phone: packageOrderAfterSave.phone,
    address: "กรุงเทพฯ",
    date: bangkokNow().date,
    time: bangkokNow().time,
    jars: 1,
    amount: 1000,
    source: "Legacy",
    sourceChannel: "Legacy",
    packageId: "",
    packageExpenses: []
  });
  fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(legacyDb, null, 2)}\n`, "utf8");
  const stateAfterLegacyBackfill = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  const backfilledLegacyOrder = stateAfterLegacyBackfill.orders.find(order => order.id === legacyOrderId);
  const expectedLegacyGlobalExpense = 5 + 2 + (1000 * 0.025);
  if (
    backfilledLegacyOrder?.productCostSnapshot !== 99
    || backfilledLegacyOrder?.packageExpenseSnapshot !== 0
    || backfilledLegacyOrder?.globalExpenseSnapshot !== expectedLegacyGlobalExpense
    || backfilledLegacyOrder?.profitAfterAdsSnapshot !== 1000 - 99 - expectedLegacyGlobalExpense
    || backfilledLegacyOrder?.profitSnapshotSource !== "backfilled"
    || backfilledLegacyOrder?.profitSnapshotVersion !== 1
  ) {
    fail("legacy order did not use the current fallback formula for lazy backfill");
  }

  const productClient = await request("/app.js");
  if (
    productClient.status !== 200
    || !productClient.text.includes("function normalizeProductImageSource")
    || !productClient.text.includes("function productImageMarkup")
    || !productClient.text.includes('console.debug("[product-image-debug]"')
    || !productClient.text.includes("data.image = app.productDraftImage")
    || !productClient.text.includes("data-duplicate-sales-package")
    || !productClient.text.includes("packageExpenseTotalForOrder")
    || !productClient.text.includes("function hasOrderProfitSnapshot")
    || !productClient.text.includes("function fallbackProfitForOrder")
    || !productClient.text.includes("function profitForOrder")
    || !productClient.text.includes("function productCostMoney")
    || !productClient.text.includes("function applyQuantityMatchedOrderPackage")
    || !productClient.text.includes("function mobileOrderProductParts")
    || !productClient.text.includes("function mobileOrderProductSummary")
    || !productClient.text.includes("mobile-order-products")
    || !productClient.text.includes("delete data.originSourceChoice;\n  applyQuantityMatchedOrderPackage(data);")
    || !productClient.text.includes("Number(item.totalQuantityShipped || 0) === quantity")
    || !productClient.text.includes("section.hidden = true")
  ) {
    fail("product image, mobile order product row, or decimal cost renderer is missing from the client");
  }
  const appShell = await request("/");
  if (
    appShell.status !== 200
    || !appShell.text.includes('id="orderPackageSection"')
    || !appShell.text.includes('name="jars"')
    || !appShell.text.includes("จำนวน <i>*</i>")
  ) {
    fail("order quantity or existing package section is missing from the app shell");
  }
  const importWorker = await request("/import-worker.js");
  if (
    importWorker.status !== 200
    || !importWorker.text.includes('key: "jars", label: "จำนวน"')
    || !importWorker.text.includes('aliases: ["จำนวน", "จำนวนกระปุก"')
  ) {
    fail("import quantity label or legacy quantity alias is missing");
  }
  const clientSections = {
    home: productClient.text.slice(
      productClient.text.indexOf("function renderDashboard()"),
      productClient.text.indexOf("const businessManagementItems")
    ),
    reports: productClient.text.slice(
      productClient.text.indexOf("function renderMobileReports("),
      productClient.text.indexOf("function renderReports(")
    ),
    finance: productClient.text.slice(
      productClient.text.indexOf("function renderMobileBusinessFinance()"),
      productClient.text.indexOf("function renderMobileBusinessSecurity()")
    ),
    productProfitDetail: productClient.text.slice(
      productClient.text.indexOf("function renderMobileBusinessProductDetail()"),
      productClient.text.indexOf("function renderMobileBusinessSystem()")
    )
  };
  for (const [page, source] of Object.entries(clientSections)) {
    if (!source.includes("profitBreakdownForOrders(")) {
      fail(`${page} does not use the snapshot-first profit breakdown`);
    }
  }
  const supabaseAdapterSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "db", "supabase-adapter.js"),
    "utf8"
  );
  for (const metadataKey of [
    "__revenueSnapshot",
    "__productCostSnapshot",
    "__packageExpenseSnapshot",
    "__globalExpenseSnapshot",
    "__profitBeforeAdsSnapshot",
    "__profitAfterAdsSnapshot",
    "__profitSnapshotVersion",
    "__profitSnapshotCreatedAt",
    "__profitSnapshotUpdatedAt",
    "__profitSnapshotSource"
  ]) {
    if (!supabaseAdapterSource.includes(metadataKey)) {
      fail(`Supabase order metadata is missing ${metadataKey}`);
    }
  }

  const staffLogin = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "staff", password: "staff123" })
  });
  if (staffLogin.status !== 200) fail(`staff login returned ${staffLogin.status}: ${staffLogin.text}`);
  const staffCookie = header(staffLogin.headers, "set-cookie");
  const staffTeam = await request("/api/state", { headers: { cookie: staffCookie } });
  if (staffTeam.status !== 200) fail(`staff state returned ${staffTeam.status}: ${staffTeam.text}`);
  const parsedStaffState = JSON.parse(staffTeam.text);
  if (!parsedStaffState.currentUser || parsedStaffState.currentUser.role !== "Staff") {
    fail("state did not return Staff session");
  }

  const customersCsv = await request("/api/export/customers", { headers: { cookie } });
  if (customersCsv.status !== 200) fail(`customers export returned ${customersCsv.status}`);
  if (!customersCsv.text.includes("vipLevel")) fail("customers CSV header is missing expected columns");

  const ordersCsv = await request("/api/export/orders", { headers: { cookie } });
  if (ordersCsv.status !== 200) fail(`orders export returned ${ordersCsv.status}`);
  if (!ordersCsv.text.includes("customerName")) fail("orders CSV header is missing expected columns");

  const backup = await request("/api/backup", { headers: { cookie } });
  if (backup.status !== 200) fail(`backup returned ${backup.status}`);
  const parsedBackup = JSON.parse(backup.text);
  if (!parsedBackup.data || !Array.isArray(parsedBackup.data.users)) fail("backup JSON is missing data.users");

  const webhookHealth = await request("/api/line/webhook");
  if (webhookHealth.status !== 200) fail(`LINE webhook health returned ${webhookHealth.status}`);

  const nowInBangkok = bangkokNow();
  const uniqueSuffix = crypto.randomBytes(3).toString("hex");
  const uniquePhoneSuffix = String(Date.now()).slice(-5);
  const newLineOrderText = [
    "สินค้า : Zomin Plus",
    `เลขออเดอร์ : LINE-${uniqueSuffix}`,
    "วันที่ซื้อ : 3/7/2569",
    "ช่องทางการสั่งซื้อ : ไลน์บริษัท",
    "Facebook / LINE ลูกค้า : line-test",
    "",
    "ชื่อลูกค้า : คุณไลน์ ทดสอบ",
    `เบอร์โทร : 08123${uniquePhoneSuffix}`,
    "เบอร์โทรสำรอง : 0891234567",
    "ที่อยู่จัดส่ง : 99 ถนนสุขุมวิท",
    "แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110",
    "",
    "จำนวน : 3",
    "ยอดซื้อ : 2,250 บาท",
    "ของแถมที่ลูกค้าได้ : แถม 1 กระปุก",
    "",
    "สถานะบัตร VIP : ส่งบัตรแล้ว",
    "",
    "อาการลูกค้า : ปวดเข่า, นอนไม่หลับ",
    "",
    "ช่องทางการขาย : ลูกค้าบอกต่อ",
    "",
    "หมายเหตุ : โทรก่อนส่ง"
  ].join("\n");
  const newLinePreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ content: newLineOrderText })
  });
  if (newLinePreview.status !== 200) fail(`new LINE format preview returned ${newLinePreview.status}`);
  const newLineRow = JSON.parse(newLinePreview.text).rows?.[0];
  if (!newLineRow || newLineRow.items !== "Zomin Plus") {
    fail(`new LINE format did not parse สินค้า: ${JSON.stringify(newLineRow)}`);
  }
  if (newLineRow.orderNumber !== `LINE-${uniqueSuffix}` || newLineRow.sourceChannel !== "ไลน์บริษัท") {
    fail("new LINE format did not parse order number or sales channel");
  }
  if (newLineRow.originSource !== "ลูกค้าบอกต่อ") {
    fail(`new LINE format did not parse ช่องทางการขาย: ${JSON.stringify(newLineRow)}`);
  }
  const legacyLinePreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ content: newLineOrderText.replace("ช่องทางการขาย : ลูกค้าบอกต่อ", "ลูกค้ามาจาก : ลูกค้าบอกต่อ") })
  });
  if (legacyLinePreview.status !== 200) fail(`legacy LINE format preview returned ${legacyLinePreview.status}`);
  const legacyLineRow = JSON.parse(legacyLinePreview.text).rows?.[0];
  if (legacyLineRow?.originSource !== "ลูกค้าบอกต่อ") {
    fail(`legacy LINE format did not parse ลูกค้ามาจาก: ${JSON.stringify(legacyLineRow)}`);
  }
  if (newLineRow.name !== "คุณไลน์ ทดสอบ" || newLineRow.phone !== `08123${uniquePhoneSuffix}`) {
    fail("new LINE format did not parse customer fields");
  }
  if (newLineRow.date !== "2026-07-03" || newLineRow.socialName !== "line-test") {
    fail("new LINE format did not parse date or customer social");
  }
  const expectedMultiLineAddress = "99 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110";
  if (newLineRow.alternatePhone !== "0891234567" || newLineRow.address !== expectedMultiLineAddress) {
    fail("new LINE format did not parse alternate phone or shipping address");
  }
  if (newLineRow.jars !== 3 || newLineRow.amount !== 2250 || newLineRow.freeGift !== "แถม 1 กระปุก") {
    fail("new LINE format did not parse quantity, amount, or free gift");
  }
  const oldQuantityLabelPreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ content: newLineOrderText.replace("จำนวน : 3", "จำนวนกระปุก : 3") })
  });
  if (oldQuantityLabelPreview.status !== 200) fail(`old quantity LINE label preview returned ${oldQuantityLabelPreview.status}`);
  const oldQuantityLabelRow = JSON.parse(oldQuantityLabelPreview.text).rows?.[0];
  if (oldQuantityLabelRow?.jars !== newLineRow.jars) {
    fail(`old and new LINE quantity labels produced different values: ${JSON.stringify({ old: oldQuantityLabelRow?.jars, next: newLineRow.jars })}`);
  }
  if (newLineRow.vipCardStatus !== "ส่งบัตรแล้ว" || newLineRow.originSource !== "ลูกค้าบอกต่อ" || newLineRow.note !== "โทรก่อนส่ง") {
    fail("new LINE format did not parse VIP, source, or note");
  }
  if (!Array.isArray(newLineRow.tags) || !newLineRow.tags.includes("ปวดเข่า") || !newLineRow.tags.includes("นอนไม่หลับ")) {
    fail("new LINE format did not parse customer symptoms");
  }
  const newLineImport = await request("/api/line/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        type: "message",
        replyToken: "",
        source: { type: "group", groupId: "smoke-test-group" },
        message: { type: "text", id: `line-message-${uniqueSuffix}`, text: newLineOrderText }
      }]
    })
  });
  if (newLineImport.status !== 200) fail(`new LINE format import returned ${newLineImport.status}: ${newLineImport.text}`);
  if (JSON.parse(newLineImport.text).parsedOrders !== 1) {
    fail(`new LINE webhook format was not imported: ${newLineImport.text}`);
  }
  const stateAfterLineImport = await request("/api/state", { headers: { cookie } });
  const importedLineOrder = JSON.parse(stateAfterLineImport.text).orders?.find(order => order.orderNumber === `LINE-${uniqueSuffix}`);
  if (!importedLineOrder || importedLineOrder.items !== "Zomin Plus" || importedLineOrder.orderNumber !== `LINE-${uniqueSuffix}`) {
    fail("new LINE format product was not persisted by the webhook path");
  }
  if (importedLineOrder.address !== expectedMultiLineAddress) {
    fail(`new LINE format multi-line shipping address was not persisted: ${JSON.stringify(importedLineOrder.address)}`);
  }

  const lineReplies = [];
  const originalFetch = global.fetch;
  const originalLineAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "smoke-line-access-token";
  global.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://api.line.me/")) {
      lineReplies.push(JSON.parse(options.body || "{}"));
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    }
    return originalFetch(url, options);
  };

  const upsaleOrderNumber = `UPSALE-${uniqueSuffix}`;
  const upsalePhone = `08345${uniquePhoneSuffix}`;
  const upsaleLineText = ({ jars, amount, gift = "", note = "Original", symptoms = "ปวดเข่า" }) => [
    "สินค้า : ACNA",
    `เลขออเดอร์ : ${upsaleOrderNumber}`,
    "วันที่ซื้อ : 12/7/2569",
    "ช่องทางการสั่งซื้อ : ไลน์บริษัท",
    "Facebook / LINE ลูกค้า : upsale-test",
    "ชื่อลูกค้า : คุณอัปเซล ทดสอบ",
    `เบอร์โทร : ${upsalePhone}`,
    "ที่อยู่จัดส่ง : 123 UPSALE Road กรุงเทพฯ",
    `จำนวน : ${jars}`,
    `ยอดซื้อ : ${amount.toLocaleString("en-US")} บาท`,
    ...(gift ? [`ของแถมที่ลูกค้าได้ : ${gift}`] : []),
    "สถานะบัตร VIP : ยังไม่ได้ส่งบัตร",
    `อาการลูกค้า : ${symptoms}`,
    "ช่องทางการขาย : ทดสอบ",
    `หมายเหตุ : ${note}`
  ].join("\n");
  const postLineEvent = (messageId, text, replyToken = "") => request("/api/line/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      events: [{
        type: "message",
        replyToken,
        source: { type: "group", groupId: "smoke-test-group" },
        message: { type: "text", id: messageId, text }
      }]
    })
  });
  const acnaStockBeforeUpsale = Number(
    JSON.parse((await request("/api/state", { headers: { cookie } })).text)
      .settings.products.find(product => product.id === savedAcna.id)?.stockQuantity
  );
  const firstUpsaleText = upsaleLineText({ jars: 6, amount: 1000 });
  const firstUpsaleImport = await postLineEvent(`line-upsale-first-${uniqueSuffix}`, firstUpsaleText, `reply-first-${uniqueSuffix}`);
  if (firstUpsaleImport.status !== 200 || JSON.parse(firstUpsaleImport.text).parsedOrders !== 1) {
    fail(`first UPSALE baseline order was not imported: ${firstUpsaleImport.status} ${firstUpsaleImport.text}`);
  }
  let upsaleState = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  let upsaleOrders = upsaleState.orders.filter(order => order.orderNumber === upsaleOrderNumber && order.phone === upsalePhone);
  if (upsaleOrders.length !== 1 || upsaleOrders[0].jars !== 6 || upsaleOrders[0].amount !== 1000) {
    fail(`first UPSALE baseline order state is wrong: ${JSON.stringify(upsaleOrders)}`);
  }
  let acnaAfterFirstUpsale = Number(upsaleState.settings.products.find(product => product.id === savedAcna.id)?.stockQuantity);
  if (acnaAfterFirstUpsale !== acnaStockBeforeUpsale - 6) {
    fail(`first UPSALE baseline stock did not deduct 6: before=${acnaStockBeforeUpsale} after=${acnaAfterFirstUpsale}`);
  }

  const updatedUpsaleText = upsaleLineText({
    jars: 13,
    amount: 1800,
    gift: "Mesh Bag",
    note: "Updated",
    symptoms: "ปวดเข่า, นอนไม่หลับ"
  });
  const upsaleUpdate = await postLineEvent(`line-upsale-update-${uniqueSuffix}`, updatedUpsaleText, `reply-update-${uniqueSuffix}`);
  if (upsaleUpdate.status !== 200 || JSON.parse(upsaleUpdate.text).parsedOrders !== 1) {
    fail(`UPSALE update was not accepted: ${upsaleUpdate.status} ${upsaleUpdate.text}`);
  }
  upsaleState = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  upsaleOrders = upsaleState.orders.filter(order => order.orderNumber === upsaleOrderNumber && order.phone === upsalePhone);
  if (upsaleOrders.length !== 1 || upsaleOrders[0].jars !== 13 || upsaleOrders[0].amount !== 1800 || upsaleOrders[0].freeGift !== "Mesh Bag" || upsaleOrders[0].note !== "Updated") {
    fail(`UPSALE update did not update the existing order: ${JSON.stringify(upsaleOrders)}`);
  }
  const acnaAfterUpsaleUpdate = Number(upsaleState.settings.products.find(product => product.id === savedAcna.id)?.stockQuantity);
  if (acnaAfterUpsaleUpdate !== acnaStockBeforeUpsale - 13) {
    fail(`UPSALE stock should deduct only the quantity delta: before=${acnaStockBeforeUpsale} after=${acnaAfterUpsaleUpdate}`);
  }
  const upsaleReplyText = lineReplies.at(-1)?.messages?.[0]?.text || "";
  if (
    !upsaleReplyText.includes("✅ Updated Upsell Order Successfully")
    || !upsaleReplyText.includes("Order No.:")
    || !upsaleReplyText.includes("📦 Quantity")
    || !upsaleReplyText.includes("6 → 13 (+7)")
    || !upsaleReplyText.includes("💰 Amount")
    || !upsaleReplyText.includes("1,000 → 1,800 (+800)")
    || !upsaleReplyText.includes("📈 Extra Sales")
    || !upsaleReplyText.includes("• +800")
    || !upsaleReplyText.includes("🎁 Gift")
    || !upsaleReplyText.includes("None → Mesh Bag")
    || !upsaleReplyText.includes("📝 Note")
    || !upsaleReplyText.includes("• Updated")
    || upsaleReplyText.includes("🏠 Shipping Address")
    || upsaleReplyText.includes("🏷️ Customer Symptoms")
    || upsaleReplyText.includes("💳 VIP Status")
    || upsaleReplyText.includes("🛒 Sales Channel")
  ) {
    fail(`UPSALE reply did not include only changed fields: ${JSON.stringify(upsaleReplyText)}`);
  }

  const duplicateUpsaleDelivery = await postLineEvent(`line-upsale-update-${uniqueSuffix}`, updatedUpsaleText, `reply-duplicate-${uniqueSuffix}`);
  if (duplicateUpsaleDelivery.status !== 200 || JSON.parse(duplicateUpsaleDelivery.text).parsedOrders !== 0) {
    fail(`duplicate LINE delivery should be ignored: ${duplicateUpsaleDelivery.status} ${duplicateUpsaleDelivery.text}`);
  }
  upsaleState = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  upsaleOrders = upsaleState.orders.filter(order => order.orderNumber === upsaleOrderNumber && order.phone === upsalePhone);
  if (upsaleOrders.length !== 1) fail(`duplicate LINE delivery created an order: ${JSON.stringify(upsaleOrders)}`);
  const acnaAfterDuplicateDelivery = Number(upsaleState.settings.products.find(product => product.id === savedAcna.id)?.stockQuantity);
  if (acnaAfterDuplicateDelivery !== acnaAfterUpsaleUpdate) {
    fail("duplicate LINE delivery changed stock");
  }

  const staleTimestamp = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
  const tempDb = JSON.parse(fs.readFileSync(process.env.JSON_DB_PATH, "utf8"));
  const staleOrder = tempDb.orders.find(order => order.orderNumber === upsaleOrderNumber && order.phone === upsalePhone);
  if (!staleOrder) fail("could not find UPSALE order to age beyond 24 hours");
  staleOrder.createdAt = staleTimestamp;
  staleOrder.updatedAt = staleTimestamp;
  fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(tempDb, null, 2)}\n`, "utf8");

  const staleWindowImport = await postLineEvent(`line-upsale-stale-${uniqueSuffix}`, upsaleLineText({ jars: 15, amount: 2000, note: "New after 24h" }), `reply-stale-${uniqueSuffix}`);
  if (staleWindowImport.status !== 200 || JSON.parse(staleWindowImport.text).parsedOrders !== 1) {
    fail(`same order number after 24h should import as new: ${staleWindowImport.status} ${staleWindowImport.text}`);
  }
  upsaleState = JSON.parse((await request("/api/state", { headers: { cookie } })).text);
  upsaleOrders = upsaleState.orders.filter(order => order.orderNumber === upsaleOrderNumber && order.phone === upsalePhone);
  if (upsaleOrders.length !== 2 || !upsaleOrders.some(order => order.jars === 15 && order.amount === 2000)) {
    fail(`same order number after 24h did not create a new order: ${JSON.stringify(upsaleOrders)}`);
  }
  const acnaAfterStaleImport = Number(upsaleState.settings.products.find(product => product.id === savedAcna.id)?.stockQuantity);
  if (acnaAfterStaleImport !== acnaStockBeforeUpsale - 28) {
    fail(`new order after 24h should deduct full new quantity: before=${acnaStockBeforeUpsale} after=${acnaAfterStaleImport}`);
  }
  global.fetch = originalFetch;
  if (originalLineAccessToken === undefined) delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  else process.env.LINE_CHANNEL_ACCESS_TOKEN = originalLineAccessToken;

  const oldLinePreview = await request("/api/parse-preview", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      content: [
        `เลขออเดอร์ : OLD-${uniqueSuffix}`,
        "วันที่ซื้อ : 3/7/2569",
        "ช่องทางการสั่งซื้อ : LINE",
        "Facebook / LINE ลูกค้า :",
        "",
        "ชื่อลูกค้า : ลูกค้าเดิม",
        "เบอร์โทร : 0821234567",
        "ที่อยู่จัดส่ง : กรุงเทพฯ",
        "จำนวนกระปุก : 2",
        "ยอดซื้อ : 1,500 บาท"
      ].join("\n")
    })
  });
  if (oldLinePreview.status !== 200) fail(`legacy LINE format preview returned ${oldLinePreview.status}`);
  const oldLineRow = JSON.parse(oldLinePreview.text).rows?.[0];
  if (!oldLineRow || oldLineRow.orderNumber !== `OLD-${uniqueSuffix}` || oldLineRow.items) {
    fail("legacy LINE format without สินค้า is no longer compatible");
  }
  if (oldLineRow.jars !== 2) {
    fail(`legacy LINE quantity label did not parse จำนวนกระปุก: ${JSON.stringify(oldLineRow)}`);
  }
  if (oldLineRow.socialName) fail("blank LINE field consumed the next Thai label");

  const duplicateBase = {
    orderNumber: `DUP-BASE-${uniqueSuffix}-001`,
    items: "Zomin Plus",
    name: "  Somchai   Dee  ",
    phone: `089-111-${uniqueSuffix}`,
    address: ` 123/4   Bangkok ${uniqueSuffix} `,
    date: nowInBangkok.date,
    time: nowInBangkok.time,
    jars: 2,
    amount: 1500,
    lineMessageId: "line-msg-a"
  };
  const firstOrder = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(duplicateBase)
  });
  if (firstOrder.status !== 200) fail(`first duplicate-check order returned ${firstOrder.status}: ${firstOrder.text}`);
  if (JSON.parse(firstOrder.text).mutation?.order?.items !== "Zomin Plus") {
    fail("product was not saved into the order record");
  }

  const differentAmount = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...duplicateBase,
      orderNumber: `DUP-BASE-${uniqueSuffix}-002`,
      amount: 1600,
      lineMessageId: "line-msg-b"
    })
  });
  if (differentAmount.status !== 200) {
    fail(`different amount should import normally, got ${differentAmount.status}: ${differentAmount.text}`);
  }

  const exactDuplicate = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      ...duplicateBase,
      orderNumber: `DUP-BASE-${uniqueSuffix}-003`,
      name: "somchai dee",
      phone: `089111${uniqueSuffix}`,
      address: `123/4 bangkok ${uniqueSuffix}`,
      lineMessageId: "line-msg-c"
    })
  });
  if (exactDuplicate.status !== 409) {
    fail(`exact duplicate should be blocked, got ${exactDuplicate.status}: ${exactDuplicate.text}`);
  }

  console.log("Smoke test passed.");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
