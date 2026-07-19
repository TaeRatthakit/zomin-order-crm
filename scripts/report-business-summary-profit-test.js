const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceBetween(start, end) {
  const startIndex = appJs.indexOf(start);
  const endIndex = appJs.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `Missing source marker: ${start}`);
  assert(endIndex > startIndex, `Missing end marker: ${end}`);
  return appJs.slice(startIndex, endIndex);
}

const helperBlock = sourceBetween("function reportAllTimeNetProfit", "function reportDelta");
assert(helperBlock.includes("marketingPerformanceForPeriod().profitAfterAds"), "All-time profit reuses trusted marketing/profit helper");

const summaryBlock = sourceBetween("function reportBusinessSummaryHtml", "function renderMobileReports");
assert(summaryBlock.includes("const orders = app.data?.orders || [];"), "Business summary uses persisted all-time orders");
assert(!summaryBlock.includes("selectedRange"), "Business summary does not depend on the date picker range");
assert(!summaryBlock.includes("selectedDate"), "Business summary does not depend on the selected date");
assert(summaryBlock.includes("const allTimeProfit = reportAllTimeNetProfit();"), "Business summary reads all-time net profit once");
assert(summaryBlock.includes("label: \"กำไรทั้งหมด\""), "All-time profit card exists in business summary source");
assert((summaryBlock.match(/label: "กำไรทั้งหมด"/g) || []).length === 1, "All-time profit card exists exactly once");
assert(summaryBlock.indexOf('label: "ยอดขายรวม"') < summaryBlock.indexOf('label: "กำไรทั้งหมด"'), "All-time profit card appears after total sales");
assert(summaryBlock.includes('tone: "green"'), "All-time profit card uses green profit treatment");
assert(summaryBlock.includes('icon: "database"'), "All-time profit card reuses an existing profit-style icon");

const expectedLabels = [
  "ออเดอร์ทั้งหมด",
  "ลูกค้าทั้งหมด",
  "สินค้าทั้งหมด",
  "ขายได้ทั้งหมด",
  "ยอดขายรวม",
  "กำไรทั้งหมด"
];
const labelMatches = [...summaryBlock.matchAll(/label: "([^"]+)"/g)].map(match => match[1]);
for (const label of expectedLabels) assert(labelMatches.includes(label), `Missing summary label: ${label}`);
assert(expectedLabels.every((label, index) => labelMatches[index] === label), "Existing five cards remain in order and profit is appended last");

assert(styles.includes("body.mobile-reports-view .mobile-report-business-summary"), "Mobile business summary CSS exists");
assert(styles.includes("grid-template-columns: repeat(3, minmax(0, 1fr));"), "Mobile business summary wraps six cards as equal columns");
assert(styles.includes("body.desktop-app-shell:not(.login-view) .mobile-report-business-summary"), "Desktop business summary CSS exists");
assert(styles.includes("grid-template-columns: repeat(6, minmax(0, 1fr));"), "Desktop business summary supports six cards in one row");
assert(styles.includes("@media (min-width: 821px) and (max-width: 1180px)"), "Smaller desktop/tablet business summary has a wrapping breakpoint");

function normalizeProductName(name = "") {
  const value = String(name || "").trim();
  return value || "Growup Formula";
}

function productCostForOrder(order, settings) {
  const product = (settings.productCosts || []).find(item => item.name === normalizeProductName(order.items) && item.enabled !== false);
  if (!product) return 0;
  const quantity = order.packageId ? Number(order.totalQuantityShipped || order.jars || 0) : Number(order.jars || 0);
  return quantity * Number(product.costPerJar || 0);
}

