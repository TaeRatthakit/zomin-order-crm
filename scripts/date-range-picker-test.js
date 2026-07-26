const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

function sourceBetween(startToken, endToken) {
  const start = appJs.indexOf(startToken);
  const end = appJs.indexOf(endToken, start + startToken.length);
  assert(start >= 0 && end > start, `source block exists for ${startToken}`);
  return appJs.slice(start, end);
}

function addDaysISO(dateValue, amount) {
  const [year, month, day] = String(dateValue).split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + Number(amount || 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfMonthISO(dateValue) {
  return `${String(dateValue).slice(0, 8)}01`;
}

function endOfMonthISO(dateValue) {
  const [year, month] = String(dateValue).split("-").map(Number);
  const date = new Date(year, month, 0, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function presetRange(key, today) {
  if (key === "today") return { start: today, end: today };
  if (key === "yesterday") return { start: addDaysISO(today, -1), end: addDaysISO(today, -1) };
  if (key === "today-yesterday") return { start: addDaysISO(today, -1), end: today };
  if (key === "last-7") return { start: addDaysISO(today, -6), end: today };
  if (key === "last-14") return { start: addDaysISO(today, -13), end: today };
  if (key === "last-30") return { start: addDaysISO(today, -29), end: today };
  if (key === "last-90") return { start: addDaysISO(today, -89), end: today };
  if (key === "this-month") return { start: startOfMonthISO(today), end: today };
  if (key === "last-month") {
    const [year, month] = today.split("-").map(Number);
    const previous = new Date(year, month - 2, 1, 12);
    const start = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-01`;
    return { start, end: endOfMonthISO(start) };
  }
  if (key === "this-year") return { start: `${today.slice(0, 4)}-01-01`, end: today };
  if (key === "last-year") return { start: `${Number(today.slice(0, 4)) - 1}-01-01`, end: `${Number(today.slice(0, 4)) - 1}-12-31` };
  throw new Error(`Unknown preset ${key}`);
}

function normalizeDateRange(start, end) {
  const first = start || end || "2026-07-17";
  const last = end || start || first;
  return first <= last ? { start: first, end: last } : { start: last, end: first };
}

function dateRangeKey(range) {
  const normalized = normalizeDateRange(range.start, range.end);
  return `${normalized.start}..${normalized.end}`;
}

function previousPeriodRange(range) {
  const normalized = normalizeDateRange(range.start, range.end);
  const days = Math.max(1, Math.round((new Date(`${normalized.end}T12:00:00+07:00`) - new Date(`${normalized.start}T12:00:00+07:00`)) / 86400000) + 1);
  const compareEnd = addDaysISO(normalized.start, -1);
  return { start: addDaysISO(compareEnd, -(days - 1)), end: compareEnd };
}

function reportSummaryHeadingForTest(range, today = "2026-07-17") {
  const normalized = normalizeDateRange(range.start, range.end);
  const yesterday = addDaysISO(today, -1);
  if (normalized.start === today && normalized.end === today) return "สรุปวันนี้";
  if (normalized.start === yesterday && normalized.end === yesterday) return "สรุปเมื่อวาน";
  if (normalized.start === normalized.end) return `สรุปวันที่ ${normalized.start}`;
  return `สรุปช่วงนี้ (${normalized.start}–${normalized.end})`;
}

function reportRangeComparisonHintForTest(range, today = "2026-07-17") {
  const normalized = normalizeDateRange(range.start, range.end);
  if (normalized.start !== normalized.end) return "เทียบกับช่วงก่อนหน้า";
  return normalized.start === today ? "เทียบกับเมื่อวาน" : "เทียบกับวันก่อนหน้า";
}

function dashboardKpiTitlesForRangeForTest(range, today = "2026-07-17") {
  const normalized = normalizeDateRange(range.start, range.end);
  const yesterday = addDaysISO(today, -1);
  const suffix = normalized.start === today && normalized.end === today
    ? "วันนี้"
    : normalized.start === yesterday && normalized.end === yesterday
      ? "เมื่อวาน"
      : normalized.start === startOfMonthISO(today) && normalized.end === today
        ? "เดือนนี้"
        : "ช่วงนี้";
  return {
    sales: `ยอดขาย${suffix}`,
    orders: `ออเดอร์${suffix}`,
    profit: `กำไร${suffix}`,
    units: `ขายได้${suffix}`
  };
}

function bangkokDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (text.includes("T")) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(date).reduce((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
  return text.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || "";
}

function dateInRange(value, range) {
  const date = bangkokDateOnly(value);
  const normalized = normalizeDateRange(range.start, range.end);
  return date >= normalized.start && date <= normalized.end;
}

function aggregateOrders(orders, range) {
  const rangeOrders = orders.filter(order => dateInRange(order.date, range));
  const channelMap = new Map();
  const productMap = new Map();
  for (const order of rangeOrders) {
    const channel = order.channel || "อื่นๆ";
    channelMap.set(channel, (channelMap.get(channel) || 0) + Number(order.amount || 0));
    const product = order.items || "สินค้า";
    productMap.set(product, (productMap.get(product) || 0) + Number(order.jars || 0));
  }
  return {
    salesToday: rangeOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    ordersToday: rangeOrders.length,
    jarsToday: rangeOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    customers: new Set(rangeOrders.map(order => order.customerId)).size,
    channels: [...channelMap.entries()],
    products: [...productMap.entries()]
  };
}

function marketingPerformanceForRangeForTest(orders, adRecords, range) {
  const rangeOrders = orders.filter(order => dateInRange(order.date, range));
  const records = adRecords.filter(record => record.enabled !== false && dateInRange(record.date, range));
  const sales = rangeOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const profitBeforeAds = rangeOrders.reduce((sum, order) => sum + Number(order.profitBeforeAds ?? order.amount ?? 0), 0);
  const adCost = records.reduce((sum, record) => sum + Number(record.cost || 0), 0);
  return {
    sales,
    orders: rangeOrders.length,
    profitBeforeAds,
    units: rangeOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    adCost,
    profitAfterAds: profitBeforeAds - adCost,
    roas: adCost ? sales / adCost : 0
  };
}

function cloneDateRangeStateForTest(range) {
  return {
    start: range.start || "2026-07-17",
    end: Object.prototype.hasOwnProperty.call(range, "end") ? range.end : (range.start || "2026-07-17")
  };
}

const expectedPresetOrder = [
  "วันนี้",
  "เมื่อวานนี้",
  "วันนี้และเมื่อวานนี้",
  "7 วันที่ผ่านมา",
  "14 วันที่ผ่านมา",
  "30 วันที่ผ่านมา",
  "90 วันที่ผ่านมา",
  "เดือนนี้",
  "เดือนที่แล้ว",
  "ปีนี้",
  "ปีที่แล้ว",
  "ตั้งแต่เปิดร้าน (ทั้งหมด)",
  "กำหนดเอง"
];

const presetBlock = appJs.match(/const DATE_RANGE_PRESETS = \[([\s\S]*?)\];/)?.[1] || "";
let lastIndex = -1;
for (const label of expectedPresetOrder) {
  const index = presetBlock.indexOf(`label: "${label}"`);
  assert(index > lastIndex, `preset order includes ${label}`);
  lastIndex = index;
}

assert(!presetBlock.includes("สัปดาห์นี้"), "does not include this-week preset");
assert(!presetBlock.includes("สัปดาห์ที่แล้ว"), "does not include last-week preset");
assert(appJs.includes('timeZone: "Asia/Bangkok"'), "Bangkok timezone is used for date labels/today");
assert(appJs.includes("function parseDateOnlyParts"), "date-only parser avoids UTC Date parsing");
assert(appJs.includes("function bangkokDateOnly"), "Bangkok date-only normalizer exists for timestamp orders");
assert(appJs.includes("function dateInRange"), "shared inclusive date range helper exists");
assert(appJs.includes("function ordersInDateRange"), "shared range order filter exists");
assert(appJs.includes("function labelForDateRangeTrigger"), "trigger has a readable selected date/range label");
assert(appJs.includes("function dashboardKpiTitlesForRange"), "home KPI titles are derived from applied date range");
assert(appJs.includes("formatDatePillGregorian"), "trigger label uses Gregorian display dates");
assert(appJs.includes("rangeKey: summaryRangeKey"), "summary cache key includes start and end range");
assert(appJs.includes('Object.prototype.hasOwnProperty.call(range, "end")'), "custom range draft preserves empty end while selecting");
assert(appJs.includes("syncComparisonDraft"), "comparison state is calculated locally");
assert(appJs.includes("previousPeriodRange"), "previous period comparison exists");
assert(appJs.includes("applyDateRangeDraft"), "apply handler exists");
assert(appJs.includes("closeDateRangePicker"), "cancel/close handler exists");
assert(appJs.includes("opened without API request"), "picker open measurement logs no API request path");
assert(!sourceBetween("function openDateRangePicker()", "function closeDateRangePicker").includes("loadState("), "opening picker does not call loadState");
assert(!sourceBetween("function chooseDateRangePreset", "function chooseRangeDate").includes("loadState("), "selecting preset does not call loadState");
assert(!sourceBetween("function chooseRangeDate", "function applyDateRangeDraft").includes("loadState("), "selecting calendar date does not call loadState");
assert(sourceBetween("function applyDateRangeDraft", "function updateShell").includes("buildLocalSummary(applied.end, applied)"), "apply passes full range to dashboard summary");
assert(sourceBetween("function buildLocalSummary", "function syncDomTree").includes("ordersInDateRange(app.data.orders, summaryRange)"), "summary aggregates multi-day orders inclusively");
assert(sourceBetween("function renderReports", "function renderAiInsights").includes("renderMobileReports(selectedDate, selectedMonth, selectedRange)"), "reports passes applied range into shared report renderer");
assert(sourceBetween("function renderMobileReports", "const customerIds").includes("ordersInDateRange(orders, summaryRange)"), "reports top summary uses selected range orders");
assert(sourceBetween("function renderMobileReports", "const customerIds").includes("previousPeriodRange(summaryRange)"), "reports top summary comparison uses equal previous period");
assert(sourceBetween("function renderMobileReports", "const monthCards").includes("marketingPerformanceForPeriod({ range: summaryRange })"), "reports marketing KPIs use selected range");
assert(sourceBetween("function renderMobileReports", "const customerIds").includes("Number(breakdown.sales || 0) - Number(breakdown.profitBeforeAds || 0)"), "reports cost KPI reuses gross-profit breakdown formula");
assert(sourceBetween("function renderMobileReports", "const customerIds").includes("const showReportCostCards = true"), "reports cost KPI shows on every viewport and theme");
assert(sourceBetween("function renderMobileReports", "const monthCards").includes("ต้นทุน${rangeSuffix}"), "reports selected-range cost KPI exists before ad cost");
assert(sourceBetween("const todayCards = [", "const monthCards = [").indexOf("ต้นทุน${rangeSuffix}") < sourceBetween("const todayCards = [", "const monthCards = [").indexOf("ค่าโฆษณา${rangeSuffix}"), "reports selected-range cost KPI appears before ad cost");
assert(sourceBetween("const monthCards = [", "els.content.innerHTML").includes("ต้นทุนเดือนนี้"), "reports month cost KPI exists before ad cost");
assert(sourceBetween("const monthCards = [", "els.content.innerHTML").indexOf("ต้นทุนเดือนนี้") < sourceBetween("const monthCards = [", "els.content.innerHTML").indexOf("ค่าโฆษณาเดือนนี้"), "reports month cost KPI appears before ad cost");
assert(sourceBetween("function reportBusinessSummaryHtml", "function renderMobileReports").indexOf("ต้นทุน") === -1, "reports business summary row has no cost KPI");
assert(sourceBetween("function renderMobileReports", "function renderReports").includes("reportSummaryHeading(summaryRange)"), "reports summary heading uses selected range");
assert(!sourceBetween("function renderMobileReports", "const customerIds").includes("order.date === selectedDate"), "reports top summary no longer falls back to selectedDate-only orders");
assert(!sourceBetween("function renderMobileReports", "const monthCards").includes('<h2 class=\"mobile-report-heading\">สรุปวันนี้</h2>'), "reports summary heading is not hard-coded to today");
assert(sourceBetween("function renderDashboard", "const businessManagementItems").includes("ordersInDateRange(app.data.orders, selectedRange)"), "dashboard cards use applied range orders");
assert(sourceBetween("function renderMobileDashboard", "function desktopInsightTable").includes("dashboardKpiTitlesForRange"), "mobile home KPI titles use applied range helper");
assert(sourceBetween("function renderDesktopDashboard", "function renderDashboard").includes("dashboardKpiTitlesForRange"), "desktop home KPI titles use applied range helper");
assert(!sourceBetween("function renderMobileDashboard", "function desktopInsightTable").includes('label: "ยอดขายวันนี้"'), "mobile home sales KPI title is not hard-coded to today");
assert(!sourceBetween("function renderDesktopDashboard", "function renderDashboard").includes('label: "ขายได้วันนี้"'), "desktop home units KPI title is not hard-coded to today");
assert(sourceBetween("function dashboardChannelRows", "function mobileDashboardAlertItems").includes("ordersInDateRange(app.data.orders, range)"), "mobile sales channels use applied range");
assert(sourceBetween("function desktopDashboardChannelRows", "function desktopDashboardDonutGradient").includes("ordersInDateRange(app.data.orders || [], range)"), "desktop sales channels use applied range");
assert(sourceBetween("function filteredOrdersForCurrentView", "function patchOrdersView").includes("dateInRange(order.date, selectedRange)"), "orders view uses applied range");
assert(html.includes('id="workDate" type="hidden"'), "native date input is replaced by hidden compatibility field");
assert(html.includes('id="workDateTrigger"'), "date trigger button exists");
assert(css.includes(".range-picker-overlay.is-desktop"), "desktop popover styles exist");
assert(css.includes(".range-picker-overlay.is-mobile"), "mobile bottom sheet styles exist");
assert(css.includes(".mobile-report-kpi-grid.report-kpi-grid-with-cost"), "reports cost KPI grid has scoped 8-card class");
assert(css.includes("repeat(8, minmax(0, 1fr))"), "desktop reports cost KPI grid keeps 8 equal columns");
assert(css.includes("body.mobile-reports-view .mobile-report-kpi.tone-orange"), "mobile reports cost KPI has orange treatment");
assert(css.includes("body.desktop-app-shell:not(.login-view) .mobile-report-kpi.tone-orange"), "desktop dark reports cost KPI has orange treatment");
assert(css.includes("html[data-theme=\"light\"] body:not(.login-view) .mobile-report-kpi.tone-orange"), "light reports cost KPI has soft orange treatment");
assert(css.includes("grid-template-columns: minmax(0, 1fr)"), "desktop renders one visible month column");
assert(appJs.includes("Math.min(760"), "desktop picker width is reduced");
assert(css.includes("@media (max-width: 768px)"), "mobile responsive rules exist");
assert(css.includes("position: sticky") && css.includes(".range-picker-footer"), "mobile action footer is sticky");
assert(css.includes("prefers-reduced-motion"), "reduced motion is respected");
assert(appJs.includes('draft.preset === "custom"'), "mobile calendar is lazy-rendered for custom selection");
assert(appJs.includes("ignoreNextPopstate"), "cancel/back close does not trigger route refresh");

const checks = [
  ["last-7", "2026-07-16", "2026-07-10", "2026-07-16"],
  ["last-14", "2026-01-03", "2025-12-21", "2026-01-03"],
  ["last-30", "2026-03-01", "2026-01-31", "2026-03-01"],
  ["last-90", "2026-01-01", "2025-10-04", "2026-01-01"],
  ["last-month", "2026-01-16", "2025-12-01", "2025-12-31"],
  ["this-month", "2026-07-16", "2026-07-01", "2026-07-16"],
  ["last-year", "2026-07-16", "2025-01-01", "2025-12-31"]
];

for (const [key, today, start, end] of checks) {
  const range = presetRange(key, today);
  assert(range.start === start && range.end === end, `${key} boundary for ${today}`);
}

const today = "2026-07-17";
const yesterday = "2026-07-16";
const sampleOrders = [
  { id: "today-1", date: today, amount: 100, jars: 1, customerId: "c1", channel: "LINE", items: "A" },
  { id: "yesterday-1", date: yesterday, amount: 80, jars: 2, customerId: "c2", channel: "Facebook", items: "B" },
  { id: "end-late", date: "2026-07-17T23:59:59+07:00", amount: 30, jars: 3, customerId: "c1", channel: "LINE", items: "A" },
  { id: "bangkok-boundary", date: "2026-07-16T17:30:00.000Z", amount: 40, jars: 4, customerId: "c3", channel: "Shopee", items: "C" },
  { id: "cross-month", date: "2026-08-01", amount: 55, jars: 5, customerId: "c4", channel: "LINE", items: "A" },
  { id: "cross-year", date: "2027-01-01", amount: 70, jars: 6, customerId: "c5", channel: "LINE", items: "D" }
];

const todayOnly = aggregateOrders(sampleOrders, { start: today, end: today });
assert(todayOnly.salesToday === 170, "today includes date-only, late end-date, and Bangkok UTC-boundary orders");
assert(todayOnly.ordersToday === 3, "today order count includes Bangkok-normalized records");

const yesterdayOnly = aggregateOrders(sampleOrders, { start: yesterday, end: yesterday });
assert(yesterdayOnly.salesToday === 80 && yesterdayOnly.ordersToday === 1, "yesterday single-day aggregate remains correct");

const todayAndYesterday = aggregateOrders(sampleOrders, presetRange("today-yesterday", today));
assert(todayAndYesterday.salesToday === todayOnly.salesToday + yesterdayOnly.salesToday, "today and yesterday combine both days");
assert(todayAndYesterday.ordersToday === todayOnly.ordersToday + yesterdayOnly.ordersToday, "combined range order count is additive");
assert(todayAndYesterday.customers === 3, "combined range customers are deduped across relevant days");
assert(todayAndYesterday.channels.reduce((sum, [, value]) => sum + value, 0) === todayAndYesterday.salesToday, "sales channel rows total combined range");
assert(todayAndYesterday.products.reduce((sum, [, value]) => sum + value, 0) === todayAndYesterday.jarsToday, "product rows total combined range units");

const sevenDay = aggregateOrders(sampleOrders, presetRange("last-7", today));
assert(sevenDay.salesToday === todayAndYesterday.salesToday, "7-day range includes all orders in last seven days");

const customTwoDay = aggregateOrders(sampleOrders, { start: yesterday, end: today });
assert(customTwoDay.salesToday === todayAndYesterday.salesToday, "custom two-day range matches today-yesterday preset");

const crossMonth = aggregateOrders(sampleOrders, { start: "2026-07-31", end: "2026-08-01" });
assert(crossMonth.salesToday === 55 && crossMonth.ordersToday === 1, "custom cross-month range includes end month");

const crossYear = aggregateOrders(sampleOrders, { start: "2026-12-31", end: "2027-01-01" });
assert(crossYear.salesToday === 70 && crossYear.ordersToday === 1, "custom cross-year range includes end year");

assert(dateRangeKey({ start: today, end: today }) !== dateRangeKey({ start: yesterday, end: today }), "cache key separates single-day and multi-day ranges");
assert(dateInRange("2026-07-17T23:59:59+07:00", { start: today, end: today }), "late order on end date is included");
assert(dateInRange("2026-07-16T17:30:00.000Z", { start: today, end: today }), "UTC timestamp at Bangkok next-day boundary is included in Bangkok day");
assert(cloneDateRangeStateForTest({ start: "2026-07-12", end: "" }).end === "", "custom range keeps empty end until second date is selected");
assert(cloneDateRangeStateForTest({ start: "2026-07-12" }).end === "2026-07-12", "applied single-day clone still fills missing end");

const reportAdRecords = [
  { date: "2026-07-10", cost: 10 },
  { date: "2026-07-11", cost: 20 },
  { date: "2026-07-16", cost: 30 },
  { date: "2026-07-17", cost: 40 }
];
const reportOrders = [
  { date: "2026-07-10", amount: 100, profitBeforeAds: 70, jars: 1 },
  { date: "2026-07-11", amount: 200, profitBeforeAds: 120, jars: 2 },
  { date: "2026-07-16T17:30:00.000Z", amount: 300, profitBeforeAds: 210, jars: 3 },
  { date: "2026-07-17T02:00:00.000Z", amount: 400, profitBeforeAds: 250, jars: 4 }
];
const reportToday = marketingPerformanceForRangeForTest(reportOrders, reportAdRecords, { start: today, end: today });
assert(reportSummaryHeadingForTest({ start: today, end: today }) === "สรุปวันนี้", "reports heading handles today");
assert(reportRangeComparisonHintForTest({ start: today, end: today }) === "เทียบกับเมื่อวาน", "reports today comparison caption matches today");
assert(reportToday.sales === 700 && reportToday.orders === 2 && reportToday.units === 7 && reportToday.adCost === 40, "reports today KPIs use the selected Bangkok day");

const otherSingle = marketingPerformanceForRangeForTest(reportOrders, reportAdRecords, { start: "2026-07-11", end: "2026-07-11" });
assert(reportSummaryHeadingForTest({ start: "2026-07-11", end: "2026-07-11" }) === "สรุปวันที่ 2026-07-11", "reports heading handles another single date");
assert(reportRangeComparisonHintForTest({ start: "2026-07-11", end: "2026-07-11" }) === "เทียบกับวันก่อนหน้า", "reports other single date comparison caption is not today-specific");
assert(otherSingle.sales === 200 && otherSingle.orders === 1 && otherSingle.profitAfterAds === 100 && otherSingle.roas === 10, "reports other single date KPIs use selected date");

const reportSevenRange = { start: "2026-07-11", end: today };
const reportSeven = marketingPerformanceForRangeForTest(reportOrders, reportAdRecords, reportSevenRange);
const reportSevenCompareRange = previousPeriodRange(reportSevenRange);
const reportSevenCompare = marketingPerformanceForRangeForTest(reportOrders, reportAdRecords, reportSevenCompareRange);
assert(reportSummaryHeadingForTest(reportSevenRange) === "สรุปช่วงนี้ (2026-07-11–2026-07-17)", "reports heading handles multi-day range");
assert(reportRangeComparisonHintForTest(reportSevenRange) === "เทียบกับช่วงก่อนหน้า", "reports multi-day comparison caption uses previous period");
assert(reportSeven.sales === 900 && reportSeven.orders === 3 && reportSeven.units === 9 && reportSeven.adCost === 90, "reports multi-day KPIs use inclusive selected range");
assert(reportSevenCompareRange.start === "2026-07-04" && reportSevenCompareRange.end === "2026-07-10", "reports multi-day comparison uses immediately preceding equal-length range");
assert(reportSevenCompare.sales === 100 && reportSevenCompare.orders === 1 && reportSevenCompare.adCost === 10, "reports multi-day comparison metrics use previous range");
assert(sourceBetween("function renderMobileReports", "els.content.innerHTML").includes("monthOrders = orders.filter(order => monthKey(order.date) === selectedMonth)"), "monthly summary remains selected-month based");

assert(JSON.stringify(dashboardKpiTitlesForRangeForTest({ start: today, end: today })) === JSON.stringify({
  sales: "ยอดขายวันนี้",
  orders: "ออเดอร์วันนี้",
  profit: "กำไรวันนี้",
  units: "ขายได้วันนี้"
}), "home KPI titles match today by actual dates");
assert(JSON.stringify(dashboardKpiTitlesForRangeForTest({ start: yesterday, end: yesterday })) === JSON.stringify({
  sales: "ยอดขายเมื่อวาน",
  orders: "ออเดอร์เมื่อวาน",
  profit: "กำไรเมื่อวาน",
  units: "ขายได้เมื่อวาน"
}), "home KPI titles match yesterday by actual dates");
assert(JSON.stringify(dashboardKpiTitlesForRangeForTest({ start: "2026-07-01", end: today })) === JSON.stringify({
  sales: "ยอดขายเดือนนี้",
  orders: "ออเดอร์เดือนนี้",
  profit: "กำไรเดือนนี้",
  units: "ขายได้เดือนนี้"
}), "home KPI titles match current month by actual dates");
assert(JSON.stringify(dashboardKpiTitlesForRangeForTest({ start: yesterday, end: today })) === JSON.stringify({
  sales: "ยอดขายช่วงนี้",
  orders: "ออเดอร์ช่วงนี้",
  profit: "กำไรช่วงนี้",
  units: "ขายได้ช่วงนี้"
}), "home KPI titles use range wording for other multi-day ranges");
assert(sourceBetween("function renderMobileDashboard", "function desktopInsightTable").includes('label: "โอกาสเพิ่มยอดขาย"'), "mobile opportunity KPI title stays workflow-based");
assert(sourceBetween("function renderDesktopDashboard", "function renderDashboard").includes('label: "โอกาสเพิ่มยอดขาย"'), "desktop opportunity KPI title stays workflow-based");

console.log("date-range-picker tests passed");
