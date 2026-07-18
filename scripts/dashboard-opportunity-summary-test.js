const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP_PATH = path.join(ROOT, "public", "app.js");

function fail(message) {
  throw new Error(`Dashboard opportunity summary test failed: ${message}`);
}

function fakeElement() {
  const element = {
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
  return element;
}

function createSandbox(width) {
  const content = fakeElement();
  const documentElement = fakeElement();
  documentElement.dataset = {};
  return {
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
    location: { pathname: "/dashboard", hash: "", search: "" },
    history: { pushState() {}, replaceState() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: {
      innerWidth: width,
      location: { pathname: "/dashboard", hash: "", search: "" },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      setInterval() { return 0; },
      setTimeout() { return 0; },
      clearTimeout() {},
      matchMedia(query) {
        return {
          matches: query.includes("max-width") ? width <= 820 : false,
          addEventListener() {},
          removeEventListener() {}
        };
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
}

function loadApp(width) {
  const sandbox = createSandbox(width);
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.CSS = sandbox.CSS;
  let source = fs.readFileSync(APP_PATH, "utf8");
  source = source.replace(/\nstartApp\(\);\s*$/, `
window.__dashboardOpportunityTest = {
  app,
  renderDashboard,
  renderMobileOpportunities,
  mobileOpportunityData,
  opportunitySummaryFromModel
};
`);
  vm.runInNewContext(source, sandbox, { filename: APP_PATH });
  return sandbox;
}

function fixtureState() {
  const selectedDate = "2026-07-18";
  return {
    summary: {
      selectedDate,
      startDate: "2026-07-01",
      endDate: "2026-07-18",
      salesToday: 0,
      salesThisMonth: 0,
      ordersToday: 0,
      ordersThisMonth: 0
    },
    settings: { businessName: "Growup" },
    orders: [
      { id: "order-a", customerId: "cust-a", date: "2026-07-01", time: "09:00", amount: 1000, jars: 1, items: "A" },
      { id: "order-b", customerId: "cust-b", date: "2026-06-10", time: "10:00", amount: 2000, jars: 2, items: "B" },
      { id: "order-c", customerId: "cust-c", date: "2026-07-10", time: "11:00", amount: 3000, jars: 3, items: "C" },
      { id: "order-d", customerId: "cust-d", date: selectedDate, time: "12:00", amount: 4000, jars: 4, items: "D" },
      { id: "closed-today", customerId: "cust-z", date: selectedDate, time: "13:00", amount: 555, jars: 1, items: "Closed" }
    ],
    customers: [
      { id: "cust-a", name: "Customer A", followUpDate: selectedDate, vipLevel: "NORMAL", contactLogs: [] },
      { id: "cust-b", name: "Customer B", followUpDate: "2026-07-12", vipLevel: "VIP", contactLogs: [] },
      { id: "cust-c", name: "Customer C", followUpDate: "2026-07-25", vipLevel: "NORMAL", contactLogs: [] },
      {
        id: "cust-d",
        name: "Customer D",
        followUpDate: selectedDate,
        vipLevel: "NORMAL",
        contactLogs: [{ id: "log-d", customerId: "cust-d", result: "CRMเรียบร้อยแล้ว", date: selectedDate, orderId: "order-d" }]
      },
      { id: "cust-e", name: "Customer E", vipLevel: "NORMAL", contactLogs: [] }
    ],
    users: [],
    tags: []
  };
}

function textAfter(html, label) {
  const index = html.indexOf(label);
  if (index < 0) fail(`missing label "${label}"`);
  return html.slice(index, index + 300).replace(/\s+/g, " ");
}

function assertSharedSummary(width, mode) {
  const sandbox = loadApp(width);
  const api = sandbox.window.__dashboardOpportunityTest;
  api.app.data = fixtureState();
  api.app.currentUser = { id: "owner", role: "Owner", permissions: {} };
  api.app.mobileOpportunityFilter = "today";

  const opportunityHtml = api.renderMobileOpportunities();
  const opportunitySummary = api.opportunitySummaryFromModel(api.mobileOpportunityData());
  if (opportunitySummary.totalOpportunity !== 3000) fail(`${mode} opportunity summary expected 3000, got ${opportunitySummary.totalOpportunity}`);
  if (!textAfter(opportunityHtml, "โอกาสปิดยอดรวม").includes("฿ 3,000")) {
    fail(`${mode} /opportunities render did not show ฿ 3,000`);
  }

  api.renderDashboard();
  const dashboardHtml = sandbox.__content.innerHTML;
  if (!dashboardHtml.includes("โอกาสเพิ่มยอดขาย")) fail(`${mode} dashboard title was not updated`);
  if (!textAfter(dashboardHtml, "โอกาสเพิ่มยอดขาย").includes("฿3,000")) {
    fail(`${mode} dashboard value did not match /opportunities total`);
  }
  if (!textAfter(dashboardHtml, "โอกาสเพิ่มยอดขาย").includes("ลูกค้าที่ควรติดตาม 2 ราย")) {
    fail(`${mode} dashboard did not reuse the due customer count`);
  }
}

assertSharedSummary(1280, "desktop");
assertSharedSummary(390, "mobile");

const source = fs.readFileSync(APP_PATH, "utf8");
if (source.includes("โอกาสสร้างยอดขายวันนี้")) fail("old dashboard title is still present");
if (!source.includes("const opportunitySummary = opportunitySummaryFromModel(mobileOpportunityData())")) {
  fail("dashboard is not wired to the /opportunities summary helper");
}

console.log("Dashboard opportunity summary test passed.");
