const navItems = [
  ["dashboard", "/dashboard", "หน้าหลัก", "home"],
  ["opportunities", "/opportunities", "โอกาสทำเงิน", "spark"],
  ["orders", "/orders", "ออเดอร์", "clipboard"],
  ["customers", "/customers", "ลูกค้า", "users"],
  ["products", "/products", "สินค้า", "box"],
  ["marketing", "/marketing", "การตลาด", "megaphone"],
  ["reports", "/reports", "รายงาน", "chart"],
  ["aiInsights", "/ai-insight", "AI Insight", "stars"],
  ["broadcast", "/broadcast", "Broadcast", "send"],
  ["campaigns", "/campaigns", "แคมเปญ", "flag"],
  ["pricing", "/pricing", "แพ็กเกจ", "stars"],
  ["settings", "/settings", "ตั้งค่า", "settings"],
  ["notifications", "/notifications", "แจ้งเตือน", "bell"]
];

const routeToView = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/customers": "customers",
  "/orders": "orders",
  "/follow-up": "notifications",
  "/notifications": "notifications",
  "/more": "settings",
  "/opportunities": "opportunities",
  "/products": "products",
  "/marketing": "marketing",
  "/ai-insight": "aiInsights",
  "/broadcast": "broadcast",
  "/campaigns": "campaigns",
  "/pricing": "pricing",
  "/vip": "vip",
  "/tags": "tags",
  "/import": "import",
  "/reports": "reports",
  "/settings": "settings",
  "/settings/follow-up": "settingsFollowup",
  "/settings/vip": "settingsVip",
  "/settings/line-oa": "settingsLine",
  "/admin/line-debug": "lineDebug",
  "/team": "team",
  "/risk": "risk",
  "/login": "login"
};
const viewToRoute = Object.fromEntries(Object.entries(routeToView).map(([path, view]) => [view, path]));
const MISSING_CHANNEL_LABEL = "อื่นๆ";

const app = {
  view: routeFromLocation(),
  followupMode: "today",
  importMode: "csv",
  csvImportText: "",
  csvPreview: [],
  csvPreviewSummary: null,
  importInspection: null,
  importJob: null,
  importCleanup: null,
  importPreparing: false,
  importWorker: null,
  importPollTimer: null,
  summaryRefreshTimer: null,
  currentUser: null,
  data: null,
  lineDebugRows: [],
  lineDebugSummary: {},
  reportMonth: "",
  reportDate: "",
  ordersShowAll: false,
  customersShowAll: false,
  ordersFilterQ: "",
  ordersFilterDraft: "",
  filters: {
    q: "",
    tag: "",
    status: "",
    vip: ""
  },
  editingOrderId: "",
  deletingOrderId: "",
  deletingCustomerId: ""
};

const adminViews = new Set(["settingsFollowup", "settingsVip", "settingsLine", "lineDebug", "team"]);

function isAdmin() {
  return app.currentUser?.role === "Admin";
}

function canExportData() {
  return isAdmin() || Boolean(app.data?.settings?.staffCanExport);
}

function canAccessView(view) {
  if (adminViews.has(view)) return isAdmin();
  return true;
}

function splitTags(input) {
  if (Array.isArray(input)) return input.map(String).map(tag => tag.trim()).filter(Boolean);
  return String(input || "")
    .split(/[,\n|/]+/)
    .map(tag => tag.trim())
    .filter(Boolean);
}

function orderNumberSortParts(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+)(?:\s*\/\s*(\d+))?/);
  if (!match) return { numeric: Number.POSITIVE_INFINITY, year: Number.POSITIVE_INFINITY, raw: text };
  return {
    numeric: Number(match[1]),
    year: match[2] ? Number(match[2]) : Number.POSITIVE_INFINITY,
    raw: text
  };
}

function compareOrderNumberAscending(a, b) {
  const first = orderNumberSortParts(a?.orderNumber);
  const second = orderNumberSortParts(b?.orderNumber);
  if (first.numeric !== second.numeric) return first.numeric - second.numeric;
  if (first.year !== second.year) return first.year - second.year;
  const dateCompare = String(a?.date || "").localeCompare(String(b?.date || ""));
  if (dateCompare !== 0) return dateCompare;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function sortOrdersAscending(orders) {
  return [...orders].sort(compareOrderNumberAscending);
}

function routeFromLocation() {
  if (location.hash) {
    const hashView = location.hash.replace("#", "") || "dashboard";
    if (hashView === "search") return "customers";
    if (hashView === "followup" || hashView === "follow-up") return "notifications";
    if (hashView === "more") return "settings";
    return hashView;
  }
  return routeToView[location.pathname] || "dashboard";
}

function navigateToView(view, replace = false) {
  const path = viewToRoute[view] || "/dashboard";
  if (location.pathname !== path || location.hash) {
    history[replace ? "replaceState" : "pushState"]({}, "", path);
  }
}

function iconSvg(name) {
  const icons = {
    home: '<path d="m3 10 9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8"/><path d="M8 16h6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    spark: '<path d="M12 3 9.5 9.5 3 12l6.5 2.5L12 21l2.5-6.5L21 12l-6.5-2.5z"/>',
    box: '<path d="M21 8.5 12 13 3 8.5"/><path d="M3 8.5 12 3l9 5.5v7L12 21l-9-5.5z"/><path d="M12 13v8"/>',
    megaphone: '<path d="M3 11v2"/><path d="M6 10v4"/><path d="M19 7v10"/><path d="M6 10l13-3v10L6 14z"/><path d="M6 14l2 6h3"/>',
    chart: '<path d="M4 19h16"/><path d="M7 15V9"/><path d="M12 15V5"/><path d="M17 15v-3"/>',
    stars: '<path d="m12 3 1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="m19 16 .9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z"/><path d="M5 16.5 6 19l2.5 1-2.5 1L5 23l-1-2.5L1.5 19 4 18z"/>',
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>',
    flag: '<path d="M4 21V5"/><path d="M4 5h11l-1.5 4L15 13H4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 16 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c0 .38.14.74.4 1a1.7 1.7 0 0 0 1.1.4H21a2 2 0 1 1 0 4h-.09c-.41 0-.81.15-1.1.4a1.7 1.7 0 0 0-.41 1.1Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
  };
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.more}</svg>`;
}

const els = {
  nav: document.querySelector("#mainNav"),
  pageTitle: document.querySelector("#pageTitle"),
  subpageNav: document.querySelector("#subpageNav"),
  content: document.querySelector("#content"),
  workDate: document.querySelector("#workDate"),
  toast: document.querySelector("#toast"),
  userPill: document.querySelector("#userPill"),
  orderDialog: document.querySelector("#orderDialog"),
  orderForm: document.querySelector("#orderForm"),
  orderDialogTitle: document.querySelector("#orderDialogTitle"),
  orderSubmitButton: document.querySelector("#orderSubmitButton"),
  deleteOrderDialog: document.querySelector("#deleteOrderDialog"),
  deleteOrderForm: document.querySelector("#deleteOrderForm"),
  deleteCustomerDialog: document.querySelector("#deleteCustomerDialog"),
  deleteCustomerForm: document.querySelector("#deleteCustomerForm"),
  logoutDialog: document.querySelector("#logoutDialog"),
  logoutForm: document.querySelector("#logoutForm"),
  customerDialog: document.querySelector("#customerDialog"),
  customerDetail: document.querySelector("#customerDetail"),
  dialogCustomerName: document.querySelector("#dialogCustomerName")
};

async function restoreSession() {
  try {
    const res = await fetch("/api/session", {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    });
    const payload = await res.json();
    app.currentUser = payload.user?.id ? payload.user : null;
  } catch {
    app.currentUser = null;
  }
}

function saveSession(user) {
  app.currentUser = user;
}

function clearSession() {
  app.currentUser = null;
  app.data = null;
}

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const y = values.year;
  const m = values.month;
  const day = values.day;
  return `${y}-${m}-${day}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  return Number(value || 0).toLocaleString("th-TH", {
    maximumFractionDigits: 0
  });
}

function formatDate(dateValue) {
  if (!dateValue) return "-";
  const [y, m, d] = String(dateValue).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatShortDate(dateValue) {
  if (!dateValue) return "-";
  const [y, m, d] = String(dateValue).split("-").map(Number);
  const shortYear = String((y + 543) % 100).padStart(2, "0");
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${shortYear}`;
}

function formatDateTime(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return escapeHtml(dateValue);
  return new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function dateInputValue(dateValue) {
  return dateValue || todayISO();
}

function badgeClass(status) {
  if (status === "SUPER VIP") return "super";
  if (status === "VVIP") return "vvip";
  if (status === "VIP") return "vip";
  if (status === "AT RISK") return "risk";
  if (status === "LOST") return "lost";
  if (status === "NEW") return "new";
  return "normal";
}

function badge(status) {
  return `<span class="badge ${badgeClass(status)}">${escapeHtml(status || "NORMAL")}</span>`;
}

function vipBadge(level) {
  if (!level || level === "NORMAL") return `<span class="badge normal">NORMAL</span>`;
  return badge(level);
}

function tagsHtml(tags = []) {
  if (!tags.length) return `<span class="muted">ไม่มีอาการลูกค้า</span>`;
  return `<div class="badge-list">${tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
}

function priority(customer) {
  const order = {
    "SUPER VIP": 1,
    VVIP: 2,
    VIP: 3,
    NORMAL: 4
  };
  return order[customer.vipLevel] || 5;
}

function sortByPriority(customers) {
  return [...customers].sort((a, b) => {
    const p = priority(a) - priority(b);
    if (p !== 0) return p;
    return b.customerScore - a.customerScore;
  });
}

function titleFor(view) {
  const titles = {
    login: "เข้าสู่ระบบ",
    dashboard: "หน้าหลัก",
    opportunities: "โอกาสทำเงิน",
    orders: "ออเดอร์",
    customers: "ลูกค้า",
    products: "สินค้า",
    marketing: "การตลาด",
    reports: "รายงาน",
    aiInsights: "AI Insight",
    broadcast: "Broadcast",
    campaigns: "แคมเปญ",
    pricing: "แพ็กเกจ",
    notifications: "แจ้งเตือน",
    vip: "ลูกค้า VIP",
    risk: "ลูกค้าเสี่ยงหาย",
    tags: "อาการลูกค้า",
    import: "เพิ่มข้อมูลเก่า",
    team: "จัดการทีมงาน",
    settings: "ตั้งค่า",
    settingsFollowup: "ตั้งค่า Follow-up",
    settingsVip: "ตั้งค่า VIP",
    settingsLine: "ตั้งค่า LINE OA",
    lineDebug: "LINE Debug"
  };
  return titles[view] || "หน้าหลัก";
}

const moreSubpages = new Set([
  "vip", "risk", "tags", "import", "reports", "team", "settings",
  "settingsFollowup", "settingsVip", "settingsLine", "lineDebug", "pricing"
]);

function renderSubpageNav() {
  if (!moreSubpages.has(app.view)) {
    els.subpageNav.hidden = true;
    els.subpageNav.innerHTML = "";
    return;
  }
  els.subpageNav.hidden = false;
  els.subpageNav.innerHTML = `
    <button class="subpage-back" type="button" data-view-shortcut="settings" aria-label="กลับไปหน้าตั้งค่า">←</button>
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <button type="button" data-view-shortcut="settings">ตั้งค่า</button>
      <span aria-hidden="true">›</span>
      <span>${escapeHtml(titleFor(app.view))}</span>
    </nav>
  `;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: res.ok, raw: text };
  }
  if (!res.ok || payload.ok === false) {
    const error = new Error(payload.error || "บันทึกไม่สำเร็จ");
    error.status = res.status;
    throw error;
  }
  return payload;
}

async function loadState() {
  const selectedDate = els.workDate.value || todayISO();
  try {
    app.data = await api(`/api/state?date=${encodeURIComponent(selectedDate)}`);
    if (app.data.currentUser) app.currentUser = app.data.currentUser;
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      app.view = "login";
      navigateToView("login", true);
      render();
      return;
    }
    throw error;
  }
  if (app.currentUser && app.view === "login") {
    app.view = "dashboard";
    navigateToView("dashboard", true);
  }
  if (!canAccessView(app.view)) {
    app.view = "settings";
    navigateToView("settings", true);
  }
  if (app.view === "import" && isAdmin()) {
    try {
      const payload = await api("/api/import-jobs/latest-cleanup-preview?type=orders");
      app.importCleanup = payload.preview || null;
    } catch {
      app.importCleanup = null;
    }
  } else {
    app.importCleanup = null;
  }
  render();
}

function renderNav() {
  if (app.view === "login") {
    els.nav.innerHTML = "";
    return;
  }
  const activeGroupMap = {
    vip: "settings",
    risk: "notifications",
    tags: "customers",
    import: "orders",
    team: "settings",
    pricing: "pricing",
    settingsFollowup: "settings",
    settingsVip: "settings",
    settingsLine: "settings",
    lineDebug: "settings"
  };
  const activeGroup = activeGroupMap[app.view] || app.view;
  els.nav.innerHTML = navItems
    .map(([id, path, label, icon]) => `
      <button class="nav-button ${activeGroup === id ? "active" : ""}" data-view="${id}" data-path="${path}" aria-label="${escapeHtml(label)}">
        <span class="nav-index">${iconSvg(icon)}</span>
        <span>${escapeHtml(label)}</span>
      </button>
    `)
    .join("");
}

function updateShell() {
  document.body.classList.toggle("login-view", app.view === "login");
  if (!els.userPill) return;
  if (!app.currentUser || app.view === "login") {
    els.userPill.hidden = true;
    els.userPill.innerHTML = "";
    return;
  }
  els.userPill.hidden = false;
  els.userPill.innerHTML = `
    <span>${escapeHtml(app.currentUser.name)}</span>
    <strong>${escapeHtml(app.currentUser.role)}</strong>
    <button type="button" data-logout>ออก</button>
  `;
}

