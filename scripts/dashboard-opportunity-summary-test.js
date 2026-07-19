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
      { id: "closed-today", customerId: "cust-z", date: selectedDate, time: "13:00", amount: 555, jars: 1, items: "Closed" },
      { id: "dup-a", customerId: "dup-x", orderNumber: "DUP-001", date: selectedDate, time: "14:00", amount: 111, jars: 1, items: "A" },
      { id: "dup-b", customerId: "dup-y", orderNumber: "DUP-001", date: selectedDate, time: "14:05", amount: 222, jars: 1, items: "B" }
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

function emptyNotificationState() {
  const state = fixtureState();
  return {
    ...state,
    orders: [],
    customers: [],
    notificationReadIds: [],
    settings: {
      ...state.settings,
      notificationPreferences: {
        categories: {
          orderReview: true,
          customerFollowUp: true,
          lowStock: true,
          vipReminder: true,
          salesOpportunity: true
        },
        channels: { inApp: true }
      }
    }
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
  if (dashboardHtml.includes("สร้างแคมเปญและโปรโมทธุรกิจ")) {
    fail(`${mode} dashboard still renders the Marketing quick action card`);
  }
  if (mode === "desktop") {
    const quickActionCount = (dashboardHtml.match(/desktop-reference-quick-action/g) || []).length;
    if (quickActionCount !== 5) fail(`desktop dashboard quick actions should reflow to 5 cards, got ${quickActionCount}`);
    if (!dashboardHtml.includes("การแจ้งเตือนสำคัญ")) fail("desktop dashboard must render important notifications");
    if (!dashboardHtml.includes("data-open-notifications")) fail("desktop notification header must open the existing drawer");
    const notificationRowCount = (dashboardHtml.match(/desktop-dashboard-notification-row/g) || []).length;
    if (notificationRowCount !== 3) fail(`desktop notification section should show exactly 3 rows from this fixture, got ${notificationRowCount}`);
    if ((dashboardHtml.match(/data-open-notification="/g) || []).length !== 3) fail("desktop notification rows must use existing notification deep-link actions");
    if (!dashboardHtml.includes("เปิดดู")) fail("desktop notification rows must preserve the existing row action label");
  }
}

assertSharedSummary(1280, "desktop");
assertSharedSummary(390, "mobile");

{
  const sandbox = loadApp(1280);
  const api = sandbox.window.__dashboardOpportunityTest;
  api.app.data = emptyNotificationState();
  api.app.currentUser = { id: "owner", role: "Owner", permissions: {} };
  api.renderDashboard();
  const dashboardHtml = sandbox.__content.innerHTML;
  if (!dashboardHtml.includes("ยังไม่มีการแจ้งเตือนสำคัญ")) fail("desktop notification section must render a clean empty state");
  if ((dashboardHtml.match(/desktop-dashboard-notification-row/g) || []).length !== 0) fail("empty desktop notification state should not render rows");
}

const source = fs.readFileSync(APP_PATH, "utf8");
const styles = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
if (source.includes("โอกาสสร้างยอดขายวันนี้")) fail("old dashboard title is still present");
if (!source.includes("const opportunitySummary = opportunitySummaryFromModel(mobileOpportunityData())")) {
  fail("dashboard is not wired to the /opportunities summary helper");
}
if (!source.includes("function desktopDashboardImportantNotifications()") || !source.includes("return liveNotificationEvents().slice(0, 3);")) {
  fail("desktop dashboard notifications must reuse live notification events and cap at three rows");
}
if (!source.includes("data-open-notification=") || !source.includes("data-open-notifications")) {
  fail("desktop notification actions must reuse the existing drawer and row deep-link attributes");
}
if (!styles.includes("grid-template-columns: repeat(5, minmax(0, 1fr));")) {
  fail("desktop quick-action grid must use five equal columns");
}

console.log("Dashboard opportunity summary test passed.");
