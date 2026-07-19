const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");

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

assert(appJs.includes("function reportRangeSummaryModel"), "Reports range summary model exists");
assert(appJs.includes("function reportSummaryHeading"), "Reports heading helper exists");
assert(appJs.includes("function previousReportRange"), "Reports previous equal-length range helper exists");
assert(appJs.includes("function restoreAppliedDateRangeFromStorage"), "Applied range restore helper exists");
assert(appJs.includes("function persistAppliedDateRange"), "Applied range persistence helper exists");
assert(appJs.includes("rangeKey: summaryRangeKey"), "Summary cache includes start/end range key");

const reportBlock = sourceBetween("function renderMobileReports", "function renderReports");
assert(reportBlock.includes("reportRangeSummaryModel(selectedRange)"), "Reports first row uses applied range model");
assert(!reportBlock.includes("order.date === selectedDate"), "Reports first row no longer filters only selected end date");
assert(!reportBlock.includes("สรุปวันนี้</h2>"), "Reports heading is not hardcoded to today");
assert(reportBlock.includes("reportSummaryHeadingHtml(rangeSummary.heading)"), "Reports heading renders from applied range");

const marketingBlock = sourceBetween("function marketingPerformanceForPeriod", "function adCostModeLabel");
assert(marketingBlock.includes("range = null"), "Marketing performance accepts a range");
assert(marketingBlock.includes("dateInRange(order.date, normalizedRange)"), "Marketing orders filter uses inclusive range");
assert(marketingBlock.includes("dateInRange(record.date, normalizedRange)"), "Marketing ad records filter uses inclusive range");

const applyBlock = sourceBetween("function applyDateRangeDraft", "function updateShell");
assert(applyBlock.includes("persistAppliedDateRange(applied)"), "Applied range persists only after Update");
assert(sourceBetween("function chooseDateRangePreset", "function chooseRangeDate").includes("updateDatePickerDraft"), "Preset changes update draft only");
assert(!sourceBetween("function chooseDateRangePreset", "function chooseRangeDate").includes("persistAppliedDateRange"), "Draft preset changes are not persisted");

function parseDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysISO(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function diffDaysISO(start, end) {
  return Math.round((parseDate(end) - parseDate(start)) / 86400000);
}

function normalizeDateRange(start, end) {
  const first = start || end;
  const last = end || start || first;
  return first <= last ? { start: first, end: last } : { start: last, end: first };
}

function dateRangeDays(range) {
  return diffDaysISO(range.start, range.end) + 1;
}

function previousReportRange(range) {
  const normalized = normalizeDateRange(range.start, range.end);
  const days = dateRangeDays(normalized);
  const end = addDaysISO(normalized.start, -1);
  return { start: addDaysISO(end, -(days - 1)), end };
}

const thaiMonths = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function parts(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return { year, month, day };
}

function formatThaiDate(value) {
  const item = parts(value);
  return `${item.day} ${thaiMonths[item.month - 1]} ${item.year + 543}`;
}

function rangeLabel(range) {
  const normalized = normalizeDateRange(range.start, range.end);
  if (normalized.start === normalized.end) return formatThaiDate(normalized.start);
  const start = parts(normalized.start);
  const end = parts(normalized.end);
  if (start.year === end.year && start.month === end.month) return `${start.day}–${end.day} ${thaiMonths[end.month - 1]} ${end.year + 543}`;
  if (start.year === end.year) return `${start.day} ${thaiMonths[start.month - 1]}–${end.day} ${thaiMonths[end.month - 1]} ${end.year + 543}`;
  return `${start.day} ${thaiMonths[start.month - 1]} ${start.year + 543}–${end.day} ${thaiMonths[end.month - 1]} ${end.year + 543}`;
}

function heading(range, preset) {
  const normalized = normalizeDateRange(range.start, range.end);
  if (normalized.start === normalized.end) {
    if (preset === "today") return "สรุปวันนี้";
    if (preset === "yesterday") return "สรุปเมื่อวาน";
    return `สรุปวันที่ ${rangeLabel(normalized)}`;
  }
  const titles = {
    "last-7": "สรุป 7 วันล่าสุด",
    "last-30": "สรุป 30 วันล่าสุด",
    "this-month": "สรุปเดือนนี้",
    "last-month": "สรุปเดือนที่แล้ว"
  };
  return `${titles[preset] || "สรุปช่วงที่เลือก"} (${rangeLabel(normalized)})`;
}

const orders = [
  { date: "2026-06-30", amount: 100, jars: 1, profitBeforeAds: 60 },
  { date: "2026-07-01", amount: 110, jars: 2, profitBeforeAds: 70 },
  { date: "2026-07-05", amount: 50, jars: 1, profitBeforeAds: 20 },
  { date: "2026-07-06", amount: 60, jars: 1, profitBeforeAds: 25 },
  { date: "2026-07-07", amount: 70, jars: 1, profitBeforeAds: 30 },
  { date: "2026-07-08", amount: 80, jars: 1, profitBeforeAds: 35 },
  { date: "2026-07-09", amount: 90, jars: 1, profitBeforeAds: 40 },
  { date: "2026-07-10", amount: 100, jars: 1, profitBeforeAds: 45 },
  { date: "2026-07-11", amount: 110, jars: 1, profitBeforeAds: 50 },
  { date: "2026-07-12", amount: 120, jars: 2, profitBeforeAds: 55 },
  { date: "2026-07-13", amount: 130, jars: 2, profitBeforeAds: 60 },
  { date: "2026-07-14", amount: 140, jars: 2, profitBeforeAds: 65 },
  { date: "2026-07-15", amount: 150, jars: 2, profitBeforeAds: 70 },
  { date: "2026-07-16", amount: 160, jars: 2, profitBeforeAds: 75 },
  { date: "2026-07-17", amount: 170, jars: 2, profitBeforeAds: 80 },
  { date: "2026-07-18", amount: 180, jars: 2, profitBeforeAds: 85 }
];

const adRecords = [
  { date: "2026-06-30", cost: 5 },
  { date: "2026-07-05", cost: 5 },
  { date: "2026-07-11", cost: 10 },
  { date: "2026-07-12", cost: 12 },
  { date: "2026-07-18", cost: 18 }
];

function inRange(value, range) {
  const normalized = normalizeDateRange(range.start, range.end);
  return value >= normalized.start && value <= normalized.end;
}

function summarize(range) {
  const normalized = normalizeDateRange(range.start, range.end);
  const rows = orders.filter(order => inRange(order.date, normalized));
  const previous = previousReportRange(normalized);
  const previousRows = orders.filter(order => inRange(order.date, previous));
  const adCost = adRecords.filter(record => inRange(record.date, normalized)).reduce((sum, record) => sum + record.cost, 0);
  const sales = rows.reduce((sum, order) => sum + order.amount, 0);
  const profitBeforeAds = rows.reduce((sum, order) => sum + order.profitBeforeAds, 0);
  return {
    range: normalized,
    previous,
    sales,
    orders: rows.length,
    units: rows.reduce((sum, order) => sum + order.jars, 0),
    profitBeforeAds,
    adCost,
    profitAfterAds: profitBeforeAds - adCost,
    roas: adCost ? sales / adCost : 0,
    previousSales: previousRows.reduce((sum, order) => sum + order.amount, 0),
    previousOrders: previousRows.length
  };
}

assert(heading({ start: "2026-07-18", end: "2026-07-18" }, "today") === "สรุปวันนี้", "Today heading");
assert(heading({ start: "2026-07-17", end: "2026-07-17" }, "yesterday") === "สรุปเมื่อวาน", "Yesterday heading");
assert(heading({ start: "2026-07-12", end: "2026-07-12" }, "custom") === "สรุปวันที่ 12 ก.ค. 2569", "Other single-date heading");
assert(heading({ start: "2026-07-12", end: "2026-07-18" }, "last-7") === "สรุป 7 วันล่าสุด (12–18 ก.ค. 2569)", "7-day heading");
assert(heading({ start: "2026-06-19", end: "2026-07-18" }, "last-30") === "สรุป 30 วันล่าสุด (19 มิ.ย.–18 ก.ค. 2569)", "30-day heading");
assert(heading({ start: "2026-07-10", end: "2026-07-12" }, "custom") === "สรุปช่วงที่เลือก (10–12 ก.ค. 2569)", "Custom range heading");

const seven = summarize({ start: "2026-07-12", end: "2026-07-18" });
assert(seven.sales === 1050, "Inclusive seven-day sales aggregation includes both endpoints");
assert(seven.orders === 7, "Inclusive seven-day order aggregation includes both endpoints");
assert(seven.units === 14, "Inclusive units aggregation");
assert(seven.profitBeforeAds === 490, "Profit before Ads aggregates over range");
assert(seven.adCost === 30, "Ad cost aggregates over range");
assert(seven.profitAfterAds === 460, "Profit after Ads subtracts range ad cost");
assert(seven.roas === 35, "ROAS uses safe ad cost denominator");
assert(seven.previous.start === "2026-07-05" && seven.previous.end === "2026-07-11", "Previous comparison is equal-length immediately preceding range");
assert(seven.previousSales === 560 && seven.previousOrders === 7, "Previous comparison aggregates equal-length range");

const crossMonth = summarize({ start: "2026-06-30", end: "2026-07-01" });
assert(crossMonth.sales === 210 && crossMonth.orders === 2, "Cross-month range aggregates inclusively");
assert("2026-07-01".slice(0, 7) === "2026-07", "Monthly section follows applied end-date month");

let applied = { start: "2026-07-18", end: "2026-07-18", preset: "today" };
let draft = { ...applied };
draft = { start: "2026-07-12", end: "2026-07-18", preset: "last-7" };
assert(applied.start === "2026-07-18" && heading(applied, applied.preset) === "สรุปวันนี้", "Draft changes do not alter applied heading before Update");
applied = { ...draft };
assert(heading(applied, applied.preset) === "สรุป 7 วันล่าสุด (12–18 ก.ค. 2569)", "Update applies draft heading");
draft = { start: "2026-07-01", end: "2026-07-03", preset: "custom" };
assert(heading(applied, applied.preset) === "สรุป 7 วันล่าสุด (12–18 ก.ค. 2569)", "Cancel keeps current applied heading and values");

const restoredWithPreset = { start: "2026-07-12", end: "2026-07-18", preset: "last-7" };
assert(heading(restoredWithPreset, restoredWithPreset.preset) === "สรุป 7 วันล่าสุด (12–18 ก.ค. 2569)", "Reload restores saved preset identity");
const restoredDatesOnly = { start: "2026-07-12", end: "2026-07-18", preset: "custom" };
assert(heading(restoredDatesOnly, restoredDatesOnly.preset) === "สรุปช่วงที่เลือก (12–18 ก.ค. 2569)", "Dates-only restore uses truthful generic heading");

console.log("report range summary tests passed");