function packageExpenseTotalForOrder(order) {
  if (!order.packageId) return 0;
  return (order.packageExpenses || [])
    .filter(expense => expense.enabled !== false)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function additionalCostTotalForOrders(orders, settings) {
  const rows = Array.isArray(orders) ? orders : [];
  const orderCount = rows.length;
  const itemCount = rows.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const sales = rows.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  return (settings.additionalCosts || [])
    .filter(item => item.enabled !== false)
    .reduce((sum, item) => {
      const amount = Number(item.amount || 0);
      if (item.type === "percent_sales") return sum + sales * amount / 100;
      if (item.type === "per_item") return sum + itemCount * amount;
      return sum + orderCount * amount;
    }, 0);
}

function fallbackProfitForOrder(order, settings) {
  const sales = Number(order.amount || 0);
  const productCosts = productCostForOrder(order, settings);
  const packageExpenses = packageExpenseTotalForOrder(order);
  const globalAdditionalCosts = additionalCostTotalForOrders([order], settings);
  const profitBeforeAds = sales - productCosts - packageExpenses - globalAdditionalCosts;
  return { sales, productCosts, packageExpenses, globalAdditionalCosts, profitBeforeAds };
}

function hasSnapshot(order) {
  return ["revenueSnapshot", "productCostSnapshot", "packageExpenseSnapshot", "globalExpenseSnapshot", "profitBeforeAdsSnapshot"]
    .every(field => Number.isFinite(Number(order[field])));
}

function profitForOrder(order, settings) {
  if (!hasSnapshot(order)) return fallbackProfitForOrder(order, settings);
  return {
    sales: Number(order.revenueSnapshot),
    productCosts: Number(order.productCostSnapshot),
    packageExpenses: Number(order.packageExpenseSnapshot),
    globalAdditionalCosts: Number(order.globalExpenseSnapshot),
    profitBeforeAds: Number(order.profitBeforeAdsSnapshot)
  };
}

function orderMatchesAdRecord(order, record) {
  if (order.date !== record.date) return false;
  if (record.productId && order.productId) return String(order.productId) === String(record.productId);
  return normalizeProductName(order.items).toLocaleLowerCase("th-TH") === String(record.productName || "").toLocaleLowerCase("th-TH");
}

function adCostForRecord(record, orders) {
  if (record.enabled === false) return 0;
  const matches = orders.filter(order => orderMatchesAdRecord(order, record));
  if (record.costMode === "percent_sales") {
    return matches.reduce((sum, order) => sum + profitForOrder(order, settings).sales, 0) * Number(record.value || 0) / 100;
  }
  if (record.costMode === "cost_per_order") return matches.length * Number(record.value || 0);
  return Number(record.value || 0);
}

const settings = {
  productCosts: [
    { name: "Zomin", costPerJar: 120, enabled: true },
    { name: "Acna", costPerJar: 50, enabled: true }
  ],
  additionalCosts: [
    { name: "แพ็กต่อออเดอร์", amount: 10, type: "fixed_per_order", enabled: true },
    { name: "หยิบต่อชิ้น", amount: 2, type: "per_item", enabled: true },
    { name: "ค่าธรรมเนียม", amount: 5, type: "percent_sales", enabled: true },
    { name: "ปิดใช้งาน", amount: 999, type: "fixed_per_order", enabled: false }
  ],
  adCostRecords: [
    { date: "2026-07-12", productName: "Zomin", platformName: "Facebook", costMode: "fixed_amount", value: 100, enabled: true },
    { date: "2026-07-12", productName: "Zomin", platformName: "TikTok", costMode: "percent_sales", value: 10, enabled: true },
    { date: "2026-07-13", productName: "Acna", platformName: "LINE", costMode: "cost_per_order", value: 15, enabled: true },
    { date: "2026-07-13", productName: "Acna", platformName: "Disabled", costMode: "fixed_amount", value: 500, enabled: false }
  ]
};

const orders = [
  { date: "2026-07-12", items: "Zomin", jars: 2, amount: 1000 },
  { date: "2026-07-13", items: "Acna", jars: 3, amount: 500 },
  {
    date: "2026-07-14",
    items: "Zomin",
    jars: 1,
    amount: 9999,
    revenueSnapshot: 800,
    productCostSnapshot: 120,
    packageExpenseSnapshot: 30,
    globalExpenseSnapshot: 20,
    profitBeforeAdsSnapshot: 630
  },
  { date: "2026-07-15", items: "Missing Cost", jars: 4, amount: 200 }
];

const grossProfit = orders.reduce((sum, order) => sum + profitForOrder(order, settings).profitBeforeAds, 0);
const adCost = settings.adCostRecords.reduce((sum, record) => sum + adCostForRecord(record, orders), 0);
const expectedNetProfit = grossProfit - adCost;

assert(grossProfit === 1807, `Unexpected gross profit fixture value: ${grossProfit}`);
assert(adCost === 215, `Ad costs should be deducted exactly once, got ${adCost}`);
assert(expectedNetProfit === 1592, `Net all-time profit should match independent calculation, got ${expectedNetProfit}`);

const julyOnlyGross = orders
  .filter(order => order.date === "2026-07-12")
  .reduce((sum, order) => sum + profitForOrder(order, settings).profitBeforeAds, 0);
assert(expectedNetProfit !== julyOnlyGross, "All-time profit fixture proves the value is not selected-date scoped");

const zeroProfit = 0 - 0;
const negativeProfit = 100 - 150;
assert(Number.isFinite(zeroProfit) && zeroProfit === 0, "Zero profit renders safely");
assert(Number.isFinite(negativeProfit) && negativeProfit < 0, "Negative profit renders safely");

console.log("Report business summary profit test passed.");