function metric(label, value, tone = "") {
  return `
    <article class="metric-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function initials(name = "") {
  return String(name).replace(/^คุณ/, "").trim().slice(0, 2) || "GP";
}

function monthlySalesRows() {
  const rows = {};
  app.data.orders.forEach(order => {
    const key = String(order.date || "").slice(0, 7);
    rows[key] = (rows[key] || 0) + Number(order.amount || 0);
  });
  return Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
}

function monthlyChart() {
  const rows = monthlySalesRows();
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return `
    <div class="mobile-chart">
      ${rows.map(([month, value]) => `
        <div class="chart-bar-item">
          <div class="chart-bar-track"><div class="chart-bar-fill" style="height:${Math.max(8, value / max * 100)}%"></div></div>
          <span>${escapeHtml(month.slice(5))}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function dashboardDelta(todayValue, yesterdayValue, unit = "") {
  const today = Number(todayValue || 0);
  const yesterday = Number(yesterdayValue || 0);
  const diff = today - yesterday;
  const trend = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const prefix = diff > 0 ? "+" : diff < 0 ? "-" : "";
  const amount = Math.abs(diff);
  const formatted = unit === "currency" ? `${money(amount)} บาท` : money(amount);
  const summary = diff === 0 ? "เท่ากับเมื่อวาน" : `${prefix}${formatted} เทียบกับเมื่อวาน`;
  return { diff, trend, summary };
}

function dashboardKpiCard({ label, value, icon, tone = "", delta, hint }) {
  return `
    <article class="metric-card dashboard-kpi ${tone}">
      <div class="metric-top">
        <span>${escapeHtml(label)}</span>
        <div class="metric-icon" aria-hidden="true">${icon}</div>
      </div>
      <strong>${escapeHtml(value)}</strong>
      <div class="metric-foot">
        <span class="trend trend-${escapeHtml(delta.trend)}">${escapeHtml(delta.summary)}</span>
        <small>${escapeHtml(hint)}</small>
      </div>
    </article>
  `;
}

function dashboardActionCard({ title, reason, revenue, action, targetView, icon, emphasis = "" }) {
  return `
    <article class="dashboard-action-card ${emphasis}">
      <div class="dashboard-action-top">
        <div class="metric-icon large" aria-hidden="true">${icon}</div>
        <span class="tag">โอกาสวันนี้</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="muted">${escapeHtml(reason)}</p>
      <div class="dashboard-action-revenue">${money(revenue)} บาท</div>
      <div class="dashboard-action-footer">
        <span>Estimated revenue</span>
        <button class="button ${emphasis ? "primary" : "secondary"}" type="button" data-view-shortcut="${escapeHtml(targetView)}">${escapeHtml(action)}</button>
      </div>
    </article>
  `;
}

function brandName() {
  return app.data?.settings?.businessName || "Growup";
}

function last7DaysSales() {
  const base = app.data.summary?.selectedDate || todayISO();
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDaysISO(base, index - 6);
    const total = app.data.orders
      .filter(order => order.date === date)
      .reduce((sum, order) => sum + Number(order.amount || 0), 0);
    return { date, total };
  });
}

function ordersToday() {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  return app.data.orders.filter(order => order.date === selectedDate);
}

function newCustomersToday() {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  return app.data.customers.filter(customer => customer.firstPurchaseDate === selectedDate);
}

function repeatCustomersToday() {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  const ids = new Set(app.data.orders.filter(order => order.date === selectedDate).map(order => order.customerId));
  return app.data.customers.filter(customer => ids.has(customer.id) && Number(customer.purchaseCount || 0) > 1);
}

function estimatedOpportunityRevenue(customers, ratio = 0.35, fallback = 750) {
  return customers.reduce((sum, customer) => {
    const base = Number(customer.lastAmount || customer.totalSpent / Math.max(customer.purchaseCount || 1, 1) || fallback);
    return sum + Math.round(base * ratio);
  }, 0);
}

function groupedProducts() {
  const map = new Map();
  for (const order of app.data.orders) {
    const name = String(order.items || "Growup Formula").trim() || "Growup Formula";
    if (!map.has(name)) {
      map.set(name, {
        name,
        soldCount: 0,
        orderCount: 0,
        revenue: 0
      });
    }
    const item = map.get(name);
    item.soldCount += Number(order.jars || 0);
    item.orderCount += 1;
    item.revenue += Number(order.amount || 0);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

function channelPerformance() {
  const map = new Map();
  for (const order of app.data.orders) {
    const name = summarizeSalesChannel(displayOrderChannel(order));
    if (!map.has(name)) map.set(name, { name, orders: 0, revenue: 0 });
    const item = map.get(name);
    item.orders += 1;
    item.revenue += Number(order.amount || 0);
  }
  return [...map.values()]
    .map(item => ({
      ...item,
      roi: item.orders ? Math.round(item.revenue / item.orders) : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function notificationItems() {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  const duplicates = [];
  const seen = new Map();
  for (const order of app.data.orders) {
    const key = `${String(order.orderNumber || "").trim().toLowerCase()}|${order.date}`;
    if (!String(order.orderNumber || "").trim()) continue;
    if (seen.has(key)) duplicates.push(order);
    else seen.set(key, order.id);
  }
  const due = app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= selectedDate);
  const vip = app.data.customers.filter(customer => customer.vipLevel === "NORMAL" && Number(customer.totalSpent || 0) >= Number(app.data.settings.vipThresholds?.vip || 5000) * 0.8);
  const lowStock = groupedProducts().map(product => ({
    ...product,
    stockEstimate: Math.max(0, 120 - product.soldCount)
  })).filter(product => product.stockEstimate <= 25);
  const opportunities = opportunityCardsData();
  return [
    { type: "duplicate orders", title: "ออเดอร์ซ้ำที่ควรตรวจสอบ", count: duplicates.length, detail: "ตรวจเลขออเดอร์ซ้ำก่อนปิดยอด" },
    { type: "follow-up customers", title: "ลูกค้าที่ควรติดตาม", count: due.length, detail: "พร้อมโทรหรือ Broadcast ได้ทันที" },
    { type: "VIP reminders", title: "ลูกค้าใกล้เป็น VIP", count: vip.length, detail: "กระตุ้นอีกนิดเพื่อเพิ่มโอกาสซื้อซ้ำ" },
    { type: "stock alerts", title: "สินค้าใกล้หมดสต๊อก", count: lowStock.length, detail: "เช็ก stock ก่อนรอบขายถัดไป" },
    { type: "sales opportunities", title: "โอกาสเพิ่มรายได้วันนี้", count: opportunities.length, detail: `มูลค่าประมาณ ${money(opportunities.reduce((sum, item) => sum + item.revenue, 0))} บาท` }
  ];
}

function opportunityCardsData() {
  const selectedMonth = (app.data.summary?.selectedDate || todayISO()).slice(0, 7);
  const notBoughtThisMonth = app.data.customers.filter(customer => !customer.lastPurchaseDate || !String(customer.lastPurchaseDate).startsWith(selectedMonth));
  const noVip = app.data.customers.filter(customer => customer.vipLevel === "NORMAL" && Number(customer.totalSpent || 0) > 0);
  const due = app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= (app.data.summary?.selectedDate || todayISO()));
  const bestSellerProducts = groupedProducts().slice(0, 3);
  const lowStockProducts = groupedProducts().map(product => ({
    ...product,
    stockEstimate: Math.max(0, 120 - product.soldCount)
  })).filter(product => product.stockEstimate <= 25);
  return [
    {
      id: "sleeping",
      title: "ลูกค้าเก่ายังไม่ซื้อในเดือนนี้",
      count: notBoughtThisMonth.length,
      revenue: estimatedOpportunityRevenue(notBoughtThisMonth, 0.42),
      action: "เปิดรายชื่อลูกค้า",
      targetView: "customers",
      description: "รีเทิร์นลูกค้าเดิมที่เคยสั่งแล้ว แต่เดือนนี้ยังเงียบอยู่"
    },
    {
      id: "vip",
      title: "ลูกค้ายังไม่ได้ VIP",
      count: noVip.length,
      revenue: estimatedOpportunityRevenue(noVip, 0.28),
      action: "ดูโอกาสอัป VIP",
      targetView: "customers",
      description: "เสนอชุดใหญ่หรือสิทธิพิเศษเพื่อดันยอดสะสม"
    },
    {
      id: "followup",
      title: "ลูกค้าที่ควรติดตาม",
      count: due.length,
      revenue: estimatedOpportunityRevenue(due, 0.36),
      action: "เปิดแจ้งเตือน",
      targetView: "notifications",
      description: "กลุ่มพร้อมปิดการขายซ้ำเร็วที่สุด"
    },
    {
      id: "best-seller",
      title: "สินค้าขายดีที่ควรดันต่อ",
      count: bestSellerProducts.length,
      revenue: bestSellerProducts.reduce((sum, item) => sum + Math.round(item.revenue * 0.18), 0),
      action: "ไปหน้าสินค้า",
      targetView: "products",
      description: "สินค้าที่ยอดดีอยู่แล้ว เหมาะกับโปรโมชันต่อเนื่อง"
    },
    {
      id: "low-stock",
      title: "สินค้าใกล้หมดสต๊อก",
      count: lowStockProducts.length,
      revenue: lowStockProducts.reduce((sum, item) => sum + Math.round(item.revenue * 0.1), 0),
      action: "เช็กสต๊อก",
      targetView: "products",
      description: "กันไม่ให้พลาดยอดขายเพราะของหมด"
    }
  ];
}

function renderLogin() {
  els.content.innerHTML = `
    <section class="login-layout">
      <div class="login-desktop-card">
        <aside class="login-brand-panel">
          <img class="login-brand-mark" src="/icons/logo.png?v=20260701-growup-logo-refresh" alt="" aria-hidden="true">
          <div>
            <p class="eyebrow">Growup Pilot</p>
            <h2>ผู้ช่วยเจ้าของธุรกิจที่ทำให้ธุรกิจเติบโต</h2>
            <p>เพิ่มยอดขาย ลดงาน วางแผน วิเคราะห์ธุรกิจ และช่วยตัดสินใจด้วย AI ในที่เดียว</p>
          </div>
        </aside>
        <form class="login-card" id="loginForm">
          <img class="login-logo" src="/icons/logo.png?v=20260701-growup-logo-refresh" alt="" aria-hidden="true">
          <div class="section-title">
            <h2>Growup Pilot</h2>
          </div>
          <label>Username
            <input name="username" autocomplete="username" required placeholder="Username">
          </label>
          <label>Password
            <input name="password" autocomplete="current-password" type="password" required placeholder="Password">
          </label>
          <button class="button primary" type="submit">เข้าสู่ระบบ</button>
        </form>
      </div>
    </section>
  `;
}

function customerRow(customer) {
  return `
    <tr data-customer="${escapeHtml(customer.id)}">
      <td data-label="ลูกค้า">
        <button class="table-identity" type="button" data-open-customer="${escapeHtml(customer.id)}">
          <span class="avatar">${escapeHtml(initials(customer.name))}</span>
          <span>
            <strong>${escapeHtml(customer.name)}</strong>
            <small>${escapeHtml(customer.socialName || customer.address || "โปรไฟล์ลูกค้า")}</small>
          </span>
        </button>
      </td>
      <td data-label="เบอร์โทร">${escapeHtml(customer.phone || "-")}</td>
      <td data-label="จำนวนซื้อ">${money(customer.purchaseCount || 0)} ครั้ง</td>
      <td data-label="ยอดรวม">${money(customer.totalSpent)} บาท</td>
      <td data-label="ซื้อล่าสุด">${formatShortDate(customer.lastPurchaseDate)}</td>
      <td data-label="VIP">${vipBadge(customer.vipLevel)}</td>
      <td data-label="สถานะ">${badge(customer.status || "NORMAL")}</td>
      <td data-label="จัดการ">
        <div class="table-actions">
          <button class="button ghost compact-action" type="button" data-open-customer="${escapeHtml(customer.id)}">ดู</button>
          ${customer.purchaseCount === 0 ? `<button class="button danger compact-action" type="button" data-delete-customer="${escapeHtml(customer.id)}">ลบ</button>` : ""}
        </div>
      </td>
    </tr>
  `;
}

function customerTable(customers, emptyText = "ไม่พบข้อมูลลูกค้า") {
  if (!customers.length) return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="workspace-table-wrap mobile-stack-wrap">
      <table class="workspace-table mobile-stack-table">
        <thead>
          <tr>
            <th>ลูกค้า</th>
            <th>เบอร์โทร</th>
            <th>จำนวนซื้อ</th>
            <th>ยอดรวม</th>
            <th>ซื้อล่าสุด</th>
            <th>VIP</th>
            <th>สถานะ</th>
            <th>จัดการ</th>
          </tr>
        </thead>
        <tbody>
          ${customers.map(customerRow).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function orderCard(order) {
  return `
    <tr data-order-id="${escapeHtml(order.id)}">
      <td data-label="ออเดอร์"><strong>${escapeHtml(order.orderNumber || "-")}</strong></td>
      <td data-label="ลูกค้า">
        <button class="table-identity" type="button" data-open-customer="${escapeHtml(order.customerId)}">
          <span class="avatar">${escapeHtml(initials(order.customerName || "-"))}</span>
          <span>
            <strong>${escapeHtml(order.customerName || "-")}</strong>
            <small>${escapeHtml(order.socialName || order.phone || "-")}</small>
          </span>
        </button>
      </td>
      <td data-label="วันที่">${formatShortDate(order.date)}</td>
      <td data-label="ช่องทาง">${escapeHtml(displayOrderChannel(order))}</td>
      <td data-label="จำนวน">${money(order.jars || 0)} กระปุก</td>
      <td data-label="ยอดซื้อ">${money(order.amount)} บาท</td>
      <td data-label="สถานะ">${badge(order.status === "NEW" ? "NEW" : order.vipLevel)}</td>
      <td data-label="จัดการ">
        <div class="table-actions">
          <button class="button ghost compact-action" type="button" data-open-customer="${escapeHtml(order.customerId)}">ดู</button>
          <button class="button secondary compact-action" type="button" data-edit-order="${escapeHtml(order.id)}">แก้ไข</button>
          <button class="button danger compact-action" type="button" data-delete-order="${escapeHtml(order.id)}">ลบ</button>
        </div>
      </td>
    </tr>
  `;
}

function orderTable(orders) {
  if (!orders.length) return `<div class="empty-state">ยังไม่มีออเดอร์ในวันที่เลือก</div>`;
  const sorted = sortOrdersAscending(orders);
  return `
    <div class="workspace-table-wrap mobile-stack-wrap" id="orderList">
      <table class="workspace-table mobile-stack-table">
        <thead>
          <tr>
            <th>ออเดอร์</th>
            <th>ลูกค้า</th>
            <th>วันที่</th>
            <th>ช่องทาง</th>
            <th>จำนวน</th>
            <th>ยอดซื้อ</th>
            <th>สถานะ</th>
            <th>จัดการ</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(orderCard).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDashboard() {
  const s = app.data.summary;
  const due = sortByPriority(app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= s.selectedDate)).slice(0, 8);
  const sales7 = last7DaysSales();
  const topProducts = groupedProducts().slice(0, 5);
  const recentOrders = sortOrdersAscending(app.data.orders.filter(order => order.date <= s.selectedDate)).slice(-5).reverse();
  const returningToday = repeatCustomersToday();
  const opportunities = opportunityCardsData();
  const revenueOpportunity = opportunities.reduce((sum, item) => sum + item.revenue, 0);
  const salesMax = Math.max(1, ...sales7.map(item => item.total));
  const channels = channelPerformance().slice(0, 3);
  const yesterday = addDaysISO(s.selectedDate, -1);
  const yesterdayOrders = app.data.orders.filter(order => order.date === yesterday);
  const yesterdaySales = yesterdayOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const yesterdayOrderCount = yesterdayOrders.length;
  const yesterdayNewCustomers = app.data.customers.filter(customer => customer.firstPurchaseDate === yesterday).length;
  const yesterdayReturning = app.data.orders.filter(order => order.date === yesterday)
    .filter(order => {
      const customer = app.data.customers.find(item => item.id === order.customerId);
      return Number(customer?.purchaseCount || 0) > 1;
    }).length;
  const salesDelta = dashboardDelta(s.salesToday, yesterdaySales, "currency");
  const ordersDelta = dashboardDelta(s.ordersToday || 0, yesterdayOrderCount);
  const newCustomersDelta = dashboardDelta(newCustomersToday().length, yesterdayNewCustomers);
  const returningDelta = dashboardDelta(returningToday.length, yesterdayReturning);
  const priorityOpportunities = opportunities
    .slice()
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 4);
  const vipCustomers = sortByPriority(app.data.customers.filter(customer => ["VIP", "VVIP", "SUPER VIP"].includes(customer.vipLevel))).slice(0, 4);
  const lowStockProducts = groupedProducts()
    .map(product => ({ ...product, stockEstimate: Math.max(0, 120 - product.soldCount) }))
    .filter(product => product.stockEstimate <= 35)
    .slice(0, 4);
  const todayActions = [
    {
      title: "โทรหาลูกค้าเก่า",
      reason: "ลูกค้าเก่าที่ยังไม่ซื้อในเดือนนี้ตอบรับไวที่สุดเมื่อมีคนโทรตาม",
      revenue: opportunities.find(item => item.id === "sleeping")?.revenue || 0,
      action: "ดูลูกค้าเก่า",
      targetView: "customers",
      icon: "☎",
      emphasis: "featured"
    },
    {
      title: "ติดตามลูกค้า VIP",
      reason: "ลูกค้าใกล้ VIP และลูกค้าเดิมมูลค่าสูงมีโอกาสปิดยอดเฉลี่ยมากกว่า",
      revenue: Math.round((opportunities.find(item => item.id === "vip")?.revenue || 0) * 0.7),
      action: "ดูรายชื่อ VIP",
      targetView: "customers",
      icon: "✦"
    },
    {
      title: "ส่ง Broadcast",
      reason: "ใช้ Broadcast กระตุ้นลูกค้าที่ยังเงียบและลูกค้าที่ถึงเวลาติดตาม",
      revenue: Math.round((opportunities.find(item => item.id === "followup")?.revenue || 0) * 0.8),
      action: "เตรียมข้อความ",
      targetView: "broadcast",
      icon: "✉"
    },
    {
      title: "ดันโปรขายดี",
      reason: "สินค้าขายดีและช่องทางทำเงินเด่นควรถูกโปรโมตต่อในวันนี้",
      revenue: Math.round((opportunities.find(item => item.id === "best-seller")?.revenue || 0) * 0.9),
      action: "ดูสินค้าเด่น",
      targetView: "products",
      icon: "↗"
    }
  ];

  els.content.innerHTML = `
    <section class="section saas-page dashboard-page">
      <div class="page-identity hero-command">
        <div class="page-identity-copy">
          <span class="page-kicker">Business Command Center</span>
          <h2>AI Morning Brief</h2>
          <p>วันนี้เจ้าของธุรกิจควรโฟกัสงานที่เปลี่ยนเป็นรายได้ได้เร็วที่สุดจากยอดขาย ลูกค้า และสัญญาณในระบบ</p>
          <div class="hero-big-number">${money(revenueOpportunity)} บาท</div>
          <div class="inline">
            <button class="button primary" type="button" data-view-shortcut="opportunities">ดูโอกาสทำเงิน</button>
            <button class="button ghost" type="button" data-view-shortcut="broadcast">เตรียม Broadcast</button>
          </div>
        </div>
        <div class="identity-side-stack">
          <article class="glass-card">
            <span class="tag">Today&apos;s focus</span>
            <h3>${escapeHtml(priorityOpportunities[0]?.title || "ยังไม่มีโอกาสเด่นวันนี้")}</h3>
            <p class="muted">${escapeHtml(priorityOpportunities[0]?.description || "เมื่อมีข้อมูลเพิ่ม ระบบจะแนะนำ action ที่ทำเงินได้ก่อน")}</p>
            <strong>${money(priorityOpportunities[0]?.revenue || 0)} บาท</strong>
          </article>
          <article class="glass-card compact">
            <span class="tag">Revenue forecast</span>
            <strong>${money(Math.round((s.salesToday || 0) + revenueOpportunity * 0.42))} บาท</strong>
            <p class="muted">คาดการณ์แบบระมัดระวังถ้าทีมทำตาม action priority วันนี้</p>
          </article>
        </div>
      </div>
      <div class="metric-grid premium-metric-grid">
        ${dashboardKpiCard({ label: "ยอดขายวันนี้", value: `${money(s.salesToday)} บาท`, tone: "accent", delta: salesDelta, hint: "ยอดรวมจากออเดอร์ที่ปิดแล้ววันนี้", icon: "฿" })}
        ${dashboardKpiCard({ label: "ออเดอร์วันนี้", value: money(s.ordersToday || 0), delta: ordersDelta, hint: "จำนวนออเดอร์ที่เข้ามาในวันทำงานนี้", icon: "◫" })}
        ${dashboardKpiCard({ label: "ลูกค้าใหม่วันนี้", value: money(newCustomersToday().length), tone: "green", delta: newCustomersDelta, hint: "ลูกค้าที่เพิ่งซื้อครั้งแรกในวันนี้", icon: "+" })}
        ${dashboardKpiCard({ label: "ลูกค้าเก่ากลับมาซื้อ", value: money(returningToday.length), delta: returningDelta, hint: "ลูกค้าเดิมที่ช่วยดันยอดได้เร็วที่สุด", icon: "⟳" })}
      </div>
      <div class="dashboard-story-grid">
        <div class="panel stack panel-premium spotlight-panel">
          <div class="section-header">
            <div class="section-title">
              <h2>Today&apos;s Opportunities</h2>
              <p>งานที่มีแนวโน้มเปลี่ยนเป็นยอดขายได้เร็วที่สุดในวันนี้</p>
            </div>
            <span class="status-dot live">สดจากข้อมูลล่าสุด</span>
          </div>
          <div class="dashboard-action-grid">
            ${priorityOpportunities.map((card, index) => dashboardActionCard({
              title: card.title,
              reason: card.description,
              revenue: card.revenue,
              action: card.action,
              targetView: card.targetView,
              icon: index === 0 ? "↗" : index === 1 ? "★" : index === 2 ? "☎" : "▣",
              emphasis: index === 0 ? "featured" : ""
            })).join("")}
          </div>
        </div>
        <div class="panel stack panel-premium summary-side-panel">
          <div class="section-title">
            <h2>Quick snapshot</h2>
            <p>ตัวเลขที่ช่วยตัดสินใจก่อนเริ่มวัน</p>
          </div>
          <div class="list-table premium-list">
            <div class="list-row compact elevated-row">
              <div><strong>ยอดขายเดือนนี้</strong><p class="muted">เทียบจากออเดอร์ที่บันทึกแล้ว</p></div>
              <strong>${money(s.salesThisMonth)} บาท</strong>
            </div>
            <div class="list-row compact elevated-row">
              <div><strong>ควรติดตามวันนี้</strong><p class="muted">ลูกค้าที่ถึงเวลาคุยต่อ</p></div>
              <strong>${money(s.dueToday)} ราย</strong>
            </div>
            <div class="list-row compact elevated-row">
              <div><strong>VIP / VVIP / SUPER</strong><p class="muted">ฐานลูกค้าคุณภาพของร้าน</p></div>
              <strong>${s.vip} / ${s.vvip} / ${s.superVip}</strong>
            </div>
            <div class="list-row compact elevated-row">
              <div><strong>ช่องทางเด่น</strong><p class="muted">ช่องทางที่รายได้วิ่งดีที่สุดวันนี้</p></div>
              <strong>${escapeHtml(channels[0]?.name || "ยังไม่มีข้อมูล")}</strong>
            </div>
          </div>
        </div>
      </div>
      <div class="panel stack panel-premium">
        <div class="section-title">
          <h2>Quick Actions</h2>
          <p>ลิสต์งานที่ช่วยให้ได้เงินเพิ่ม ไม่ใช่แค่ดูรายงาน</p>
        </div>
        <div class="dashboard-action-grid">
          ${todayActions.map(card => dashboardActionCard(card)).join("")}
        </div>
      </div>
      <div class="dashboard-command-grid">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>Follow-up Tasks</h2>
            <p>ลูกค้าที่ควรโทรหรือทักก่อนหมดวัน</p>
          </div>
          ${followupCards(due.slice(0, 4), true)}
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>VIP Customers</h2>
            <p>ลูกค้ามูลค่าสูงที่ควรรักษาความสัมพันธ์</p>
          </div>
          <div class="list-table premium-list">
            ${vipCustomers.map(customer => `
              <button class="list-row rich-row elevated-row" type="button" data-open-customer="${escapeHtml(customer.id)}">
                <div>
                  <strong>${escapeHtml(customer.name)}</strong>
                  <p class="muted">ยอดสะสม ${money(customer.totalSpent)} บาท · ซื้อ ${money(customer.purchaseCount || 0)} ครั้ง</p>
                </div>
                <div class="rich-row-side">
                  ${vipBadge(customer.vipLevel)}
                </div>
              </button>
            `).join("") || `<div class="empty-state">ยังไม่มีลูกค้า VIP ที่โดดเด่น</div>`}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>Inventory Alerts</h2>
            <p>สินค้าใกล้หมดที่อาจกระทบโอกาสทำเงิน</p>
          </div>
          <div class="list-table premium-list">
            ${lowStockProducts.map(product => `
              <div class="list-row rich-row elevated-row">
                <div>
                  <strong>${escapeHtml(product.name)}</strong>
                  <p class="muted">คาดว่าสต๊อกเหลือ ${money(product.stockEstimate)} · ขายแล้ว ${money(product.soldCount)} ชิ้น</p>
                </div>
                <strong>${money(product.revenue)} บาท</strong>
              </div>
            `).join("") || `<div class="empty-state">ยังไม่มีสินค้าใกล้หมด</div>`}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>AI Recommendations</h2>
            <p>ข้อแนะนำที่พร้อมนำไปใช้ต่อทันที</p>
          </div>
          <div class="recommendation-list">
            ${channels.map(channel => `
              <article class="recommendation-card">
                <strong>ดันช่องทาง ${escapeHtml(channel.name)}</strong>
                <p class="muted">รายได้เฉลี่ยต่อออเดอร์ ${money(channel.roi)} บาท และยังเป็นช่องทางหลักของร้านในช่วงนี้</p>
              </article>
            `).join("")}
            <article class="recommendation-card">
              <strong>จัดลำดับรายชื่อลูกค้าก่อน 17:00</strong>
              <p class="muted">กลุ่ม follow-up และลูกค้าเก่าที่ยังไม่ซื้อในเดือนนี้มีโอกาสปิดยอดเร็วที่สุด</p>
            </article>
          </div>
        </div>
      </div>
      <div class="dashboard-grid-2">
        <div class="panel stack panel-premium">
          <div class="section-header">
            <div class="section-title">
              <h2>Recent Activities</h2>
              <p>ออเดอร์และกิจกรรมล่าสุดที่ควรเห็นในมุมเดียว</p>
            </div>
            <button class="button secondary" data-view-shortcut="orders">ไปหน้าออเดอร์</button>
          </div>
          <div class="list-table premium-list">
            ${recentOrders.map(order => `
              <button class="list-row rich-row elevated-row" type="button" data-open-customer="${escapeHtml(order.customerId)}">
                <div>
                  <strong>${escapeHtml(order.customerName || "-")}</strong>
                  <p class="muted">${escapeHtml(order.orderNumber || "-")} · ${formatDate(order.date)} · ${escapeHtml(displayOrderChannel(order))}</p>
                </div>
                <div class="rich-row-side">
                  ${badge(order.status === "NEW" ? "NEW" : order.vipLevel)}
                  <strong>${money(order.amount)} บาท</strong>
                </div>
              </button>
            `).join("") || `<div class="empty-state">ยังไม่มีออเดอร์ล่าสุด</div>`}
          </div>
        </div>
        <div class="panel stack panel-premium sales-panel">
          <div class="section-title">
            <h2>Today&apos;s Revenue</h2>
            <p>Momentum รายได้ย้อนหลัง 7 วัน พร้อมสัญญาณเร่งหรือชะลอ</p>
          </div>
          <div class="bar-list">
            ${sales7.map(item => `
              <div class="bar-row">
                <strong>${formatShortDate(item.date)}</strong>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(5, item.total / salesMax * 100)}%"></div></div>
                <span>${money(item.total)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="dashboard-grid-2">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>Top Products</h2>
            <p>ใช้ข้อมูลสินค้าที่มีอยู่ในระบบ ถ้ายังไม่มีหลาย SKU จะแสดงภาพรวมตัวหลัก</p>
          </div>
          <div class="list-table premium-list">
            ${topProducts.map(product => `
              <div class="list-row rich-row elevated-row">
                <div>
                  <strong>${escapeHtml(product.name)}</strong>
                  <p class="muted">ขายแล้ว ${money(product.soldCount)} ชิ้น · ${money(product.orderCount)} ออเดอร์</p>
                </div>
                <strong>${money(product.revenue)} บาท</strong>
              </div>
            `).join("") || `<div class="empty-state">ยังไม่มีข้อมูลสินค้า</div>`}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>Sales Opportunities</h2>
            <p>รายการที่ลงมือแล้วมีโอกาสเห็นผลเร็วที่สุด</p>
          </div>
          ${followupCards(due.slice(0, 4), true)}
        </div>
      </div>
    </section>
  `;
}

function addDaysISO(dateValue, amount) {
  const [y, m, d] = String(dateValue).split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + amount);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function diffDaysISO(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  return Math.round((to - from) / 86400000);
}

function followupRange() {
  const base = app.data.summary.selectedDate;
  if (app.followupMode === "tomorrow") return { label: "พรุ่งนี้", start: addDaysISO(base, 1), end: addDaysISO(base, 1) };
  if (app.followupMode === "week") return { label: "สัปดาห์นี้", start: base, end: addDaysISO(base, 7) };
  if (app.followupMode === "custom") return { label: "เลือกวันที่", start: base, end: base };
  if (app.followupMode === "overdue") return { label: "เลยกำหนดแล้ว", start: "", end: addDaysISO(base, -1) };
  return { label: "วันนี้", start: base, end: base };
}

function renderOrders() {
  const selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
  const q = app.ordersFilterQ.trim().toLowerCase();
  if (app.ordersFilterDraft === "") app.ordersFilterDraft = app.ordersFilterQ;
  const orders = app.data.orders.filter(order => {
    const dateMatch = app.ordersShowAll || order.date === selectedDate;
    const textMatch = !q || [
      order.orderNumber,
      order.customerName,
      order.phone,
      order.alternatePhone,
      order.socialName,
      order.tags,
      order.note
    ].join(" ").toLowerCase().includes(q);
    return dateMatch && textMatch;
  });
  const totalSales = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const topChannel = channelPerformance()[0]?.name || "ยังไม่มีข้อมูล";
  els.content.innerHTML = `
    <section class="section saas-page orders-page">
      <div class="page-identity workspace-hero orders-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Order Management Workspace</span>
          <h2>${app.ordersShowAll ? "ออเดอร์ทั้งหมด" : `ออเดอร์วันที่ ${formatDate(selectedDate)}`}</h2>
          <p id="ordersCountText">${app.ordersShowAll ? `แสดง ${money(orders.length)} ออเดอร์จากทุกวัน` : `แสดง ${money(orders.length)} ออเดอร์จากวันที่เลือก`}</p>
        </div>
        <div class="orders-header-actions">
          <label class="orders-show-all">
            <input type="checkbox" data-orders-show-all ${app.ordersShowAll ? "checked" : ""}>
            <span>แสดงทั้งหมด</span>
          </label>
          <button class="button primary" data-open-order>+ เพิ่มออเดอร์</button>
          <div class="import-menu">
            <button class="button secondary" type="button" data-toggle-import-menu>Import ▾</button>
            <div id="ordersImportMenu" class="import-dropdown" hidden>
              <button class="dropdown-item" type="button" data-orders-import-action="csv">Import CSV</button>
              <button class="dropdown-item" type="button" data-orders-import-action="excel">Import Excel</button>
              <a class="dropdown-item" href="/api/export/orders">Export</a>
              <a class="dropdown-item" href="/templates/order-import-template.xlsx" download>Download Template</a>
            </div>
          </div>
        </div>
      </div>
      <div class="workspace-stat-grid">
        ${metric("ยอดขายในมุมมองนี้", `${money(totalSales)} บาท`, "accent")}
        ${metric("จำนวนออเดอร์", `${money(orders.length)} รายการ`)}
        ${metric("ช่องทางเด่น", topChannel, "green")}
      </div>
      <div class="panel stack panel-premium">
        <div class="section-title">
          <h2>ค้นหาและกรองออเดอร์</h2>
          <p>Import อยู่เฉพาะหน้านี้ตาม workflow เดิม พร้อม workspace ที่อ่านง่ายขึ้น</p>
        </div>
        <div class="filters">
          <div class="orders-search-row">
            <input class="orders-search-input" data-order-filter="q" placeholder="ค้นหาเลขออเดอร์ ชื่อ หรือเบอร์โทร" value="${escapeHtml(app.ordersFilterDraft)}">
            <button class="button primary orders-search-button" data-order-search type="button">ค้นหา</button>
          </div>
        </div>
      </div>
      ${orderTable(orders)}
    </section>
  `;
}

function applyCustomerFilters() {
  const q = app.filters.q.trim().toLowerCase();
  const selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
  return app.data.customers.filter(customer => {
    const dateMatch = app.customersShowAll || (customer.orders || []).some(order => order.date === selectedDate);
    const textMatch = !q || [
      customer.name,
      customer.phone,
      customer.alternatePhone,
      customer.address,
      customer.originSource,
      customer.socialName,
      ...(customer.tags || []),
      ...(customer.orders || []).flatMap(order => [
        order.orderNumber,
        order.customerName,
        order.phone,
        order.alternatePhone,
        order.socialName,
        order.originSource,
        order.tags,
        order.note
      ])
    ].join(" ").toLowerCase().includes(q);
    const tagMatch = !app.filters.tag || (customer.tags || []).includes(app.filters.tag);
    const statusMatch = !app.filters.status || customer.status === app.filters.status;
    const vipMatch = !app.filters.vip || customer.vipLevel === app.filters.vip;
    return dateMatch && textMatch && tagMatch && statusMatch && vipMatch;
  });
}

function renderSearch() {
  const selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
  const customers = sortByPriority(applyCustomerFilters());
  els.content.innerHTML = `
    <section class="section saas-page customers-page">
      <div class="page-identity workspace-hero customers-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Customer Intelligence</span>
          <h2>${app.customersShowAll ? "ลูกค้าทั้งหมด" : `ลูกค้าที่สั่งซื้อวันที่ ${formatDate(selectedDate)}`}</h2>
          <p>${app.customersShowAll ? "ค้นหาลูกค้า ดูยอดซื้อรวม ครั้งที่ซื้อ และสถานะ VIP ได้ครบ" : "แสดงเฉพาะลูกค้าที่มีออเดอร์ในวันที่เลือก"}</p>
        </div>
        <div class="workspace-stat-grid compact">
          ${metric("ลูกค้าในมุมมองนี้", `${money(customers.length)} ราย`)}
          ${metric("VIP", `${money(customers.filter(customer => customer.vipLevel !== "NORMAL").length)} ราย`, "purple")}
          ${metric("ยอดรวม", `${money(customers.reduce((sum, customer) => sum + Number(customer.totalSpent || 0), 0))} บาท`, "green")}
        </div>
      </div>
      <div class="panel stack panel-premium">
        <div class="section-title section-title-actions">
          <div>
            <h2>ค้นหาและจัดกลุ่มลูกค้า</h2>
            <p>มุมมองแบบ workspace สำหรับทีมขายและทีมดูแลลูกค้า</p>
          </div>
          <div class="orders-header-actions">
            <label class="orders-show-all">
              <input type="checkbox" data-customers-show-all ${app.customersShowAll ? "checked" : ""}>
              <span>แสดงทั้งหมด</span>
            </label>
          </div>
        </div>
        <div class="filters customers-filters">
          <input data-filter="q" placeholder="ค้นหาชื่อ เบอร์ อาการลูกค้า" value="${escapeHtml(app.filters.q)}">
          <select data-filter="tag">
            <option value="">ทุกอาการลูกค้า</option>
            ${app.data.tags.map(tag => `<option value="${escapeHtml(tag)}" ${app.filters.tag === tag ? "selected" : ""}>${escapeHtml(tag)}</option>`).join("")}
          </select>
          <select data-filter="status">
            <option value="">ทุกสถานะ</option>
            ${["NEW", "NORMAL", "VIP", "VVIP", "SUPER VIP", "AT RISK", "LOST"].map(status => `<option ${app.filters.status === status ? "selected" : ""}>${status}</option>`).join("")}
          </select>
          <select data-filter="vip">
            <option value="">ทุก VIP Level</option>
            ${["NORMAL", "VIP", "VVIP", "SUPER VIP"].map(level => `<option ${app.filters.vip === level ? "selected" : ""}>${level}</option>`).join("")}
          </select>
          <button class="button ghost" data-reset-filters>ล้างตัวกรอง</button>
        </div>
      </div>
      <div id="searchResults">${customerTable(customers)}</div>
    </section>
  `;
}

function renderOpportunities() {
  const cards = opportunityCardsData();
  els.content.innerHTML = `
    <section class="section saas-page opportunities-page">
      <div class="page-identity workspace-hero opportunities-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Revenue Opportunity Engine</span>
          <h2>โอกาสทำเงินที่ควรลงมือวันนี้</h2>
          <p>รวมลูกค้าและสินค้าที่มีสัญญาณพร้อมสร้างรายได้เพิ่ม พร้อมปุ่มลัดไปหน้าที่เกี่ยวข้องทันที</p>
        </div>
      </div>
      <div class="opportunity-grid">
        ${cards.map(card => `
          <article class="opportunity-card">
            <div>
              <span class="tag">${money(card.count)} รายการ</span>
            </div>
            <div class="stack">
              <h3>${escapeHtml(card.title)}</h3>
              <p class="muted">${escapeHtml(card.description)}</p>
            </div>
            <div class="opportunity-score">${money(card.revenue)} บาท</div>
            <div class="opportunity-meta">
              <span>Estimated revenue</span>
              <strong>${money(card.revenue)} บาท</strong>
            </div>
            <button class="button primary" type="button" data-view-shortcut="${escapeHtml(card.targetView)}">${escapeHtml(card.action)}</button>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderProducts() {
  const products = groupedProducts();
  els.content.innerHTML = `
    <section class="section saas-page products-page">
      <div class="page-identity workspace-hero products-hero">
        <div>
          <span class="page-kicker">Inventory Intelligence</span>
          <h2>สินค้าและสต๊อก</h2>
          <p>สรุปจากข้อมูลออเดอร์เดิมที่มีอยู่ในระบบ โดยคงความเข้ากันได้กับฐานข้อมูลปัจจุบัน</p>
        </div>
        <button class="button secondary" type="button" data-view-shortcut="reports">ดูรายงานสินค้า</button>
      </div>
      <div class="product-grid">
        ${products.map((product, index) => {
          const stockEstimate = Math.max(0, 120 - product.soldCount);
          const status = stockEstimate <= 25 ? "ใกล้หมด" : index === 0 ? "ขายดี" : "พร้อมขาย";
          return `
            <article class="product-card">
              <div class="inline"><span class="tag">${escapeHtml(status)}</span></div>
              <h3>${escapeHtml(product.name)}</h3>
              <div class="mini-stats">
                <div class="mini-stat"><span>Stock</span><strong>${money(stockEstimate)}</strong></div>
                <div class="mini-stat"><span>ขายแล้ว</span><strong>${money(product.soldCount)}</strong></div>
                <div class="mini-stat"><span>ออเดอร์</span><strong>${money(product.orderCount)}</strong></div>
                <div class="mini-stat"><span>ยอดขาย</span><strong>${money(product.revenue)} บาท</strong></div>
              </div>
            </article>
          `;
        }).join("") || `<div class="empty-state">ยังไม่มีข้อมูลสินค้า</div>`}
      </div>
    </section>
  `;
}

function renderMarketing() {
  const channels = channelPerformance();
  els.content.innerHTML = `
    <section class="section saas-page marketing-page">
      <div class="page-identity workspace-hero marketing-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Marketing Performance Center</span>
          <h2>การตลาดที่ควรเร่งวันนี้</h2>
          <p>ดูช่องทางที่สร้างยอดได้ดีที่สุดจากออเดอร์ที่มีอยู่ พร้อมข้อเสนอ action สำหรับทีม</p>
        </div>
      </div>
      <div class="marketing-grid">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>Channel performance</h2>
            <p>ดูช่องทางที่สร้างยอดได้ดีที่สุดจากออเดอร์ที่มีอยู่</p>
          </div>
          <div class="bar-list">
            ${channels.map(channel => `
              <div class="bar-row">
                <strong>${escapeHtml(channel.name)}</strong>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, channel.revenue / Math.max(...channels.map(item => item.revenue), 1) * 100)}%"></div></div>
                <span>${money(channel.revenue)} บาท</span>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>คำแนะนำการตลาด</h2>
            <p>แนะนำแบบปลอดภัยแม้ backend ด้าน campaign ยังไม่ครบ</p>
          </div>
          <article class="insight-card">
            <h3>Recommended promotion</h3>
            <p class="muted">ดันช่องทาง ${escapeHtml(channels[0]?.name || "หลัก")} ต่ออีก 7 วัน พร้อมชุดข้อเสนอสำหรับลูกค้าเก่าที่ยังไม่ซื้อในเดือนนี้</p>
            <div class="mini-stats">
              <div class="mini-stat"><span>ROI proxy</span><strong>${money(channels[0]?.roi || 0)}</strong></div>
              <div class="mini-stat"><span>Broadcast suggestion</span><strong>${money(opportunityCardsData()[0]?.count || 0)} รายชื่อ</strong></div>
            </div>
          </article>
        </div>
      </div>
    </section>
  `;
}

function updateSearchResults() {
  const results = document.querySelector("#searchResults");
  if (!results) return;
  const customers = sortByPriority(applyCustomerFilters());
  results.innerHTML = customerTable(customers);
}

function monthKey(date) {
  return String(date || "").slice(0, 7);
}

function buildLocalSummary(selectedDate = els.workDate.value || todayISO()) {
  const summaryDate = selectedDate || todayISO();
  const todayOrders = app.data.orders.filter(order => order.date === summaryDate);
  const monthOrders = app.data.orders.filter(order => monthKey(order.date) === monthKey(summaryDate));
  const dueCustomers = app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= summaryDate);
  return {
    selectedDate: summaryDate,
    salesToday: todayOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    salesThisMonth: monthOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    ordersToday: todayOrders.length,
    ordersThisMonth: monthOrders.length,
    jarsToday: todayOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    jarsThisMonth: monthOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0),
    orderCount: app.data.orders.length,
    customerCount: app.data.customers.length,
    newCustomers: app.data.customers.filter(customer => customer.status === "NEW").length,
    vip: app.data.customers.filter(customer => customer.vipLevel === "VIP").length,
    vvip: app.data.customers.filter(customer => customer.vipLevel === "VVIP").length,
    superVip: app.data.customers.filter(customer => customer.vipLevel === "SUPER VIP").length,
    atRisk: app.data.customers.filter(customer => customer.status === "AT RISK").length,
    lost: app.data.customers.filter(customer => customer.status === "LOST").length,
    dueToday: dueCustomers.length,
    dueByPriority: {
      "SUPER VIP": dueCustomers.filter(customer => customer.vipLevel === "SUPER VIP").length,
      VVIP: dueCustomers.filter(customer => customer.vipLevel === "VVIP").length,
      VIP: dueCustomers.filter(customer => customer.vipLevel === "VIP").length,
      NORMAL: dueCustomers.filter(customer => customer.vipLevel === "NORMAL").length
    }
  };
}

function queueSummaryRefresh() {
  clearTimeout(app.summaryRefreshTimer);
  app.summaryRefreshTimer = setTimeout(() => {
    if (!app.data) return;
    app.data.summary = buildLocalSummary(app.data.summary?.selectedDate || els.workDate.value || todayISO());
  if (["dashboard", "notifications", "reports", "vip", "risk", "customers", "opportunities"].includes(app.view)) render();
  }, 0);
}

function upsertArrayItem(items, item) {
  const index = items.findIndex(entry => entry.id === item.id);
  if (index === -1) items.push(item);
  else items[index] = item;
}

function applyOrderMutation(mutation) {
  if (!mutation || !app.data) return;
  const deletedOrderId = mutation.deletedOrderId || "";
  if (deletedOrderId) {
    app.data.orders = app.data.orders.filter(order => order.id !== deletedOrderId);
  }
  if (mutation.order) upsertArrayItem(app.data.orders, mutation.order);
  const customerMap = new Map((mutation.customers || []).map(customer => [customer.id, customer]));
  const deletedCustomerIds = new Set(mutation.deletedCustomerIds || []);
  app.data.customers = app.data.customers.filter(customer => !deletedCustomerIds.has(customer.id));
  for (const customer of mutation.customers || []) upsertArrayItem(app.data.customers, customer);
  app.data.tags = Array.from(new Set([...(app.data.tags || []), ...(mutation.tags || [])])).sort((a, b) => a.localeCompare(b, "th"));
  for (const order of app.data.orders) {
    if (!(mutation.affectedCustomerIds || []).includes(order.customerId)) continue;
    const customer = customerMap.get(order.customerId);
    if (!customer) continue;
    order.customerName = customer.name;
    order.tags = customer.tags || [];
    order.status = customer.status || "";
    order.vipLevel = customer.vipLevel || "NORMAL";
    if (!order.phone) order.phone = customer.phone || "";
  }
  queueSummaryRefresh();
}

function filteredOrdersForCurrentView() {
  const selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
  const q = app.ordersFilterQ.trim().toLowerCase();
  return app.data.orders.filter(order => {
    const dateMatch = app.ordersShowAll || order.date === selectedDate;
    const textMatch = !q || [
      order.orderNumber,
      order.customerName,
      order.phone,
      order.alternatePhone,
      order.socialName,
      order.tags,
      order.note
    ].join(" ").toLowerCase().includes(q);
    return dateMatch && textMatch;
  }).sort(compareOrderNumberAscending);
}

function patchOrdersView(mutation) {
  if (app.view !== "orders") return;
  const countText = document.querySelector("#ordersCountText");
  const orders = filteredOrdersForCurrentView();
  if (countText) {
    countText.textContent = app.ordersShowAll
      ? `แสดง ${money(orders.length)} ออเดอร์จากทุกวัน`
      : `แสดง ${money(orders.length)} ออเดอร์จากวันที่เลือก`;
  }
  renderOrders();
}

function cloneUiState() {
  return JSON.parse(JSON.stringify({
    orders: app.data.orders,
    customers: app.data.customers,
    summary: app.data.summary,
    tags: app.data.tags
  }));
}

function restoreUiState(snapshot) {
  app.data.orders = snapshot.orders || [];
  app.data.customers = snapshot.customers || [];
  app.data.summary = snapshot.summary || app.data.summary;
  app.data.tags = snapshot.tags || [];
  render();
}

function optimisticOrderFromForm(data, orderId, clientMutationId) {
  const existing = orderId ? app.data.orders.find(order => order.id === orderId) : null;
  return {
    ...(existing || {}),
    id: orderId || clientMutationId,
    customerId: existing?.customerId || `temp_customer_${clientMutationId}`,
    orderNumber: data.orderNumber ?? existing?.orderNumber ?? "",
    customerName: data.name ?? existing?.customerName ?? "",
    phone: data.phone ?? existing?.phone ?? "",
    alternatePhone: data.alternatePhone ?? existing?.alternatePhone ?? "",
    address: data.address ?? existing?.address ?? "",
    date: data.date || existing?.date || todayISO(),
    time: existing?.time || "",
    jars: Number(data.jars ?? existing?.jars ?? 1),
    amount: Number(data.amount ?? existing?.amount ?? 0),
    source: data.sourceChannel ?? existing?.source ?? "",
    sourceChannel: data.sourceChannel ?? existing?.sourceChannel ?? "",
    socialName: data.socialName ?? existing?.socialName ?? "",
    originSource: data.originSource ?? existing?.originSource ?? "",
    freeGift: data.freeGift ?? existing?.freeGift ?? "",
    vipCardStatus: data.vipCardStatus ?? existing?.vipCardStatus ?? "",
    note: data.note ?? existing?.note ?? "",
    tags: splitTags(data.tags ?? existing?.tags ?? []),
    status: existing?.status || "NEW",
    vipLevel: existing?.vipLevel || "NORMAL"
  };
}

function refreshVisibleCustomerPanels(mutation) {
  const openCustomerId = els.customerDetail?.querySelector('input[name="customerId"]')?.value;
  if (openCustomerId && (mutation.affectedCustomerIds || []).includes(openCustomerId)) {
    const customer = app.data.customers.find(item => item.id === openCustomerId);
    if (customer) renderCustomerDetail(customer);
    else els.customerDialog.close();
  }
  if (app.view === "customers") updateSearchResults();
}

function makeMessage(customer) {
  const name = customer.name.replace(/^คุณ/, "คุณ");
  return `สวัสดีค่ะ ${name} จาก Growup นะคะ รอบก่อนสั่ง ${customer.lastJars || 1} กระปุก ตอนนี้ใกล้ถึงรอบดูแลต่อเนื่องแล้วค่ะ ต้องการให้จัดส่งเพิ่มไหมคะ`;
}

function followupCards(customers, compact = false) {
  if (!customers.length) return `<div class="empty-state">ยังไม่มีลูกค้าถึงกำหนดในวันนี้</div>`;
  return `
    <div class="priority-list">
      ${customers.map(customer => `
        <article class="customer-card">
          <div class="customer-card-main">
            <h3>
              <button class="button ghost" data-open-customer="${customer.id}">${escapeHtml(customer.name)}</button>
              ${vipBadge(customer.vipLevel)}
              ${badge(customer.status)}
            </h3>
            <div class="badge-list">${tagsHtml(customer.tags)}</div>
            <div class="mini-stats">
              <div class="mini-stat"><span>เบอร์โทร</span><strong>${escapeHtml(customer.phone)}</strong></div>
              <div class="mini-stat"><span>ซื้อล่าสุด</span><strong>${formatDate(customer.lastPurchaseDate)}</strong></div>
              <div class="mini-stat"><span>กระปุกล่าสุด</span><strong>${customer.lastJars}</strong></div>
              <div class="mini-stat"><span>ยอดสะสม</span><strong>${money(customer.totalSpent)} บาท</strong></div>
            </div>
            ${compact ? "" : `<p class="muted">ควรทัก ${formatDate(customer.followUpDate)} · ${followupDayLabel(customer)}</p>`}
          </div>
          <div class="call-actions">
            <a class="button primary" href="tel:${escapeHtml(customer.phone)}">โทร</a>
            <button class="button ghost" data-copy="${escapeHtml(customer.phone)}">คัดลอกเบอร์</button>
            <button class="button secondary" data-copy="${escapeHtml(makeMessage(customer))}">คัดลอกข้อความ</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function followupDayLabel(customer) {
  const days = diffDaysISO(app.data.summary.selectedDate, customer.followUpDate);
  if (days === 0) return "ถึงกำหนดวันนี้";
  if (days > 0) return `เหลืออีก ${days} วัน`;
  return `เลยกำหนด ${Math.abs(days)} วัน`;
}

function renderFollowup() {
  const range = followupRange();
  const customers = sortByPriority(app.data.customers.filter(customer => {
    if (!customer.followUpDate) return false;
    if (app.followupMode === "overdue") return customer.followUpDate < app.data.summary.selectedDate;
    return customer.followUpDate >= range.start && customer.followUpDate <= range.end;
  }));
  els.content.innerHTML = `
    <section class="section saas-page notifications-page">
      <div class="page-identity workspace-hero notifications-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Follow-up Task Manager</span>
          <h2>เตือนติดตามลูกค้า</h2>
          <p>${range.label} · ถึงวันที่ ${formatDate(range.end)}</p>
        </div>
      </div>
      <div class="panel stack panel-premium followup-toolbar">
        <div class="section-title">
          <h2>เลือกช่วงงานติดตาม</h2>
          <p>มุมมองเดียวสำหรับทีมขายและทีมดูแลลูกค้า</p>
        </div>
        <div class="tab-row" role="tablist" aria-label="ช่วงวันที่ Follow-up">
          ${[
            ["today", "วันนี้"],
            ["tomorrow", "พรุ่งนี้"],
            ["week", "สัปดาห์นี้"],
            ["custom", "เลือกวันที่"],
            ["overdue", "เลยกำหนดแล้ว"]
          ].map(([id, label]) => `
            <button class="tab-button ${app.followupMode === id ? "active" : ""}" data-followup-mode="${id}" type="button">${label}</button>
          `).join("")}
        </div>
        <div class="date-inline ${app.followupMode === "custom" ? "show" : ""}">
          <label class="date-picker">
            <span>เลือกวันที่</span>
            <input id="followupDatePicker" type="date" value="${escapeHtml(app.data.summary.selectedDate)}">
          </label>
        </div>
      </div>
      ${followupCards(customers)}
    </section>
  `;
}

function renderMore() {
  const cards = [
    ["vip", "ลูกค้า VIP", "VIP / VVIP / SUPER VIP", "VIP"],
    ["import", "เพิ่มข้อมูลเก่า", "นำเข้าออเดอร์เก่าด้วย CSV", "นำเข้า"],
    ["reports", "รายงานยอดขาย", "ยอดขายและสัดส่วนลูกค้า", "รายงาน"],
    ["tags", "อาการลูกค้า", "จัดการอาการลูกค้าและดูจำนวนลูกค้า", "อาการลูกค้า"],
    ["risk", "ลูกค้าเสี่ยงหาย", "AT RISK และ LOST", "แจ้งเตือน"]
  ];
  const adminCards = [
    ["settingsFollowup", "ตั้งค่า Follow-up", "1 กระปุก ใช้ได้กี่วัน", "Follow-up"],
    ["settingsVip", "ตั้งค่า VIP", "VIP / VVIP / SUPER VIP", "VIP"],
    ["settingsLine", "ตั้งค่า LINE OA", "Channel Secret, Token, Webhook", "LINE"],
    ["lineDebug", "LINE Debug", "ดู webhook ล่าสุดและสถานะลายเซ็น", "Debug"],
    ["team", "จัดการผู้ใช้", "Admin และ Staff", "ทีม"]
  ];
  const visibleCards = isAdmin() ? [...cards, ...adminCards] : cards;

  els.content.innerHTML = `
    <section class="section saas-page settings-page">
      <div class="page-identity workspace-hero settings-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Workspace Directory</span>
          <h2>เครื่องมือและทางลัดเพิ่มเติม</h2>
          <p>รวมพื้นที่ดูแลลูกค้า ความเสี่ยง การนำเข้า และการดูแลระบบ</p>
        </div>
      </div>
      <div class="more-grid">
        ${visibleCards.map(([view, title, desc, chip]) => `
          <button class="more-card" data-view-shortcut="${view}" type="button">
            <span>${escapeHtml(chip)}</span>
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(desc)}</small>
          </button>
        `).join("")}
        <button class="more-card logout-card" data-logout type="button">
          <span>Logout</span>
          <strong>ออกจากระบบ</strong>
          <small>จบ session บนเครื่องนี้</small>
        </button>
      </div>
      ${canExportData() ? `
        <div class="panel stack export-panel">
          <div class="section-title">
            <h2>Export / Backup</h2>
            <p>ดาวน์โหลดข้อมูลสำหรับสำรองหรือย้ายไป production database</p>
          </div>
          <div class="inline">
            <a class="button secondary" href="/api/export/customers">Customers CSV</a>
            <a class="button secondary" href="/api/export/orders">Orders CSV</a>
            <a class="button secondary" href="/api/export/followups">Follow-up CSV</a>
            <a class="button secondary" href="/api/export/vip">VIP CSV</a>
            ${isAdmin() ? `<a class="button ghost" href="/api/backup">JSON Backup</a>` : ""}
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

function tagUsageRows() {
  return [...app.data.tags].sort((a, b) => a.localeCompare(b, "th")).map(tag => {
    const customers = app.data.customers.filter(customer => (customer.tags || []).includes(tag));
    const totalSpent = customers.reduce((sum, customer) => sum + Number(customer.totalSpent || 0), 0);
    return { tag, customers, totalSpent };
  });
}

function renderTags() {
  const rows = tagUsageRows();
  els.content.innerHTML = `
    <section class="section">
      <form class="panel stack" id="tagsForm">
        <div class="section-title">
          <h2>จัดการอาการลูกค้า</h2>
          <p>เพิ่มอาการลูกค้าได้ไม่จำกัด และกดเพื่อกรองรายชื่อลูกค้าได้ทันที</p>
        </div>
        <div class="form-grid">
          <label class="span-2">เพิ่มอาการลูกค้าใหม่
            <input name="name" required placeholder="เช่น ปวดเข่า, ซื้อให้แม่, โทรติดยาก">
          </label>
        </div>
        <button class="button primary" type="submit">เพิ่มอาการลูกค้า</button>
      </form>
      <div class="tag-grid">
        ${rows.map(row => `
          <button class="tag-card" data-tag-filter="${escapeHtml(row.tag)}" type="button">
            <span class="tag">${escapeHtml(row.tag)}</span>
            <strong>${row.customers.length} คน</strong>
            <small>ยอดสะสม ${money(row.totalSpent)} บาท</small>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderVip() {
  const customers = sortByPriority(app.data.customers.filter(customer => customer.vipLevel !== "NORMAL"));
  const thresholds = app.data.settings.vipThresholds || {};
  els.content.innerHTML = `
    <section class="section">
      <div class="two-col">
        <form class="panel stack" id="vipThresholdForm">
          <div class="section-title">
            <h2>ตั้งค่ายอด VIP</h2>
            <p>แก้ยอดขั้นต่ำของแต่ละระดับได้จากหน้านี้ แล้วบันทึกได้ทันที</p>
          </div>
          <div class="vip-threshold-grid">
            <label class="threshold-card">
              <span>VIP</span>
              <strong>ยอดขั้นต่ำ</strong>
              <div class="threshold-input">
                <input name="vipThreshold" type="number" min="0" required value="${Number(thresholds.vip ?? 5000)}">
                <span>บาท</span>
              </div>
            </label>
            <label class="threshold-card">
              <span>VVIP</span>
              <strong>ยอดขั้นต่ำ</strong>
              <div class="threshold-input">
                <input name="vvipThreshold" type="number" min="0" required value="${Number(thresholds.vvip ?? 10000)}">
                <span>บาท</span>
              </div>
            </label>
            <label class="threshold-card">
              <span>SUPER VIP</span>
              <strong>ยอดขั้นต่ำ</strong>
              <div class="threshold-input">
                <input name="superVipThreshold" type="number" min="0" required value="${Number(thresholds.superVip ?? 20000)}">
                <span>บาท</span>
              </div>
            </label>
          </div>
          <button class="button primary" type="submit">บันทึกยอด VIP</button>
        </form>
        <div class="panel stack">
          <div class="section-title">
            <h2>ลูกค้า VIP</h2>
            <p>ลูกค้าจะอัปเดตระดับอัตโนมัติหลังบันทึกยอดใหม่</p>
          </div>
          <div class="vip-level-summary">
            <div><span>VIP</span><strong>${money(thresholds.vip ?? 5000)} บาท</strong></div>
            <div><span>VVIP</span><strong>${money(thresholds.vvip ?? 10000)} บาท</strong></div>
            <div><span>SUPER VIP</span><strong>${money(thresholds.superVip ?? 20000)} บาท</strong></div>
          </div>
        </div>
      </div>
      ${customerTable(customers, "ยังไม่มีลูกค้า VIP")}
    </section>
  `;
}

function renderRisk() {
  const customers = sortByPriority(app.data.customers.filter(customer => ["AT RISK", "LOST"].includes(customer.status)));
  els.content.innerHTML = `
    <section class="section">
      <div class="section-header">
        <div class="section-title">
          <h2>ลูกค้าเสี่ยงหาย</h2>
          <p>AT RISK คือเลย Follow-up มากกว่า 30 วัน, LOST คือเลยมากกว่า 90 วัน</p>
        </div>
      </div>
      ${customerTable(customers, "ยังไม่มีลูกค้าเสี่ยงหาย")}
    </section>
  `;
}

function renderImport() {
  const job = app.importJob;
  const cleanup = app.importCleanup;
  const inspection = app.importInspection;
  const busy = job && ["queued", "running"].includes(job.status);
  const statusLabels = {
    queued: "รอเริ่ม",
    running: "กำลังนำเข้า",
    paused: "หยุดชั่วคราว",
    completed: "เสร็จสมบูรณ์",
    cancelled: "ยกเลิกแล้ว",
    failed: "ไม่สำเร็จ"
  };
  els.content.innerHTML = `
    <section class="section">
      <div class="panel stack import-drop">
        <div class="section-title">
          <h2>นำเข้าออเดอร์ CSV และ Excel ขนาดใหญ่</h2>
          <p>รองรับไฟล์ .csv, .xlsx และ .xls พร้อมตรวจสอบหัวตาราง เลือกชีต และนำเข้าเบื้องหลังอัตโนมัติ</p>
        </div>
        <label class="import-file-zone">
          <span>${app.importPreparing ? "กำลังอ่านไฟล์…" : busy ? "มีงานกำลังทำงานอยู่" : job?.status === "paused" ? "เลือกไฟล์เดิมเพื่อทำต่อ" : "เลือกไฟล์ CSV หรือ Excel เพื่อตรวจสอบก่อนนำเข้า"}</span>
          <small>รองรับหลายชีต ตรวจพบหัวตารางอัตโนมัติ แสดงตัวอย่าง 10 แถวก่อนนำเข้า และยังคงแบ่งชุดละ 300 รายการ</small>
          <input class="file-input" id="csvFile" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${app.importPreparing || busy ? "disabled" : ""}>
        </label>
        <div class="inline">
          <a class="button secondary" href="/templates/order-import-template.csv" download>ดาวน์โหลด Template CSV</a>
          <a class="button secondary" href="/templates/order-import-template.xlsx" download>ดาวน์โหลด Template Excel</a>
        </div>
        ${inspection ? renderImportInspection(inspection, busy) : ""}
        ${job ? `
          <div class="import-progress-card">
            <div class="import-progress-head">
              <div>
                <span class="import-status ${escapeHtml(job.status)}">${statusLabels[job.status] || job.status}</span>
                <strong>${escapeHtml(job.fileName || "orders.csv")}</strong>
              </div>
              <strong>${Number(job.percent || 0)}%</strong>
            </div>
            <div class="import-progress-track"><span style="width:${Number(job.percent || 0)}%"></span></div>
            <div class="import-stat-grid">
              <div><span>Imported / Total</span><strong>${money(job.imported || 0)} / ${money(job.total || 0)}</strong></div>
              <div><span>ประมวลผลแล้ว</span><strong>${money(job.processed || 0)}</strong></div>
              <div><span>ข้ามรายการซ้ำ</span><strong>${money(job.skipped || 0)}</strong></div>
              <div><span>ไม่สำเร็จ</span><strong>${money(job.failed || 0)}</strong></div>
              <div><span>ETA</span><strong>${job.status === "completed" ? "เสร็จแล้ว" : formatImportDuration(job.etaSeconds || 0)}</strong></div>
              <div><span>ระยะเวลา</span><strong>${formatImportDuration(job.durationSeconds || 0)}</strong></div>
            </div>
            <div class="inline">
              ${["queued", "running", "paused"].includes(job.status) ? `<button class="button danger" data-cancel-import type="button">ยกเลิก</button>` : ""}
              ${job.canExportFailures ? `<a class="button secondary" href="/api/import-jobs/${encodeURIComponent(job.id)}/failed.csv">ดาวน์โหลดแถวที่ผิดพลาด</a>` : ""}
            </div>
          </div>
        ` : `
          <div class="import-capabilities">
            <span>แบ่งชุดอัตโนมัติ</span>
            <span>ทำต่อได้เมื่อสะดุด</span>
            <span>ป้องกันข้อมูลซ้ำ</span>
            <span>ดาวน์โหลดแถวที่ผิดพลาดได้</span>
            <span>เลือกชีตได้</span>
            <span>รองรับหัวตารางไทยและอังกฤษ</span>
          </div>
        `}
        ${cleanup && cleanup.supported !== false ? `
          <div class="import-final-summary">
            <strong>Rollback Import</strong>
            <span>ลบออเดอร์ล่าสุด ${money(cleanup.orderCount || 0)} รายการ และลูกค้าที่ไม่เหลือออเดอร์ ${money(cleanup.customerCount || 0)} รายการ</span>
            <button class="button danger" data-rollback-import type="button" ${cleanup.orderCount ? "" : "disabled"}>Rollback Import</button>
          </div>
        ` : cleanup ? `
          <div class="import-final-summary">
            <strong>Rollback Import</strong>
            <span>งานล่าสุดนี้ยังไม่รองรับการ rollback จากหน้านี้</span>
          </div>
        ` : ""}
        ${job?.status === "completed" ? `
          <div class="import-final-summary">
            <strong>สรุปการนำเข้า</strong>
            <span>นำเข้าสำเร็จ ${money(job.imported || 0)} · ข้าม ${money(job.skipped || 0)} · ไม่สำเร็จ ${money(job.failed || 0)} · ใช้เวลา ${formatImportDuration(job.durationSeconds || 0)}</span>
          </div>
        ` : ""}
        ${job?.lastError ? `<p class="form-error">${escapeHtml(job.lastError)}</p>` : ""}
        <div class="muted">
          คอลัมน์หลักที่รองรับ: เลขออเดอร์, วันที่ซื้อ, ช่องทางการสั่งซื้อ, Facebook / LINE ลูกค้า, ชื่อลูกค้า, เบอร์โทร, เบอร์โทรสำรอง, ที่อยู่จัดส่ง, จำนวนกระปุก, ยอดซื้อ, ของแถมที่ลูกค้าได้, สถานะบัตร VIP, อาการลูกค้า, ลูกค้ามาจาก และหมายเหตุ
        </div>
      </div>
    </section>
  `;
}

function renderImportInspection(inspection, busy) {
  const mappedItems = (inspection.mappedColumns || []).map(item => `
    <div>
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.header)}</strong>
    </div>
  `).join("");
  const missingItems = (inspection.missingColumns || []).map(label => `<span class="import-warning-chip">${escapeHtml(label)}</span>`).join("");
  const invalidItems = (inspection.invalidColumns || []).map(label => `<span class="import-warning-chip">${escapeHtml(label)}</span>`).join("");
  const previewRows = (inspection.previewRows || []).map(row => `
    <tr>
      <td data-label="เลขออเดอร์">${escapeHtml(row.orderNumber || "-")}</td>
      <td data-label="วันที่ซื้อ">${escapeHtml(row.date || "-")}</td>
      <td data-label="ช่องทาง">${escapeHtml(row.sourceChannel || "-")}</td>
      <td data-label="Facebook / LINE">${escapeHtml(row.socialName || "-")}</td>
      <td data-label="ชื่อลูกค้า">${escapeHtml(row.name || "-")}</td>
      <td data-label="เบอร์โทร">${escapeHtml(row.phone || "-")}</td>
      <td data-label="เบอร์สำรอง">${escapeHtml(row.alternatePhone || "-")}</td>
      <td data-label="ที่อยู่">${escapeHtml(row.address || "-")}</td>
      <td data-label="กระปุก">${escapeHtml(String(row.jars || ""))}</td>
      <td data-label="ยอดซื้อ">${escapeHtml(String(row.amount || ""))}</td>
      <td data-label="ของแถม">${escapeHtml(row.freeGift || "-")}</td>
      <td data-label="บัตร VIP">${escapeHtml(row.vipCardStatus || "-")}</td>
      <td data-label="อาการลูกค้า">${escapeHtml(row.tags || "-")}</td>
      <td data-label="ลูกค้ามาจาก">${escapeHtml(row.originSource || "-")}</td>
      <td data-label="หมายเหตุ">${escapeHtml(row.note || "-")}</td>
    </tr>
  `).join("");
  return `
    <div class="import-preview-card">
      <div class="import-preview-head">
        <div>
          <strong>${escapeHtml(inspection.fileName || "")}</strong>
          <span>${escapeHtml(inspection.fileTypeLabel || inspection.fileType || "")} · พบข้อมูล ${money(inspection.totalRows || 0)} แถว</span>
        </div>
        ${(inspection.sheetNames || []).length > 1 ? `
          <label class="import-sheet-picker">
            <span>ชีต</span>
            <select id="importSheetSelect" ${app.importPreparing || busy ? "disabled" : ""}>
              ${inspection.sheetNames.map(name => `<option value="${escapeHtml(name)}" ${inspection.selectedSheet === name ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}
            </select>
          </label>
        ` : ""}
      </div>
      <div class="import-stat-grid import-preview-stats">
        <div><span>Header Row</span><strong>${money(inspection.headerRowNumber || 0)}</strong></div>
        <div><span>พร้อมนำเข้า</span><strong>${money(inspection.readyRows || 0)}</strong></div>
        <div><span>แถวอาจไม่ครบ</span><strong>${money(inspection.invalidRows || 0)}</strong></div>
      </div>
      ${mappedItems ? `<div class="import-mapped-grid">${mappedItems}</div>` : ""}
      ${(inspection.missingColumns || []).length ? `
        <div class="import-validation-block warning">
          <strong>คอลัมน์ที่ไม่พบ</strong>
          <div class="import-chip-list">${missingItems}</div>
        </div>
      ` : ""}
      ${(inspection.invalidColumns || []).length ? `
        <div class="import-validation-block">
          <strong>คอลัมน์ที่ยังไม่ใช้</strong>
          <div class="import-chip-list">${invalidItems}</div>
        </div>
      ` : ""}
      ${inspection.validationMessage ? `<p class="form-error">${escapeHtml(inspection.validationMessage)}</p>` : ""}
      <div class="import-table-wrap mobile-stack-wrap">
        <table class="table import-preview-table mobile-stack-table">
          <thead>
            <tr>
              <th>เลขออเดอร์</th>
              <th>วันที่ซื้อ</th>
              <th>ช่องทาง</th>
              <th>Facebook / LINE</th>
              <th>ชื่อลูกค้า</th>
              <th>เบอร์โทร</th>
              <th>เบอร์สำรอง</th>
              <th>ที่อยู่</th>
              <th>กระปุก</th>
              <th>ยอดซื้อ</th>
              <th>ของแถม</th>
              <th>บัตร VIP</th>
              <th>อาการลูกค้า</th>
              <th>ลูกค้ามาจาก</th>
              <th>หมายเหตุ</th>
            </tr>
          </thead>
          <tbody>${previewRows || `<tr><td colspan="15" class="muted">ไม่พบข้อมูลตัวอย่าง</td></tr>`}</tbody>
        </table>
      </div>
      <div class="inline">
        <button class="button primary" type="button" data-start-import ${inspection.canImport && !busy ? "" : "disabled"}>เริ่มนำเข้า</button>
      </div>
    </div>
  `;
}

function formatImportDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return `${value} วินาที`;
  const minutes = Math.floor(value / 60);
  const remaining = value % 60;
  return `${minutes} นาที ${remaining} วินาที`;
}

async function refreshImportJob() {
  clearTimeout(app.importPollTimer);
  const inProgress = app.importJob && ["queued", "running", "paused"].includes(app.importJob.status);
  const path = inProgress
    ? `/api/import-jobs/${encodeURIComponent(app.importJob.id)}`
    : "/api/import-jobs/active?type=orders";
  const payload = await api(path);
  if (payload.job) app.importJob = payload.job;
  if (app.view === "import") renderImport();
  if (!app.importWorker && app.view === "import" && app.importJob && ["queued", "running"].includes(app.importJob.status)) {
    app.importPollTimer = setTimeout(() => refreshImportJob().catch(error => showToast(error.message)), 2000);
  }
}

async function refreshImportCleanup() {
  if (!isAdmin() || app.view !== "import") return;
  try {
    const payload = await api("/api/import-jobs/latest-cleanup-preview?type=orders");
    app.importCleanup = payload.preview || null;
  } catch {
    app.importCleanup = null;
  }
}

function startCsvImport(file) {
  if (app.importWorker) app.importWorker.terminate();
  app.importPreparing = true;
  app.importJob = null;
  app.importInspection = null;
  renderImport();
  const worker = new Worker("/import-worker.js");
  app.importWorker = worker;
  worker.addEventListener("message", async event => {
    const { type, job, message, inspection } = event.data || {};
    if (job) app.importJob = job;
    if (type === "preparing") app.importPreparing = true;
    if (type === "inspected") {
      app.importPreparing = false;
      app.importInspection = inspection || null;
    }
    if (type === "progress") app.importPreparing = false;
    if (type === "complete") {
      app.importPreparing = false;
      app.importInspection = null;
      worker.terminate();
      app.importWorker = null;
      await loadState();
      return;
    }
    if (type === "cancelled") {
      app.importPreparing = false;
      worker.terminate();
      app.importWorker = null;
    }
    if (type === "error") {
      app.importPreparing = false;
      if (message) showToast(message);
      worker.terminate();
      app.importWorker = null;
    }
    if (app.view === "import") renderImport();
  });
  worker.postMessage({
    type: "inspect",
    file,
    defaultJarPrice: Number(app.data?.settings?.defaultJarPrice || 750)
  });
}

function startPreparedImport() {
  if (!app.importWorker || !app.importInspection?.canImport) return;
  app.importPreparing = true;
  renderImport();
  app.importWorker.postMessage({
    type: "start-import",
    defaultJarPrice: Number(app.data?.settings?.defaultJarPrice || 750)
  });
}

function monthKey(dateValue) {
  return String(dateValue || "").slice(0, 7);
}

function isPlaceholderChannel(value) {
  return /^manual(?:\s+import)?$/i.test(String(value || "").trim());
}

function displayOrderChannel(order = {}) {
  const values = [order.sourceChannel, order.source_channel, order.source];
  return values.map(value => String(value || "").trim()).find(value => value && !isPlaceholderChannel(value)) || MISSING_CHANNEL_LABEL;
}

function summarizeSalesChannel(value) {
  const channel = String(value || "").trim();
  const normalized = channel.toLowerCase();
  if (!channel || channel === MISSING_CHANNEL_LABEL) return MISSING_CHANNEL_LABEL;
  if (
    normalized.includes("facebook") ||
    normalized.includes("fb") ||
    channel.includes("เฟส") ||
    channel.includes("เพจ") ||
    channel.includes("page") ||
    channel.includes("แฟนเพจ") ||
    channel.includes("ไลฟ์") ||
    channel.includes("inbox")
  ) return "Facebook";
  if (normalized.includes("line") || channel.includes("ไลน์")) return "LINE";
  if (channel.includes("โทร") || normalized.includes("phone") || normalized.includes("call") || normalized.includes("tel")) return "โทร";
  return MISSING_CHANNEL_LABEL;
}

function summarizeOriginSource(value) {
  const source = String(value || "").trim();
  const normalized = source.toLowerCase();
  if (!source || source === MISSING_CHANNEL_LABEL) return MISSING_CHANNEL_LABEL;
  if (
    normalized.includes("facebook") ||
    normalized.includes("fb") ||
    source.includes("เฟส") ||
    source.includes("เพจ") ||
    source.includes("page") ||
    source.includes("แฟนเพจ") ||
    source.includes("ไลฟ์") ||
    source.includes("inbox")
  ) return "Facebook";
  if (normalized.includes("line") || source.includes("ไลน์")) return "LINE";
  if (source.includes("โทร") || normalized.includes("phone") || normalized.includes("call") || normalized.includes("tel")) return "โทร";
  return MISSING_CHANNEL_LABEL;
}

function renderReports() {
  const selectedDate = app.reportDate || app.data.summary.selectedDate || todayISO();
  const selectedMonth = app.reportMonth || selectedDate.slice(0, 7);
  const selectedYear = selectedMonth.slice(0, 4);
  const monthly = {};
  const daily = {};
  const sourceTotals = {};
  app.data.orders.forEach(order => {
    const orderMonth = monthKey(order.date);
    if (orderMonth.startsWith(selectedYear)) {
      monthly[orderMonth] = (monthly[orderMonth] || 0) + Number(order.amount || 0);
    }
    if (order.date === selectedDate) {
      daily[order.date] = (daily[order.date] || 0) + Number(order.amount || 0);
    }
    if (orderMonth.startsWith(selectedMonth)) {
      const summaryChannel = summarizeOriginSource(order.originSource);
      if (!sourceTotals[summaryChannel]) sourceTotals[summaryChannel] = { count: 0, total: 0 };
      sourceTotals[summaryChannel].count += 1;
      sourceTotals[summaryChannel].total += Number(order.amount || 0);
    }
  });
  const monthlyRows = Object.entries(monthly).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12);
  const dailyRows = Object.entries(daily).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12);
  const maxDaily = Math.max(1, ...dailyRows.map(([, value]) => value));
  const monthOrders = app.data.orders.filter(order => String(order.date).startsWith(selectedMonth));
  const repeatCustomers = app.data.customers.filter(customer => customer.purchaseCount > 1).length;
  const topCustomers = [...app.data.customers].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 5);
  const monthOptions = Array.from(new Set(app.data.orders.map(order => monthKey(order.date)).filter(Boolean))).sort((a, b) => b.localeCompare(a));
  const channelRows = Object.entries(sourceTotals)
    .map(([channel, stats]) => ({ channel, count: stats.count, total: stats.total }))
    .sort((a, b) => b.total - a.total);

  els.content.innerHTML = `
    <section class="section saas-page reports-page">
      <div class="page-identity workspace-hero reports-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Executive Analytics</span>
          <h2>รายงานสำหรับตัดสินใจ</h2>
          <p>ติดตามยอดขาย ออเดอร์ ลูกค้า และช่องทางแบบอ่านเร็วในมุมของผู้บริหาร</p>
        </div>
      </div>
      <div class="metric-grid">
        ${metric("ยอดขายเดือนนี้", `${money(app.data.summary.salesThisMonth)} บาท`, "accent")}
        ${metric("ออเดอร์รวม", money(app.data.orders.length))}
        ${metric("กระปุกรวม", money(app.data.orders.reduce((sum, order) => sum + Number(order.jars || 0), 0)), "green")}
        ${metric("ลูกค้าใหม่", money(app.data.summary.newCustomers))}
        ${metric("ลูกค้าซื้อซ้ำ", money(repeatCustomers), "purple")}
        ${metric("ออเดอร์เดือนนี้", money(monthOrders.length))}
      </div>
      <div class="report-grid">
        <div class="panel stack panel-premium">
          <div class="card-head">
            <h2>ยอดขายรายเดือน</h2>
            <label class="date-picker compact card-picker" aria-label="เลือกเดือนรายงานยอดขาย">
              <input data-report-month type="month" value="${escapeHtml(selectedMonth)}" list="reportMonthOptions">
              <datalist id="reportMonthOptions">
                ${monthOptions.map(month => `<option value="${escapeHtml(month)}"></option>`).join("")}
              </datalist>
            </label>
          </div>
          <div class="bar-list">
            ${monthlyRows.map(([key, value]) => `
              <div class="bar-row">
                <strong>${escapeHtml(key)}</strong>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, value / Math.max(...monthlyRows.map(([, v]) => v), 1) * 100)}%"></div></div>
                <span>${money(value)}</span>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <div class="card-head">
            <h2>ยอดขายรายวัน</h2>
            <label class="date-picker compact card-picker" aria-label="เลือกวันที่รายงานยอดขายรายวัน">
              <input data-report-date type="date" value="${escapeHtml(selectedDate)}">
            </label>
          </div>
          <div class="bar-list">
            ${dailyRows.map(([key, value]) => `
              <div class="bar-row">
                <strong>${formatDate(key)}</strong>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, value / maxDaily * 100)}%"></div></div>
                <span>${money(value)}</span>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="panel stack panel-premium">
          <h2>ยอดขายตามช่องทาง</h2>
          <div class="bar-list">
            ${channelRows.map(({ channel, count, total }) => `
              <div class="bar-row">
                <strong>${escapeHtml(channel)}</strong>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, total / Math.max(...channelRows.map(row => row.total), 1) * 100)}%"></div></div>
                <span>${money(total)} · ${money(count)} ออเดอร์</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="panel stack panel-premium">
        <h2>Top customers</h2>
        ${customerTable(topCustomers)}
      </div>
    </section>
  `;
}

function renderAiInsights() {
  const hasAi = Boolean(app.data.settings?.openaiApiKeyConfigured);
  const cards = [
    `ลูกค้าเก่าที่ยังไม่ซื้อในเดือนนี้มี ${money(opportunityCardsData()[0]?.count || 0)} ราย ควรเริ่มจากกลุ่มยอดสะสมสูงก่อน`,
    `ช่องทาง ${channelPerformance()[0]?.name || "หลัก"} ทำยอดเด่นสุดในตอนนี้ ควรเพิ่มงบหรือความถี่คอนเทนต์`,
    `มีลูกค้าถึงกำหนด follow-up ${money(app.data.summary?.dueToday || 0)} ราย ซึ่งเป็นกลุ่มปิดขายซ้ำเร็วที่สุด`
  ];
  els.content.innerHTML = `
    <section class="section saas-page ai-page">
      <div class="page-identity workspace-hero ai-hero">
        <div>
          <span class="page-kicker">Business AI Assistant</span>
          <h2>AI Insight</h2>
          <p>${hasAi ? "พร้อมเชื่อมต่อ AI จากระบบเดิม" : "แสดงคำแนะนำแบบ fallback อย่างปลอดภัยเมื่อยังไม่ได้ตั้งค่า AI API"}</p>
        </div>
        <span class="tag">${hasAi ? "AI พร้อมใช้งาน" : "Fallback mode"}</span>
      </div>
      <div class="cards-grid">
        ${cards.map((text, index) => `
          <article class="insight-card">
            <span class="tag">Insight ${index + 1}</span>
            <h3>${index === 0 ? "ลูกค้าที่ควรเร่งตาม" : index === 1 ? "ช่องทางที่ควรดันเพิ่ม" : "งานด่วนวันนี้"}</h3>
            <p class="muted">${escapeHtml(text)}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderBroadcast() {
  const segments = [
    ["ลูกค้าเก่ายังไม่ซื้อเดือนนี้", opportunityCardsData()[0]?.count || 0],
    ["ลูกค้าใกล้เป็น VIP", notificationItems()[2]?.count || 0],
    ["ลูกค้าที่ควรติดตาม", app.data.summary?.dueToday || 0]
  ];
  els.content.innerHTML = `
    <section class="section saas-page broadcast-page">
      <div class="page-identity workspace-hero broadcast-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Customer Engagement</span>
          <h2>Broadcast workspace</h2>
          <p>เลือกกลุ่มลูกค้าและร่างข้อความพร้อมใช้ โดยไม่บังคับ backend ส่งจริง</p>
        </div>
      </div>
      <div class="broadcast-grid">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>เลือกกลุ่มลูกค้า</h2>
            <p>เตรียม segment และข้อความได้ แม้ backend ส่งจริงยังไม่พร้อม</p>
          </div>
          ${segments.map(([label, count]) => `
            <article class="segment-card">
              <div class="section-title">
                <h3>${escapeHtml(label)}</h3>
                <span class="tag">${money(count)} ราย</span>
              </div>
              <button class="button secondary" type="button" data-copy="ส่งข้อความถึงกลุ่ม ${label}">คัดลอกชื่อกลุ่ม</button>
            </article>
          `).join("")}
        </div>
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>ร่างข้อความ Broadcast</h2>
            <p>ใช้เป็น draft สำหรับ LINE หรือช่องทางอื่นได้ทันที</p>
          </div>
          <label>ข้อความ
            <textarea readonly>สวัสดีค่ะจาก Growup วันนี้มีข้อเสนอพิเศษสำหรับลูกค้าเดิม หากสนใจให้ทีมช่วยสรุปชุดที่เหมาะกับคุณ ตอบกลับได้เลยนะคะ</textarea>
          </label>
          <div class="inline">
            <button class="button primary" type="button" data-copy="สวัสดีค่ะจาก Growup วันนี้มีข้อเสนอพิเศษสำหรับลูกค้าเดิม หากสนใจให้ทีมช่วยสรุปชุดที่เหมาะกับคุณ ตอบกลับได้เลยนะคะ">คัดลอกข้อความ</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderCampaigns() {
  const channels = channelPerformance().slice(0, 3);
  els.content.innerHTML = `
    <section class="section saas-page campaigns-page">
      <div class="page-identity workspace-hero campaigns-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Campaign Manager</span>
          <h2>แคมเปญที่กำลังวิ่งและแคมเปญที่ควรวางแผนต่อ</h2>
          <p>สรุปสถานะ งบประมาณ ROI และรายได้ที่คาดได้จากช่องทางหลัก</p>
        </div>
      </div>
      <div class="campaign-grid">
        ${channels.map((channel, index) => `
          <article class="campaign-card">
            <div class="section-title">
              <h3>แคมเปญ ${escapeHtml(channel.name)}</h3>
              <span class="tag">${index === 0 ? "กำลังรัน" : "วางแผน"}</span>
            </div>
            <div class="campaign-meta">
              <div><span>Status</span><strong>${index === 0 ? "Active" : "Draft"}</strong></div>
              <div><span>Budget</span><strong>${money(Math.max(1500, Math.round(channel.revenue * 0.08)))} บาท</strong></div>
              <div><span>ROI</span><strong>${money(channel.roi)}</strong></div>
              <div><span>Estimated revenue</span><strong>${money(Math.round(channel.revenue * 0.25))} บาท</strong></div>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderNotifications() {
  const items = notificationItems();
  const followupCustomers = sortByPriority(app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= (app.data.summary?.selectedDate || todayISO()))).slice(0, 5);
  els.content.innerHTML = `
    <section class="section saas-page notifications-page">
      <div class="page-identity workspace-hero notifications-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Actionable Notifications</span>
          <h2>ศูนย์แจ้งเตือนที่เปลี่ยนเป็นงานได้ทันที</h2>
          <p>รวม duplicate orders, follow-up, VIP reminders, stock alerts และ sales opportunities</p>
        </div>
      </div>
      <div class="notification-grid">
        ${items.map(item => `
          <article class="notification-card">
            <div class="section-title">
              <h3>${escapeHtml(item.title)}</h3>
              <span class="tag">${money(item.count)} รายการ</span>
            </div>
            <p class="muted">${escapeHtml(item.detail)}</p>
          </article>
        `).join("")}
      </div>
      <div class="panel stack panel-premium">
        <div class="section-title">
          <h2>ลูกค้าที่ควรติดตาม</h2>
          <p>เปิดต่อได้จากหน้านี้โดยตรง</p>
        </div>
        ${followupCards(followupCustomers)}
      </div>
    </section>
  `;
}

function renderTeam() {
  els.content.innerHTML = `
    <section class="section saas-page settings-page">
      <div class="page-identity workspace-hero settings-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Team Administration</span>
          <h2>สิทธิ์ผู้ใช้และการเข้าถึงระบบ</h2>
          <p>Admin ดูทุกอย่างและแก้ไขได้, Staff ค้นหา เพิ่มข้อมูล ดู Follow-up และโทรลูกค้า</p>
        </div>
      </div>
      <div class="two-col">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>สิทธิ์ผู้ใช้</h2>
            <p>Admin ดูทุกอย่างและแก้ไขได้, Staff ค้นหา เพิ่มข้อมูล ดู Follow-up และโทรลูกค้า</p>
          </div>
          <div class="table-wrap mobile-stack-wrap">
            <table class="mobile-stack-table">
              <thead><tr><th>ชื่อ</th><th>สิทธิ์</th><th>เบอร์โทร</th><th>สถานะ</th></tr></thead>
              <tbody>
                ${app.data.users.map(user => `
                  <tr>
                    <td data-label="ชื่อ"><strong>${escapeHtml(user.name)}</strong></td>
                    <td data-label="สิทธิ์">${badge(user.role)}</td>
                    <td data-label="เบอร์โทร">${escapeHtml(user.phone || "-")}</td>
                    <td data-label="สถานะ">${user.active ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <form class="panel stack panel-premium" id="teamForm">
          <div class="section-title">
            <h2>เพิ่มทีมงาน</h2>
            <p>สร้างผู้ใช้งานพร้อม Username / Password สำหรับเข้าสู่ระบบ</p>
          </div>
          <label>ชื่อ<input name="name" required></label>
          <label>Username<input name="username" required placeholder="เช่น sale01"></label>
          <label>Password<input name="password" required placeholder="ตั้งรหัสผ่าน"></label>
          <label>เบอร์โทร<input name="phone"></label>
          <label>สิทธิ์
            <select name="role">
              <option>Staff</option>
              <option>Admin</option>
            </select>
          </label>
          <button class="button primary" type="submit">เพิ่มทีมงาน</button>
        </form>
      </div>
    </section>
  `;
}

function renderSettings() {
  const settings = app.data.settings;
  const thresholds = settings.vipThresholds || {};
  const templates = settings.messageTemplates || {};
  const lineSecretHelp = settings.lineChannelSecretConfigured
    ? settings.lineChannelSecretFromEnv
      ? "ตั้งค่าไว้ใน Vercel Environment แล้ว"
      : "มีค่าเดิมอยู่แล้ว เว้นว่างไว้เพื่อคงค่าเดิม"
    : "ยังไม่ได้ตั้งค่า";
  const lineTokenHelp = settings.lineChannelAccessTokenConfigured
    ? settings.lineChannelAccessTokenFromEnv
      ? "ตั้งค่าไว้ใน Vercel Environment แล้ว"
      : "มีค่าเดิมอยู่แล้ว เว้นว่างไว้เพื่อคงค่าเดิม"
    : "ยังไม่ได้ตั้งค่า";
  els.content.innerHTML = `
    <section class="section saas-page settings-page">
      <div class="page-identity workspace-hero settings-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Professional SaaS Settings</span>
          <h2>ตั้งค่าระบบและการเติบโตของร้าน</h2>
          <p>จัดการ store profile, LINE, team, backup และพื้นที่สำหรับ subscription ในอนาคต</p>
        </div>
        <button class="button secondary" type="button" data-view-shortcut="pricing">ดูแพ็กเกจ</button>
      </div>
      <div class="settings-sections">
        ${[
          ["Store profile", "ชื่อร้าน โลโก้ และข้อมูลพื้นฐาน"],
          ["LINE settings", "เชื่อม LINE OA และ webhook"],
          ["Subscription plan", "เตรียมโครง monthly / yearly plan"],
          ["Billing", "พื้นที่สำหรับใบแจ้งหนี้และการชำระเงินในอนาคต"],
          ["User/account", "สิทธิ์ผู้ใช้และทีมงาน"],
          ["Import/Export", "จัดการย้ายข้อมูลเข้าออกระบบ"],
          ["Backup", "สำรองข้อมูลและกู้คืน"]
        ].map(([title, desc]) => `
          <article class="more-card">
            <span>${escapeHtml(title)}</span>
            <strong>${escapeHtml(desc)}</strong>
            <small>พร้อมขยายต่อในอนาคต โดยยังไม่กระทบระบบเดิม</small>
          </article>
        `).join("")}
      </div>
      <div class="two-col">
        <form class="panel stack" id="settingsForm">
          <div class="section-title">
            <h2>ตั้งค่าระบบ</h2>
            <p>Store profile, VIP, Template ข้อความ, LINE OA และสิทธิ์ Staff</p>
          </div>
          <label>ชื่อธุรกิจ<input name="businessName" value="${escapeHtml(settings.businessName || "Growup")}"></label>
          <label>ราคาต่อกระปุกเริ่มต้น<input name="defaultJarPrice" type="number" min="0" value="${Number(settings.defaultJarPrice || 750)}"></label>
          <div class="form-grid">
            <label>VIP Threshold<input name="vipThreshold" type="number" min="0" value="${Number(thresholds.vip || 5000)}"></label>
            <label>VVIP Threshold<input name="vvipThreshold" type="number" min="0" value="${Number(thresholds.vvip || 10000)}"></label>
            <label>SUPER VIP Threshold<input name="superVipThreshold" type="number" min="0" value="${Number(thresholds.superVip || 20000)}"></label>
          </div>
          <label>Template ข้อความลูกค้าปกติ<textarea name="normalTemplate">${escapeHtml(templates.normal || "")}</textarea></label>
          <label>Template ข้อความ VIP<textarea name="vipTemplate">${escapeHtml(templates.vip || "")}</textarea></label>
          <label>LINE Channel ID<input name="lineChannelId" value="${escapeHtml(settings.lineChannelId || "")}" ${settings.lineChannelIdFromEnv ? "readonly" : ""}></label>
          <label>LINE Channel Secret<input name="lineChannelSecret" type="password" autocomplete="new-password" placeholder="${escapeHtml(lineSecretHelp)}"></label>
          <label>LINE Channel Access Token<textarea name="lineChannelAccessToken" autocomplete="off" placeholder="${escapeHtml(lineTokenHelp)}"></textarea></label>
          <label class="inline">
            <input name="lineWebhookEnabled" type="checkbox" ${settings.lineWebhookEnabled ? "checked" : ""} style="width:auto">
            เปิดรับ LINE Webhook
          </label>
          <div class="panel tight">
            <strong>Webhook Endpoint</strong>
            <p class="muted">${location.origin}/api/line/webhook</p>
            <div class="inline">
              <button class="button ghost" type="button" data-copy-webhook>คัดลอก URL</button>
              <button class="button secondary" type="button" data-test-webhook>ทดสอบ Mock Webhook</button>
            </div>
          </div>
          <label class="inline">
            <input name="staffCanExport" type="checkbox" ${settings.staffCanExport ? "checked" : ""} style="width:auto">
            Staff สามารถ Export ข้อมูลได้
          </label>
          <button class="button primary" type="submit">บันทึก Settings</button>
        </form>
        <form class="panel stack" id="rulesForm">
          ${followUpSettingsPanel(Number(settings.followUpDaysPerUnit || 15))}
        </form>
      </div>
    </section>
  `;
}

function renderPricing() {
  els.content.innerHTML = `
    <section class="section saas-page pricing-page">
      <div class="page-identity workspace-hero pricing-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Package / Pricing</span>
          <h2>Growup Pilot สำหรับร้านที่กำลังโต</h2>
          <p>โครงหน้าแพ็กเกจแบบ SaaS สำหรับรองรับ monthly และ yearly subscription ในอนาคต โดยยังไม่แตะ business logic การชำระเงินจริง</p>
        </div>
      </div>
      <div class="pricing-grid">
        <article class="pricing-card">
          <span class="tag">Starter</span>
          <h3>เริ่มต้นดูแลร้าน</h3>
          <div class="pricing-price">฿0<span>/ทดลอง</span></div>
          <p class="muted">เหมาะสำหรับทดลอง dashboard, orders, customers และ workflow พื้นฐาน</p>
          <ul class="feature-list">
            <li>จัดการออเดอร์และลูกค้า</li>
            <li>Dashboard สรุปงานวันนี้</li>
            <li>Import CSV / Excel</li>
          </ul>
        </article>
        <article class="pricing-card featured">
          <span class="tag">Growth</span>
          <h3>Growup Pilot Pro</h3>
          <div class="pricing-price">฿1,990<span>/เดือน</span></div>
          <p class="muted">สำหรับธุรกิจที่ต้องการ AI insight, broadcast workflow และ command center เต็มรูปแบบ</p>
          <ul class="feature-list">
            <li>AI Morning Brief และ Opportunity Engine</li>
            <li>Campaigns, Broadcast, Reports</li>
            <li>Team access และการตั้งค่าร้านแบบ SaaS</li>
          </ul>
        </article>
        <article class="pricing-card">
          <span class="tag">Scale</span>
          <h3>For multi-store teams</h3>
          <div class="pricing-price">Custom<span>/yearly</span></div>
          <p class="muted">พื้นที่รองรับแผน enterprise, multi-user workflow, billing และ support เฉพาะทีมขาย</p>
          <ul class="feature-list">
            <li>Store profile หลายสาขา</li>
            <li>Advanced reporting และ export</li>
            <li>Billing, backup และ onboarding เฉพาะองค์กร</li>
          </ul>
        </article>
      </div>
    </section>
  `;
}

function followUpPreviewRows(daysPerUnit) {
  return [1, 2, 3, 4, 6, 10, 20].map(units => ({
    units,
    days: units * daysPerUnit
  }));
}

function followUpSettingsPanel(daysPerUnit) {
  const safeDays = Math.max(1, Number(daysPerUnit || 15));
  return `
    <div class="section-title">
      <h2>ตั้งค่าการติดตามลูกค้า</h2>
    </div>
    <label class="followup-setting-row" for="followupDaysPerUnit">
      <span>จำนวนวันต่อ 1 กระปุก</span>
      <div class="followup-setting-input">
        <input id="followupDaysPerUnit" name="daysPerUnit" type="number" min="1" required value="${safeDays}">
        <span>วัน / กระปุก</span>
      </div>
      <div class="followup-setting-note">ระบบจะคำนวณวันติดตามอัตโนมัติจากจำนวนกระปุกที่ลูกค้าได้รับทั้งหมด (รวมของแถม)</div>
    </label>
    <div class="panel tight followup-preview-panel">
      <strong>ตารางอ้างอิง</strong>
      <div class="table-wrap mobile-stack-wrap">
        <table class="rules-table mobile-stack-table">
          <thead><tr><th>ลูกค้าได้รับทั้งหมด</th><th>ระบบติดตามอีก</th></tr></thead>
          <tbody id="followupPreviewBody">
            ${followUpPreviewRows(safeDays).map(row => `
              <tr>
                <td data-label="ลูกค้าได้รับทั้งหมด">${row.units} กระปุก</td>
                <td data-label="ระบบติดตามอีก">${row.days} วัน</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
    <button class="button primary" type="submit">บันทึกค่า Follow-up</button>
  `;
}

function renderSettingsFollowup() {
  const daysPerUnit = Number(app.data.settings.followUpDaysPerUnit || 15);
  els.content.innerHTML = `
    <section class="section">
      <form class="panel stack" id="rulesForm">
        ${followUpSettingsPanel(daysPerUnit)}
      </form>
    </section>
  `;
}

function renderSettingsVip() {
  const thresholds = app.data.settings.vipThresholds || {};
  els.content.innerHTML = `
    <section class="section">
      <form class="panel stack" id="settingsVipForm">
        <div class="section-title">
          <h2>ตั้งค่า VIP</h2>
          <p>กำหนดยอดสะสมขั้นต่ำสำหรับแต่ละระดับ</p>
        </div>
        <div class="form-grid">
          <label>VIP Threshold
            <input name="vipThreshold" type="number" min="0" required value="${Number(thresholds.vip ?? 5000)}">
          </label>
          <label>VVIP Threshold
            <input name="vvipThreshold" type="number" min="0" required value="${Number(thresholds.vvip ?? 10000)}">
          </label>
          <label>SUPER VIP Threshold
            <input name="superVipThreshold" type="number" min="0" required value="${Number(thresholds.superVip ?? 20000)}">
          </label>
        </div>
        <button class="button primary" type="submit">บันทึกตั้งค่า VIP</button>
      </form>
    </section>
  `;
}

function renderSettingsLine() {
  const settings = app.data.settings;
  const secretPlaceholder = settings.lineChannelSecretConfigured ? "•••••••••••• (ตั้งค่าแล้ว)" : "ยังไม่ได้ตั้งค่า";
  const tokenPlaceholder = settings.lineChannelAccessTokenConfigured ? "•••••••••••• (ตั้งค่าแล้ว)" : "ยังไม่ได้ตั้งค่า";
  els.content.innerHTML = `
    <section class="section">
      <form class="panel stack" id="settingsLineForm">
        <div class="section-title">
          <h2>ตั้งค่า LINE OA</h2>
          <p>เว้น Secret หรือ Access Token ว่างไว้เพื่อใช้ค่าเดิม</p>
        </div>
        <label>LINE Group ID
          <input name="lineGroupId" value="${escapeHtml(settings.lineGroupId || "")}" ${settings.lineGroupIdFromEnv ? "readonly" : ""}>
        </label>
        <label>Channel ID
          <input name="lineChannelId" value="${escapeHtml(settings.lineChannelId || "")}" ${settings.lineChannelIdFromEnv ? "readonly" : ""}>
        </label>
        <label>Channel Secret
          <input name="lineChannelSecret" type="password" autocomplete="new-password" placeholder="${escapeHtml(secretPlaceholder)}" ${settings.lineChannelSecretFromEnv ? "readonly" : ""}>
        </label>
        <label>Access Token
          <textarea name="lineChannelAccessToken" autocomplete="off" placeholder="${escapeHtml(tokenPlaceholder)}" ${settings.lineChannelAccessTokenFromEnv ? "readonly" : ""}></textarea>
        </label>
        <label>Webhook URL
          <input value="${escapeHtml(`${location.origin}/api/line/webhook`)}" readonly>
        </label>
        <label class="inline">
          <input name="lineWebhookEnabled" type="checkbox" ${settings.lineWebhookEnabled ? "checked" : ""} style="width:auto">
          เปิดรับ LINE Webhook
        </label>
        <button class="button primary" type="submit">บันทึกตั้งค่า LINE OA</button>
      </form>
    </section>
  `;
}

async function loadLineDebugRows() {
  const payload = await api("/api/line-debug?limit=50");
  app.lineDebugRows = payload.rows || [];
  app.lineDebugSummary = payload.summary || {};
  renderLineDebugTable();
}

function renderLineDebugTable() {
  const target = document.querySelector("#lineDebugTable");
  if (!target) return;
  const rows = app.lineDebugRows || [];
  const summary = app.lineDebugSummary || {};
  target.innerHTML = `
    <div class="mini-stats">
      <div class="mini-stat"><span>Last HTTP request</span><strong>${escapeHtml(summary.last_http_request_received || "-")}</strong></div>
      <div class="mini-stat"><span>LINE request seen</span><strong>${summary.line_request_seen ? "Yes" : "No"}</strong></div>
      <div class="mini-stat"><span>Signature validation</span><strong>${escapeHtml(summary.signature_validation || "not_seen")}</strong></div>
      <div class="mini-stat"><span>Handler reached</span><strong>${summary.last_http_request_received ? "Yes" : "No"}</strong></div>
    </div>
    ${rows.length ? `
    <div class="table-wrap mobile-stack-wrap">
      <table class="rules-table mobile-stack-table">
        <thead>
          <tr>
            <th>Received</th>
            <th>HTTP</th>
            <th>LINE</th>
            <th>Signature</th>
            <th>Event</th>
            <th>Source</th>
            <th>Group ID</th>
            <th>User ID</th>
            <th>Text</th>
            <th>Parser</th>
            <th>Insert</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              <td data-label="Received">${formatDateTime(row.received_at)}</td>
              <td data-label="HTTP">${escapeHtml(row.http_method || "-")} ${escapeHtml(String(row.http_body_length || "-"))}</td>
              <td data-label="LINE">${row.http_is_line_request ? "Yes" : "No"}</td>
              <td data-label="Signature">${escapeHtml(row.http_signature_validation || "-")}</td>
              <td data-label="Event">${escapeHtml(row.event_type || "-")}</td>
              <td data-label="Source">${escapeHtml(row.source_type || "-")}</td>
              <td data-label="Group ID">${escapeHtml(row.groupId || "-")}</td>
              <td data-label="User ID">${escapeHtml(row.userId || "-")}</td>
              <td data-label="Text">${escapeHtml(row.text || "-")}</td>
              <td data-label="Parser">${escapeHtml(row.parser_status || "-")}</td>
              <td data-label="Insert">${escapeHtml(row.supabase_insert_status || "-")}</td>
              <td data-label="Error">${escapeHtml(row.error_message || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ` : `<div class="empty-state">ยังไม่มี LINE webhook event</div>`}
  `;
}

function renderLineDebug() {
  els.content.innerHTML = `
    <section class="section">
      <div class="panel stack">
        <div class="section-title">
          <h2>LINE Debug</h2>
          <p>ตรวจ webhook event ล่าสุดจาก LINE Group</p>
        </div>
        <div class="inline">
          <button class="button secondary" type="button" data-refresh-line-debug>Refresh</button>
          <button class="button ghost" type="button" data-copy="${escapeHtml(`${location.origin}/api/line/webhook`)}">Copy Webhook URL</button>
        </div>
        <div id="lineDebugTable"><div class="empty-state">กำลังโหลด...</div></div>
      </div>
    </section>
  `;
  loadLineDebugRows().catch(error => {
    showToast(error.message || "โหลด LINE Debug ไม่สำเร็จ");
  });
}

function renderCustomerDetail(customer) {
  els.dialogCustomerName.textContent = customer.name;
  els.customerDetail.innerHTML = `
    <div class="customer-detail-hero">
      <div class="avatar large">${escapeHtml(initials(customer.name))}</div>
      <div>
        <h2>${escapeHtml(customer.name)}</h2>
        <div class="inline">${vipBadge(customer.vipLevel)} ${badge(customer.status)}</div>
        <p>${escapeHtml(customer.phone)}</p>
      </div>
    </div>
    <div class="detail-actions">
      <a class="button primary" href="tel:${escapeHtml(customer.phone)}">โทร</a>
      <button class="button ghost" type="button" data-copy="${escapeHtml(customer.phone)}">คัดลอกเบอร์</button>
      <button class="button secondary" type="button" data-copy="${escapeHtml(makeMessage(customer))}">คัดลอกข้อความทัก</button>
      ${customer.purchaseCount === 0 ? `
        <button class="button danger" type="button" data-delete-customer="${escapeHtml(customer.id)}">ลบลูกค้า</button>
      ` : ""}
    </div>
    <div class="detail-grid">
      <div class="panel stack detail-card">
        <div class="mini-stats">
          <div class="mini-stat"><span>ซื้อทั้งหมด</span><strong>${customer.purchaseCount} ครั้ง</strong></div>
          <div class="mini-stat"><span>รวม</span><strong>${customer.totalJars} กระปุก</strong></div>
          <div class="mini-stat mini-stat-primary"><span>ยอดสะสม</span><strong>${money(customer.totalSpent)} บาท</strong></div>
          <div class="mini-stat"><span>Customer Score</span><strong>${money(customer.customerScore)}</strong></div>
        </div>
        <div class="mini-stats">
          <div class="mini-stat"><span>ซื้อครั้งแรก</span><strong>${formatShortDate(customer.firstPurchaseDate)}</strong></div>
          <div class="mini-stat"><span>ซื้อล่าสุด</span><strong>${formatShortDate(customer.lastPurchaseDate)}</strong></div>
          <div class="mini-stat"><span>ควรทักอีก</span><strong>${formatShortDate(customer.followUpDate)}</strong></div>
          <div class="mini-stat"><span>กระปุกล่าสุด</span><strong>${customer.lastJars}</strong></div>
        </div>
        <div class="info-card"><span>เบอร์</span><strong>${escapeHtml(customer.phone)}</strong></div>
        <div class="info-card"><span>ที่อยู่จัดส่ง</span><strong>${escapeHtml(customer.address || "-")}</strong></div>
        <form class="stack" id="customerEditForm">
          <input type="hidden" name="customerId" value="${customer.id}">
          <label>อาการลูกค้า
            <input name="tags" value="${escapeHtml((customer.tags || []).join(", "))}">
          </label>
          <label>หมายเหตุลูกค้า
            <textarea name="note">${escapeHtml(customer.note || "")}</textarea>
          </label>
          <button class="button secondary" type="submit">บันทึกอาการลูกค้า / หมายเหตุ</button>
        </form>
        <form class="stack" id="contactForm">
          <input type="hidden" name="customerId" value="${customer.id}">
          <div class="contact-form-section">
            <h3>บันทึกการติดต่อ</h3>
            <div class="contact-primary-grid">
              <label>วันที่ติดต่อ<input name="date" type="date" value="${dateInputValue(customer.lastContactDate)}"></label>
              <label>ผลลัพธ์
                <select name="result">
                  ${["โทรติด", "ไม่รับ", "สนใจ", "ยังไม่หมด", "สั่งซื้อแล้ว", "โทรใหม่"].map(result => `<option>${result}</option>`).join("")}
                </select>
              </label>
            </div>
          </div>
          <div class="contact-form-section">
            <h3>นัดหมายครั้งถัดไป</h3>
            <div class="contact-followup-grid">
              <label class="contact-followup-date">นัดติดตามครั้งถัดไป<input name="nextFollowUpDate" type="date"></label>
              <label class="contact-followup-staff">ผู้ติดต่อ<input name="staff" value="${escapeHtml(app.currentUser?.name || "")}"></label>
            </div>
          </div>
          <div class="contact-form-section">
            <label>หมายเหตุ
              <input name="note" value="${escapeHtml(customer.lastContactNote || "")}">
            </label>
          </div>
          <button class="button primary" type="submit">บันทึกการติดต่อ</button>
        </form>
      </div>
      <div class="panel stack detail-card">
        <h3>ประวัติออเดอร์</h3>
        <div class="timeline">
          ${customer.orders.slice().reverse().map(order => `
            <div class="timeline-item">
              <strong>${formatShortDate(order.date)} · ${order.jars} กระปุก · ${money(order.amount)} บาท</strong>
              <span class="muted">ช่องทางการสั่งซื้อ ${escapeHtml(displayOrderChannel(order))}</span>
              <span class="muted">เบอร์สำรอง ${escapeHtml(order.alternatePhone || "-")} · ลูกค้ามาจาก ${escapeHtml(order.originSource || "-")}</span>
              <span class="muted">Facebook / LINE ลูกค้า ${escapeHtml(order.socialName || "-")} · ของแถม ${escapeHtml(order.freeGift || "-")}</span>
              <span class="muted">บัตร VIP ${escapeHtml(order.vipCardStatus || "-")}</span>
              <span class="muted">อาการลูกค้า ${escapeHtml((order.tags || []).join(", ") || "-")} · หมายเหตุ ${escapeHtml(order.note || "-")}</span>
              ${order.vipCardReminder ? `<span class="muted">${escapeHtml(order.vipCardReminder)}</span>` : ""}
              ${order.vipDiscountFlag ? `<span class="muted">${escapeHtml(order.vipDiscountFlag)}</span>` : ""}
            </div>
          `).join("")}
        </div>
        <h3>ประวัติการติดต่อ</h3>
        <div class="timeline">
          ${(customer.contactLogs || []).map(log => `
            <div class="timeline-item">
              <strong>${formatShortDate(log.date)} · ${escapeHtml(log.result || "-")}</strong>
              <span class="muted">${escapeHtml(log.note || "-")}</span>
              <span class="muted">ผู้ติดต่อ ${escapeHtml(log.staff || "-")}${log.nextFollowUpDate ? ` · นัด ${formatShortDate(log.nextFollowUpDate)}` : ""}</span>
            </div>
          `).join("") || `<div class="empty-state">ยังไม่มีประวัติการติดต่อ</div>`}
        </div>
      </div>
    </div>
  `;
  els.customerDialog.showModal();
}

function render() {
  if (!app.data && app.view !== "login") return;
  renderNav();
  updateShell();
  els.pageTitle.textContent = titleFor(app.view);
  document.title = app.view === "login" ? "Growup Pilot" : `${titleFor(app.view)} | Growup Pilot`;
  renderSubpageNav();
  const renderer = {
    login: renderLogin,
    dashboard: renderDashboard,
    opportunities: renderOpportunities,
    orders: renderOrders,
    customers: renderSearch,
    products: renderProducts,
    marketing: renderMarketing,
    vip: renderVip,
    risk: renderRisk,
    tags: renderTags,
    import: renderImport,
    reports: renderReports,
    aiInsights: renderAiInsights,
    broadcast: renderBroadcast,
    campaigns: renderCampaigns,
    pricing: renderPricing,
    notifications: renderNotifications,
    team: renderTeam,
    settings: renderSettings,
    settingsFollowup: renderSettingsFollowup,
    settingsVip: renderSettingsVip,
    settingsLine: renderSettingsLine,
    lineDebug: renderLineDebug
  }[app.view] || renderDashboard;
  renderer();
}

function setView(view) {
  if (!canAccessView(view)) {
    showToast("เมนูนี้ต้องใช้สิทธิ์ Admin");
    return;
  }
  app.view = view;
  clearTimeout(app.importPollTimer);
  navigateToView(view);
  render();
  if (view === "import" && !app.importWorker) refreshImportJob().catch(error => showToast(error.message));
}

function syncViewFromLocation() {
  const nextView = routeFromLocation();
  if (!app.currentUser && nextView !== "login") {
    app.view = "login";
    navigateToView("login", true);
    render();
    return;
  }
  if (app.currentUser && nextView === "login") {
    app.view = "dashboard";
    navigateToView("dashboard", true);
    render();
    return;
  }
  if (!canAccessView(nextView)) {
    app.view = "settings";
    navigateToView("settings", true);
    showToast("เมนูนี้ต้องใช้สิทธิ์ Admin");
    render();
    return;
  }
  app.view = nextView;
  render();
}

async function submitOrder(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const preservedOriginSource = String(form.dataset.originSourceValue || "").trim();
  data.originSource = String(data.originSourceChoice || "").trim() || preservedOriginSource;
  delete data.originSourceChoice;
  const orderId = app.editingOrderId;
  const snapshot = cloneUiState();
  const clientMutationId = `tmp_${Date.now().toString(36)}`;
  const optimisticOrder = optimisticOrderFromForm(data, orderId, clientMutationId);
  applyOrderMutation({
    order: optimisticOrder,
    affectedCustomerIds: [optimisticOrder.customerId],
    customers: [],
    deletedCustomerIds: [],
    clientMutationId
  });
  patchOrdersView({ order: optimisticOrder, clientMutationId, affectedCustomerIds: [optimisticOrder.customerId] });
  app.editingOrderId = "";
  els.orderDialog.close();
  form.reset();
  showToast(orderId ? "แก้ไขออเดอร์แล้ว" : "บันทึกออเดอร์แล้ว");
  try {
    data.selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
    data.clientMutationId = clientMutationId;
    const payload = await api(orderId ? `/api/orders/${encodeURIComponent(orderId)}` : "/api/orders", {
      method: orderId ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
    applyOrderMutation(payload.mutation);
    patchOrdersView(payload.mutation);
    refreshVisibleCustomerPanels(payload.mutation);
  } catch (error) {
    restoreUiState(snapshot);
    throw error;
  }
}

function openDeleteOrderDialog(orderId) {
  app.deletingOrderId = orderId;
  els.deleteOrderDialog.showModal();
}

function openDeleteCustomerDialog(customerId) {
  app.deletingCustomerId = customerId;
  els.deleteCustomerDialog.showModal();
}

function openOrderDialog(order = null) {
  app.editingOrderId = order?.id || "";
  els.orderForm.reset();
  delete els.orderForm.dataset.originSourceValue;
  els.orderDialogTitle.textContent = order ? "แก้ไขออเดอร์" : "เพิ่มออเดอร์";
  els.orderSubmitButton.textContent = order ? "บันทึกการแก้ไข" : "บันทึกออเดอร์";
  if (order) {
    const fields = {
      orderNumber: order.orderNumber,
      date: order.date,
      sourceChannel: displayOrderChannel(order) === MISSING_CHANNEL_LABEL ? "" : displayOrderChannel(order),
      socialName: order.socialName,
      name: order.customerName,
      phone: order.phone,
      alternatePhone: order.alternatePhone,
      address: order.address,
      jars: order.jars,
      amount: order.amount,
      freeGift: order.freeGift,
      vipCardStatus: order.vipCardStatus,
      tags: (order.tags || []).join(", "),
      note: order.note
    };
    Object.entries(fields).forEach(([name, value]) => {
      if (els.orderForm.elements[name]) els.orderForm.elements[name].value = value ?? "";
    });
    const knownOriginSources = ["Facebook", "LINE", "โทรเข้า", "ลูกค้าบอกต่อ"];
    const originSource = String(order.originSource || "");
    els.orderForm.elements.originSourceChoice.value = knownOriginSources.includes(originSource) ? originSource : "";
    if (originSource && !knownOriginSources.includes(originSource)) {
      els.orderForm.dataset.originSourceValue = originSource;
    }
  } else {
    els.orderForm.elements.date.value = els.workDate.value || todayISO();
    els.orderForm.elements.amount.value = app.data?.settings?.defaultJarPrice || 750;
  }
  els.orderDialog.showModal();
}

function syncOriginSourceFields() {
  return;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("คัดลอกแล้ว");
  } catch {
    showToast("คัดลอกไม่สำเร็จ");
  }
}

async function handleImport(type) {
  const content = app.csvImportText;
  const payload = await api("/api/import", {
    method: "POST",
    body: JSON.stringify({ type, content })
  });
  showToast(`นำเข้า ${payload.imported} ออเดอร์ · ซ้ำ ${payload.duplicates || 0}`);
  app.csvImportText = "";
  app.csvPreview = [];
  app.csvPreviewSummary = null;
  await loadState();
}

async function previewCsvImport() {
  if (!app.csvImportText) return;
  const payload = await api("/api/csv-preview", {
    method: "POST",
    body: JSON.stringify({ content: app.csvImportText })
  });
  app.csvPreview = payload.rows || [];
  app.csvPreviewSummary = {
    imported: payload.imported || 0,
    duplicates: payload.duplicates || 0,
    invalid: payload.invalid || 0
  };
  renderImport();
}

document.addEventListener("click", async event => {
  if (event.target.closest("#mobileMenuToggle")) {
    document.body.classList.toggle("sidebar-open");
  }

  const navButton = event.target.closest("[data-view]");
  if (navButton) {
    setView(navButton.dataset.view);
    document.body.classList.remove("sidebar-open");
  }

  const shortcut = event.target.closest("[data-view-shortcut]");
  if (shortcut) {
    setView(shortcut.dataset.viewShortcut);
    document.body.classList.remove("sidebar-open");
  }

  if (event.target.closest("[data-open-order]") && app.view === "orders") openOrderDialog();

  const editOrderButton = event.target.closest("[data-edit-order]");
  if (editOrderButton) {
    const order = app.data.orders.find(item => item.id === editOrderButton.dataset.editOrder);
    if (order) openOrderDialog(order);
  }

  const deleteOrderButton = event.target.closest("[data-delete-order]");
  if (deleteOrderButton) openDeleteOrderDialog(deleteOrderButton.dataset.deleteOrder);

  const deleteCustomerButton = event.target.closest("[data-delete-customer]");
  if (deleteCustomerButton) openDeleteCustomerDialog(deleteCustomerButton.dataset.deleteCustomer);

  if (event.target.closest("[data-logout]")) els.logoutDialog.showModal();

  if (event.target.closest("[data-close-logout]")) els.logoutDialog.close();

  const tagFilter = event.target.closest("[data-tag-filter]");
  if (tagFilter) {
    app.filters = { q: "", tag: tagFilter.dataset.tagFilter, status: "", vip: "" };
    setView("customers");
  }

  const followupModeButton = event.target.closest("[data-followup-mode]");
  if (followupModeButton) {
    app.followupMode = followupModeButton.dataset.followupMode;
    renderFollowup();
  }

  const customerButton = event.target.closest("[data-open-customer]");
  if (customerButton) {
    const customer = app.data.customers.find(item => item.id === customerButton.dataset.openCustomer);
    if (customer) renderCustomerDetail(customer);
  }

  const row = event.target.closest("[data-customer]");
  if (row && !event.target.closest("button")) {
    const customer = app.data.customers.find(item => item.id === row.dataset.customer);
    if (customer) renderCustomerDetail(customer);
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) copyText(copyButton.dataset.copy);

  if (event.target.closest("[data-toggle-import-menu]")) {
    const menu = document.querySelector("#ordersImportMenu");
    if (menu) menu.hidden = !menu.hidden;
  } else {
    const menu = document.querySelector("#ordersImportMenu");
    if (menu && !event.target.closest("#ordersImportMenu")) menu.hidden = true;
  }

  const importActionButton = event.target.closest("[data-orders-import-action]");
  if (importActionButton) {
    const action = importActionButton.dataset.ordersImportAction;
    const menu = document.querySelector("#ordersImportMenu");
    if (menu) menu.hidden = true;
    if (action === "csv" || action === "excel") setView("import");
  }

  if (event.target.closest("[data-copy-webhook]")) {
    copyText(`${location.origin}/api/line/webhook`);
  }

  if (event.target.closest("[data-test-webhook]")) {
    const payload = await api("/api/line/mock", {
      method: "POST",
      body: JSON.stringify({
        text: "คุณทดสอบ โทร 0891234567 2 กระปุก รวม 1500 บาท #ทดสอบ"
      })
    });
    showToast(`Webhook mock สำเร็จ ${payload.parsedOrders || 0} ออเดอร์`);
    await loadState();
  }

  if (event.target.closest("[data-refresh-line-debug]")) {
    await loadLineDebugRows();
    showToast("โหลด LINE Debug แล้ว");
  }

  const importButton = event.target.closest("[data-import]");
  if (importButton) handleImport(importButton.dataset.import);

  if (event.target.closest("[data-preview-csv]")) previewCsvImport();

  if (event.target.closest("[data-start-import]")) startPreparedImport();

  if (event.target.closest("[data-cancel-import]")) {
    if (app.importWorker) app.importWorker.postMessage({ type: "cancel" });
    else if (app.importJob?.id) {
      const payload = await api(`/api/import-jobs/${encodeURIComponent(app.importJob.id)}/cancel`, {
        method: "POST",
        body: "{}"
      });
      app.importJob = payload.job;
      renderImport();
    }
  }

  if (event.target.closest("[data-rollback-import]")) {
    if (!app.importCleanup?.job?.id) return;
    const payload = await api(`/api/import-jobs/${encodeURIComponent(app.importCleanup.job.id)}/cleanup`, {
      method: "POST",
      body: "{}"
    });
    app.importJob = payload.cleanup?.job || null;
    app.importCleanup = null;
    showToast(`Rollback เสร็จแล้ว: ลบออเดอร์ ${payload.cleanup?.deletedOrders || 0} รายการ`);
    await loadState();
  }

  if (event.target.closest("[data-reset-filters]")) {
    app.filters = { q: "", tag: "", status: "", vip: "" };
    renderSearch();
  }

  if (event.target.closest("[data-reset-order-filters]")) {
    app.ordersFilterQ = "";
    renderOrders();
  }

  if (event.target.closest("[data-close-order]")) {
    app.editingOrderId = "";
    els.orderDialog.close();
  }

  if (event.target.closest("[data-close-delete-order]")) {
    app.deletingOrderId = "";
    els.deleteOrderDialog.close();
  }

  if (event.target.closest("[data-close-delete-customer]")) {
    app.deletingCustomerId = "";
    els.deleteCustomerDialog.close();
  }

  if (event.target.closest("[data-close-customer]")) els.customerDialog.close();

});

document.addEventListener("input", event => {
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    app.filters[filter.dataset.filter] = filter.value;
    updateSearchResults();
  }

  const orderFilter = event.target.closest("[data-order-filter]");
  if (orderFilter) {
    app.ordersFilterDraft = orderFilter.value;
  }

  if (event.target.closest("[data-order-search]")) {
    app.ordersFilterQ = app.ordersFilterDraft;
    renderOrders();
  }

  if (event.target?.id === "followupDaysPerUnit") {
    const body = document.querySelector("#followupPreviewBody");
    if (!body) return;
    const daysPerUnit = Math.max(1, Number(event.target.value || 0) || 15);
    body.innerHTML = followUpPreviewRows(daysPerUnit).map(row => `
      <tr>
        <td>${row.units} กระปุก</td>
        <td>${row.days} วัน</td>
      </tr>
    `).join("");
  }
});

document.addEventListener("change", event => {
  if (event.target === els.orderForm.elements.originSourceChoice) syncOriginSourceFields();
});

document.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  if (event.target?.matches?.("[data-order-filter]")) {
    event.preventDefault();
    app.ordersFilterQ = app.ordersFilterDraft;
    renderOrders();
  }
});

document.addEventListener("change", async event => {
  if (event.target === els.workDate) {
    app.ordersShowAll = false;
    app.customersShowAll = false;
    await loadState();
  }

  if (event.target?.matches?.("[data-orders-show-all]")) {
    app.ordersShowAll = event.target.checked;
    renderOrders();
  }

  if (event.target?.matches?.("[data-customers-show-all]")) {
    app.customersShowAll = event.target.checked;
    renderSearch();
  }

  if (event.target?.matches?.("[data-report-month]")) {
    app.reportMonth = event.target.value;
    renderReports();
  }

  if (event.target?.matches?.("[data-report-date]")) {
    app.reportDate = event.target.value;
    renderReports();
  }

  if (event.target?.id === "followupDatePicker") {
    els.workDate.value = event.target.value;
    app.followupMode = "custom";
    await loadState();
  }

  if (event.target?.id === "csvFile") {
    const file = event.target.files?.[0];
    if (!file) return;
    startCsvImport(file);
  }

  if (event.target?.id === "importSheetSelect" && app.importWorker) {
    app.importPreparing = true;
    renderImport();
    app.importWorker.postMessage({
      type: "select-sheet",
      sheetName: event.target.value,
      defaultJarPrice: Number(app.data?.settings?.defaultJarPrice || 750)
    });
  }
});

document.addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;

  try {
    if (form.id === "loginForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      const payload = await api("/api/login", {
        method: "POST",
        body: JSON.stringify(data)
      });
      saveSession(payload.user);
      app.view = "dashboard";
      navigateToView("dashboard");
      showToast("เข้าสู่ระบบแล้ว");
      await loadState();
    }

    if (form.id === "orderForm") {
      await submitOrder(form);
    }

    if (form.id === "deleteOrderForm" && app.deletingOrderId) {
      const snapshot = cloneUiState();
      const deletingOrder = app.data.orders.find(order => order.id === app.deletingOrderId);
      const optimisticMutation = {
        deletedOrderId: app.deletingOrderId,
        affectedCustomerIds: deletingOrder?.customerId ? [deletingOrder.customerId] : []
      };
      applyOrderMutation(optimisticMutation);
      patchOrdersView(optimisticMutation);
      app.deletingOrderId = "";
      els.deleteOrderDialog.close();
      showToast("ลบออเดอร์แล้ว");
      try {
        const payload = await api(`/api/orders/${encodeURIComponent(optimisticMutation.deletedOrderId)}?date=${encodeURIComponent(app.data.summary?.selectedDate || els.workDate.value || todayISO())}`, {
          method: "DELETE"
        });
        applyOrderMutation(payload.mutation);
        patchOrdersView(payload.mutation);
        refreshVisibleCustomerPanels(payload.mutation);
      } catch (error) {
        restoreUiState(snapshot);
        throw error;
      }
    }

    if (form.id === "deleteCustomerForm" && app.deletingCustomerId) {
      await api(`/api/customers/${encodeURIComponent(app.deletingCustomerId)}`, {
        method: "DELETE"
      });
      app.deletingCustomerId = "";
      els.deleteCustomerDialog.close();
      els.customerDialog.close();
      showToast("ลบลูกค้าแล้ว");
      await loadState();
    }

    if (form.id === "logoutForm") {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        // Session may already be expired; still return to login.
      }
      els.logoutDialog.close();
      clearSession();
      app.view = "login";
      navigateToView("login");
      render();
    }

    if (form.id === "teamForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/team", {
        method: "POST",
        body: JSON.stringify(data)
      });
      showToast("เพิ่มทีมงานแล้ว");
      await loadState();
    }

    if (form.id === "tagsForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/tags", {
        method: "POST",
        body: JSON.stringify(data)
      });
      showToast("เพิ่มอาการลูกค้าแล้ว");
      form.reset();
      await loadState();
    }

    if (form.id === "settingsForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      data.lineWebhookEnabled = form.elements.lineWebhookEnabled.checked;
      data.staffCanExport = form.elements.staffCanExport.checked;
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึก Settings แล้ว");
      await loadState();
    }

    if (form.id === "settingsVipForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกตั้งค่า VIP แล้ว");
      await loadState();
    }

    if (form.id === "vipThresholdForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกยอด VIP แล้ว");
      await loadState();
    }

    if (form.id === "settingsLineForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      data.lineWebhookEnabled = form.elements.lineWebhookEnabled.checked;
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกตั้งค่า LINE OA แล้ว");
      await loadState();
    }

    if (form.id === "rulesForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/followup-rules", {
        method: "PUT",
        body: JSON.stringify({ daysPerUnit: data.daysPerUnit })
      });
      showToast("บันทึกค่า Follow-up แล้ว");
      await loadState();
    }

    if (form.id === "contactForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/contact-log", {
        method: "POST",
        body: JSON.stringify(data)
      });
      showToast("บันทึกการติดต่อแล้ว");
      els.customerDialog.close();
      await loadState();
    }

    if (form.id === "customerEditForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api(`/api/customers/${encodeURIComponent(data.customerId)}`, {
        method: "PUT",
        body: JSON.stringify({ tags: data.tags, note: data.note })
      });
      showToast("บันทึกข้อมูลลูกค้าแล้ว");
      els.customerDialog.close();
      await loadState();
    }
  } catch (error) {
    showToast(error.message);
  }
});

window.addEventListener("hashchange", syncViewFromLocation);
window.addEventListener("popstate", syncViewFromLocation);

// Add-order entry point is now rendered only inside the Orders page.
els.workDate.value = todayISO();

async function init() {
  await restoreSession();
  if (!app.currentUser) {
    app.view = "login";
    navigateToView("login", true);
    render();
    return;
  }
  await loadState();
  if (app.view === "import") await refreshImportJob();
}

init().catch(error => {
  els.content.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
});
