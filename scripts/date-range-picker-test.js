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
assert(appJs.includes("syncComparisonDraft"), "comparison state is calculated locally");
assert(appJs.includes("previousPeriodRange"), "previous period comparison exists");
assert(appJs.includes("applyDateRangeDraft"), "apply handler exists");
assert(appJs.includes("closeDateRangePicker"), "cancel/close handler exists");
assert(appJs.includes("opened without API request"), "picker open measurement logs no API request path");
assert(!sourceBetween("function openDateRangePicker()", "function closeDateRangePicker").includes("loadState("), "opening picker does not call loadState");
assert(!sourceBetween("function chooseDateRangePreset", "function chooseRangeDate").includes("loadState("), "selecting preset does not call loadState");
assert(!sourceBetween("function chooseRangeDate", "function applyDateRangeDraft").includes("loadState("), "selecting calendar date does not call loadState");
assert(html.includes('id="workDate" type="hidden"'), "native date input is replaced by hidden compatibility field");
assert(html.includes('id="workDateTrigger"'), "date trigger button exists");
assert(css.includes(".range-picker-overlay.is-desktop"), "desktop popover styles exist");
assert(css.includes(".range-picker-overlay.is-mobile"), "mobile bottom sheet styles exist");
assert(css.includes("grid-template-columns: repeat(2"), "desktop renders two visible month columns");
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

console.log("date-range-picker tests passed");
