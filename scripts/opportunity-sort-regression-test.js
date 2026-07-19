const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP_PATH = path.join(ROOT, "public", "app.js");

function fail(message) {
  throw new Error(`Opportunity sort regression failed: ${message}`);
}

function fakeElement() {
  return {
    innerHTML: "",
    value: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {},
    focus() {},
    showModal() {},
    close() {}
  };
}

function loadApp() {
  const content = fakeElement();
  const documentElement = fakeElement();
  documentElement.dataset = {};
  const sandbox = {
    console,
    setTimeout() { return 0; },
    clearTimeout() {},
    URLSearchParams,
    FormData: class FormData {},
    Blob: class Blob {},
    FileReader: class FileReader {},
    CSS: { escape: value => String(value) },
    navigator: { serviceWorker: null, clipboard: { writeText() {} }, userAgent: "node" },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { pathname: "/opportunities", hash: "", search: "" },
    history: { pushState() {}, replaceState() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: {
      innerWidth: 390,
      location: { pathname: "/opportunities", hash: "", search: "" },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      setInterval() { return 0; },
      setTimeout() { return 0; },
      clearTimeout() {},
      matchMedia() {
        return { matches: true, addEventListener() {}, removeEventListener() {} };
      }
    },
    document: {
      documentElement,
      body: fakeElement(),
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
      createElement: fakeElement,
      querySelector(selector) {
        if (selector === "#content") return content;
        return fakeElement();
      },
      querySelectorAll() { return []; }
    },
    __content: content
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.CSS = sandbox.CSS;
  let source = fs.readFileSync(APP_PATH, "utf8");
  source = source.replace(/\nstartApp\(\);\s*$/, `
window.__opportunitySortTest = {
  app,
  renderMobileOpportunities,
  mobileOpportunityData,
  mobileOpportunityRows
};
`);
  vm.runInNewContext(source, sandbox, { filename: APP_PATH });
  return sandbox.window.__opportunitySortTest;
}

const selectedDate = "2026-07-18";
const api = loadApp();
api.app.currentUser = { id: "owner", role: "Owner", permissions: {} };
api.app.mobileOpportunityFilter = "overdue";
api.app.mobileOpportunitySearch = "";
api.app.mobileOpportunitySearchDraft = "";
api.app.mobileOpportunitySortDirection = "asc";
api.app.data = {
  summary: { selectedDate },
  settings: { businessName: "Growup" },
  orders: [
    { id: "urgent-low-order", customerId: "urgent-low", date: "2026-07-01", amount: 400, jars: 1, items: "Low" },
    { id: "middle-order", customerId: "middle", date: "2026-07-02", amount: 1200, jars: 1, items: "Middle" },
    { id: "near-high-order", customerId: "near-high", date: "2026-07-03", amount: 5000, jars: 1, items: "High" }
  ],
  customers: [
    { id: "urgent-low", name: "Urgent Low", followUpDate: "2026-07-10", vipLevel: "NORMAL", contactLogs: [] },
    { id: "middle", name: "Middle", followUpDate: "2026-07-12", vipLevel: "NORMAL", contactLogs: [] },
    { id: "near-high", name: "Near High", followUpDate: "2026-07-17", vipLevel: "NORMAL", contactLogs: [] }
  ],
  users: [],
  tags: []
};

const model = api.mobileOpportunityData();
const ascending = api.mobileOpportunityRows(model).map(row => row.customer.name).join("|");
if (ascending !== "Urgent Low|Middle|Near High") {
  fail(`default order should show most overdue first, got ${ascending}`);
}

let html = api.renderMobileOpportunities();
if (!html.includes('aria-label="เรียงโอกาสจากเร่งด่วนมากไปน้อย"') || !html.includes('title="เรียงโอกาสจากเร่งด่วนมากไปน้อย"')) {
  fail("sort button should describe the default ascending urgency direction");
}

api.app.mobileOpportunitySortDirection = "desc";
const descending = api.mobileOpportunityRows(model).map(row => row.customer.name).join("|");
if (descending !== "Near High|Middle|Urgent Low") {
  fail(`second click should reverse the currently visible rows, got ${descending}`);
}

html = api.renderMobileOpportunities();
if (!html.includes('aria-label="เรียงโอกาสจากเร่งด่วนน้อยไปมาก"') || !html.includes('title="เรียงโอกาสจากเร่งด่วนน้อยไปมาก"')) {
  fail("sort button should describe the descending urgency direction");
}
if (api.app.mobileOpportunityFilter !== "overdue") {
  fail("sort rerender should preserve the active opportunity tab");
}

console.log("Opportunity sort regression passed.");
