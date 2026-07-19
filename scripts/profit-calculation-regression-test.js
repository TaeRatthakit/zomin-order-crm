const { Readable } = require("stream");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { hashPassword } = require("../lib/auth");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-profit-regression-${process.pid}.json`);

const product = {
  id: "product_zomin",
  name: "Zomin",
  sku: "ZOMIN",
  salePrice: 280,
  costPerItem: 47,
  stockQuantity: 1000,
  status: "พร้อมขาย",
  salesPackages: [
    {
      id: "package_4_free_2",
      name: "แพ็กเกจ 4 แถม 2",
      paidQuantity: 4,
      freeQuantity: 2,
      totalQuantityShipped: 6,
      salePrice: 1000,
      enabled: true,
      expenses: [
        { id: "box", name: "ค่ากล่อง", amount: 1.6, enabled: true },
        { id: "shipping", name: "ค่าส่ง", amount: 16, enabled: true },
        { id: "disabled", name: "ปิดไว้", amount: 999, enabled: false }
      ]
    }
  ]
};

const fixture = {
  notificationReads: [],
  settings: {
    businessName: "Growup Pilot",
    defaultJarPrice: 280,
    products: [product],
    productCosts: [{ id: product.id, name: product.name, costPerJar: 47, enabled: true }],
    additionalCosts: [{ id: "cod", name: "ค่า COD", amount: 2, type: "percent_sales", enabled: true }],
    adCostRecords: []
  },
  followUpRules: [{ jars: 1, days: 15 }],
  tags: [],
  users: [{
    id: "u_owner",
    username: "admin",
    passwordHash: hashPassword("admin123"),
    name: "Owner",
    role: "Owner",
    active: true
  }],
  customers: [],
  orders: [],
  contactLogs: [],
  lineMessages: []
};

fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

const appHandler = require("../server");

function fail(message) {
  throw new Error(`Profit calculation regression failed: ${message}`);
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const req = Readable.from(body ? [body] : []);
    req.method = options.method || "GET";
    req.url = url;
    req.headers = { host: "127.0.0.1", ...(options.headers || {}) };
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
        resolve({ status: this.statusCode, headers: this.headers, text: Buffer.concat(chunks).toString("utf8") });
      }
    };
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] || "";
}

function almostEqual(actual, expected, label) {
  if (Math.abs(Number(actual) - expected) > 0.000001) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

function loadClientProfitHelpers() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const names = [
    "normalizeProductName",
    "normalizeProductCostEntries",
    "productCostForOrder",
    "moneyMatches",
    "salesPackageForOrder",
    "packageExpensesForOrder",
    "packageExpenseTotalForOrder",
    "normalizeAdditionalCostEntries",
    "additionalCostBreakdownForOrders",
    "additionalCostTotalForOrders",
    "hasOrderProfitSnapshot",
    "fallbackProfitForOrder",
    "profitForOrder",
    "profitBreakdownForOrders",
    "normalizePackageExpenses",
    "normalizeSalesPackages",
    "normalizeProductRecords"
  ];
  const start = source.indexOf("function normalizeProductName");
  const end = source.indexOf("const DEFAULT_AD_PLATFORMS");
  const packageStart = source.indexOf("function normalizePackageExpenses");
  const packageEnd = source.indexOf("function productStatsMap");
  if (start === -1 || end === -1 || end <= start || packageStart === -1 || packageEnd === -1 || packageEnd <= packageStart) {
    fail("client profit helper slice not found");
  }
  const context = {
    app: { data: { orders: [], settings: {} } },
    normalizeProductImageSource: value => String(value || ""),
    console
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\n${source.slice(packageStart, packageEnd)}\nObject.assign(globalThis, { ${names.join(", ")} });`, context);
  return context;
}

(async () => {
  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) fail(`login returned ${login.status}`);
  const cookie = header(login.headers, "set-cookie");

  const create = await request("/api/orders", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      productId: product.id,
      items: product.name,
      name: "Profit Test",
      phone: "0800000000",
      address: "Bangkok",
      date: "2026-07-20",
      time: "09:00",
      jars: 6,
      amount: 1000,
      sourceChannel: "Facebook"
    })
  });
  if (create.status !== 200) fail(`order create returned ${create.status}: ${create.text}`);

  const state = JSON.parse((await request("/api/state?date=2026-07-20", { headers: { cookie } })).text);
  const order = state.orders.find(row => row.customerName === "Profit Test");
  if (!order) fail("created order not found in state");
  if (order.packageId !== "package_4_free_2") fail("order did not infer package");
  almostEqual(order.revenueSnapshot, 1000, "revenue snapshot");
  almostEqual(order.productCostSnapshot, 282, "free-item quantity included in product cost");
  almostEqual(order.packageExpenseSnapshot, 17.6, "package cost calculated once and disabled package cost excluded");
  almostEqual(order.globalExpenseSnapshot, 20, "percentage COD cost calculated once from revenue");
  almostEqual(order.profitBeforeAdsSnapshot, 680.4, "canonical net profit before ads");

  const marketing = JSON.parse((await request("/api/marketing-performance?date=2026-07-20", { headers: { cookie } })).text);
  almostEqual(marketing.performance.profitBeforeAds, 680.4, "server report profit consistency");

  const helpers = loadClientProfitHelpers();
  helpers.app.data.settings = state.settings;
  helpers.app.data.orders = state.orders;
  const legacyOrder = {
    ...order,
    packageId: "",
    packageName: "",
    paidQuantity: 0,
    freeQuantity: 0,
    totalQuantityShipped: 0,
    packageExpenses: [],
    packageExpenseSnapshot: 0,
    profitBeforeAdsSnapshot: 698,
    profitAfterAdsSnapshot: 698
  };
  for (const [label, breakdown] of [
    ["dashboard", helpers.profitBreakdownForOrders([legacyOrder], state.settings)],
    ["reports", helpers.profitBreakdownForOrders([legacyOrder], state.settings)],
    ["product summary", helpers.profitBreakdownForOrders([legacyOrder], state.settings)],
    ["all-time summary", helpers.profitBreakdownForOrders([legacyOrder], state.settings)]
  ]) {
    almostEqual(breakdown.sales, 1000, `${label} revenue`);
    almostEqual(breakdown.productCosts, 282, `${label} product cost`);
    almostEqual(breakdown.packageExpenses, 17.6, `${label} package cost`);
    almostEqual(breakdown.globalAdditionalCosts, 20, `${label} COD cost`);
    almostEqual(breakdown.profitBeforeAds, 680.4, `${label} profit consistency`);
  }

  console.log("Profit calculation regression passed");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
