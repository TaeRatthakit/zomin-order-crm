const navItems = [
  ["dashboard", "/dashboard", "หน้าหลัก", "home"],
  ["search", "/customers", "ลูกค้า", "users"],
  ["orders", "/orders", "ออเดอร์", "clipboard"],
  ["followup", "/follow-up", "เตือน", "bell"],
  ["more", "/more", "เพิ่มเติม", "more"]
];

const routeToView = {
  "/": "dashboard",
  "/dashboard": "dashboard",
  "/customers": "search",
  "/orders": "orders",
  "/follow-up": "followup",
  "/more": "more",
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
  currentUser: null,
  data: null,
  lineDebugRows: [],
  lineDebugSummary: {},
  reportMonth: "",
  reportDate: "",
  ordersShowAll: false,
  customersShowAll: false,
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

const adminViews = new Set(["settings", "settingsFollowup", "settingsVip", "settingsLine", "lineDebug", "team"]);

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

function routeFromLocation() {
  if (location.hash) {
    const hashView = location.hash.replace("#", "");
    if (hashView === "customers") return "search";
    if (hashView === "follow-up") return "followup";
    return hashView || "dashboard";
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
    search: "ลูกค้า",
    orders: "ออเดอร์",
    followup: "เตือน",
    more: "เพิ่มเติม",
    vip: "ลูกค้า VIP",
    risk: "ลูกค้าเสี่ยงหาย",
    tags: "อาการลูกค้า",
    import: "เพิ่มข้อมูลเก่า",
    reports: "รายงานยอดขาย",
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
  "settingsFollowup", "settingsVip", "settingsLine"
]);

function renderSubpageNav() {
  if (!moreSubpages.has(app.view)) {
    els.subpageNav.hidden = true;
    els.subpageNav.innerHTML = "";
    return;
  }
  els.subpageNav.hidden = false;
  els.subpageNav.innerHTML = `
    <button class="subpage-back" type="button" data-view-shortcut="more" aria-label="กลับไปหน้าเพิ่มเติม">←</button>
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <button type="button" data-view-shortcut="more">เพิ่มเติม</button>
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
    app.view = "more";
    navigateToView("more", true);
  }
  render();
}

function renderNav() {
  if (app.view === "login") {
    els.nav.innerHTML = "";
    return;
  }
  const activeGroup = ["vip", "risk", "tags", "import", "reports", "team", "settings"].includes(app.view) ? "more" : app.view;
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
  return String(name).replace(/^คุณ/, "").trim().slice(0, 2) || "ZO";
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

function renderLogin() {
  els.content.innerHTML = `
    <section class="login-layout">
      <div class="login-desktop-card">
        <aside class="login-brand-panel">
          <div class="login-brand-mark">Z</div>
          <div>
            <p class="eyebrow">Zomin CRM</p>
            <h2>Order Management System</h2>
            <p>จัดการออเดอร์ ลูกค้า การติดตาม และข้อมูลทีมขายในที่เดียว</p>
          </div>
        </aside>
        <form class="login-card" id="loginForm">
          <div class="login-logo">Z</div>
          <div class="section-title">
            <h2>Zomin Order CRM</h2>
            <p>Mobile CRM สำหรับทีมขาย Zomin</p>
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
    <article class="customer-list-card" data-customer="${customer.id}">
      <div class="customer-card-top">
        <div class="customer-identity">
          <div class="avatar">${escapeHtml(initials(customer.name))}</div>
          <div>
            <h3>${escapeHtml(customer.name)}</h3>
            <p>${escapeHtml(customer.phone)}</p>
          </div>
        </div>
        <div class="badge-stack">
          ${vipBadge(customer.vipLevel)}
          ${customer.status !== customer.vipLevel ? badge(customer.status) : ""}
        </div>
      </div>
      ${tagsHtml(customer.tags)}
      <div class="customer-card-metrics">
        <div><span>ซื้อล่าสุด</span><strong>${formatDate(customer.lastPurchaseDate)}</strong></div>
        <div><span>กระปุก</span><strong>${customer.lastJars || 0}</strong></div>
        <div><span>ยอดสะสม</span><strong>${money(customer.totalSpent)} บาท</strong></div>
        <div><span>ควรทัก</span><strong>${formatDate(customer.followUpDate)}</strong></div>
      </div>
      ${customer.purchaseCount === 0 ? `
        <button class="button danger" type="button" data-delete-customer="${escapeHtml(customer.id)}">ลบลูกค้า</button>
      ` : ""}
    </article>
  `;
}

function customerTable(customers, emptyText = "ไม่พบข้อมูลลูกค้า") {
  if (!customers.length) return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  return `
    <div class="customer-list">
      ${customers.map(customerRow).join("")}
    </div>
  `;
}

function orderTable(orders) {
  if (!orders.length) return `<div class="empty-state">ยังไม่มีออเดอร์ในวันที่เลือก</div>`;
  const sorted = [...orders].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return `
    <div class="order-list">
      ${sorted.map(order => `
        <article class="order-card">
          <div class="order-top">
            <div>
              <strong>${escapeHtml(order.customerName)}</strong>
              <span>${escapeHtml(order.orderNumber || "-")} · ${formatDate(order.date)} · ${escapeHtml(order.time || "-")}</span>
            </div>
            ${badge(order.status === "NEW" ? "NEW" : order.vipLevel)}
          </div>
          <div class="order-summary">
            <div><span>เลขออเดอร์</span><strong>${escapeHtml(order.orderNumber || "-")}</strong></div>
            <div><span>จำนวน</span><strong>${Number(order.jars || 0)} กระปุก</strong></div>
            <div><span>ยอดเงิน</span><strong>${money(order.amount)} บาท</strong></div>
            <div><span>ช่องทางการสั่งซื้อ</span><strong>${escapeHtml(order.sourceChannel || order.source || "-")}</strong></div>
          </div>
          <details class="order-details">
            <summary>ดูข้อมูลเพิ่มเติม</summary>
            <div class="order-grid">
              <div><span>วันที่ซื้อ</span><strong>${formatDate(order.date)}</strong></div>
              <div><span>ช่องทางการสั่งซื้อ</span><strong>${escapeHtml(order.sourceChannel || order.source || "-")}</strong></div>
              <div><span>Facebook / LINE ลูกค้า</span><strong>${escapeHtml(order.socialName || "-")}</strong></div>
              <div><span>ชื่อลูกค้า</span><strong>${escapeHtml(order.customerName || "-")}</strong></div>
              <div><span>เบอร์</span><strong>${escapeHtml(order.phone)}</strong></div>
              <div><span>เบอร์สำรอง</span><strong>${escapeHtml(order.alternatePhone || "-")}</strong></div>
              <div><span>ที่อยู่จัดส่ง</span><strong>${escapeHtml(order.address || "-")}</strong></div>
              <div><span>จำนวนกระปุก</span><strong>${Number(order.jars || 0)}</strong></div>
              <div><span>ยอดซื้อ</span><strong>${money(order.amount)} บาท</strong></div>
              <div><span>ลูกค้ามาจาก</span><strong>${escapeHtml(order.originSource || "-")}</strong></div>
              <div><span>ของแถม</span><strong>${escapeHtml(order.freeGift || "-")}</strong></div>
              <div><span>บัตร VIP</span><strong>${escapeHtml(order.vipCardStatus || "-")}</strong></div>
              <div><span>อาการลูกค้า</span><strong>${escapeHtml((order.tags || []).join(", ") || "-")}</strong></div>
              <div><span>หมายเหตุ</span><strong>${escapeHtml(order.note || "-")}</strong></div>
            </div>
            ${order.vipCardReminder ? `<p class="alert-text">${escapeHtml(order.vipCardReminder)}</p>` : ""}
            ${order.vipDiscountFlag ? `<p class="muted">${escapeHtml(order.vipDiscountFlag)}</p>` : ""}
          </details>
          <div class="inline order-actions">
            <button class="button ghost compact-action" data-open-customer="${escapeHtml(order.customerId)}">ดูรายละเอียด</button>
            <button class="button secondary compact-action soft-action" data-edit-order="${escapeHtml(order.id)}">แก้ไข</button>
            <button class="button danger compact-action trash-action" data-delete-order="${escapeHtml(order.id)}" aria-label="ลบออเดอร์">${iconSvg("trash")}<span>ลบ</span></button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderDashboard() {
  const s = app.data.summary;
  const due = sortByPriority(app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= s.selectedDate)).slice(0, 8);

  els.content.innerHTML = `
    <section class="section">
      <div class="metric-grid">
        ${metric("ยอดขายวันนี้", `${money(s.salesToday)} บาท`, "accent")}
        ${metric("ออเดอร์วันนี้", money(s.ordersToday || 0))}
        ${metric("กระปุกวันนี้", money(s.jarsToday || 0), "green")}
        ${metric("ลูกค้าทั้งหมด", money(s.customerCount))}
        ${metric("ยอดขายเดือนนี้", `${money(s.salesThisMonth)} บาท`, "purple")}
        ${metric("ออเดอร์เดือนนี้", money(s.ordersThisMonth || 0))}
        ${metric("ควรทักวันนี้", money(s.dueToday), "warn")}
        ${metric("VIP / VVIP / SUPER", `${s.vip} / ${s.vvip} / ${s.superVip}`)}
      </div>
      <div class="two-col">
        <div class="panel stack">
          <div class="section-header">
            <div class="section-title">
              <h2>ควรโทรวันนี้ ${money(s.dueToday)} คน</h2>
              <p>เรียงตาม SUPER VIP, VVIP, VIP, NORMAL และ Customer Score</p>
            </div>
            <button class="button secondary" data-view-shortcut="followup">เปิดคิวโทร</button>
          </div>
          ${followupCards(due.slice(0, 5), true)}
        </div>
        <div class="panel stack">
          <h2>กราฟยอดขายรายเดือน</h2>
          ${monthlyChart()}
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
  const orders = app.ordersShowAll
    ? app.data.orders
    : app.data.orders.filter(order => order.date === selectedDate);
  els.content.innerHTML = `
    <section class="section">
      <div class="section-title section-title-actions">
        <div>
          <h2>${app.ordersShowAll ? "ออเดอร์ทั้งหมด" : `ออเดอร์วันที่ ${formatDate(selectedDate)}`}</h2>
          <p>${app.ordersShowAll ? `แสดง ${money(orders.length)} ออเดอร์จากทุกวัน` : `แสดง ${money(orders.length)} ออเดอร์จากวันที่เลือก`}</p>
        </div>
        <div class="orders-header-actions">
          <label class="orders-show-all">
            <input type="checkbox" data-orders-show-all ${app.ordersShowAll ? "checked" : ""}>
            <span>แสดงทั้งหมด</span>
          </label>
          <button class="button primary" data-open-order>เพิ่มออเดอร์</button>
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
    const textMatch = !q || [customer.name, customer.phone, customer.address, ...(customer.tags || [])].join(" ").toLowerCase().includes(q);
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
    <section class="section">
      <div class="panel stack">
        <div class="section-title section-title-actions">
          <div>
            <h2>${app.customersShowAll ? "ลูกค้าทั้งหมด" : `ลูกค้าที่สั่งซื้อวันที่ ${formatDate(selectedDate)}`}</h2>
            <p>${app.customersShowAll ? "แสดงลูกค้าจากทุกวัน" : "แสดงเฉพาะลูกค้าที่มีออเดอร์ในวันที่เลือก"}</p>
          </div>
          <div class="orders-header-actions">
            <label class="orders-show-all">
              <input type="checkbox" data-customers-show-all ${app.customersShowAll ? "checked" : ""}>
              <span>แสดงทั้งหมด</span>
            </label>
          </div>
        </div>
        <p class="muted">ค้นจากชื่อ เบอร์ อาการลูกค้า สถานะ และ VIP Level</p>
        <div class="filters">
          <input data-filter="q" placeholder="ชื่อ เบอร์ อาการลูกค้า" value="${escapeHtml(app.filters.q)}">
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

function updateSearchResults() {
  const results = document.querySelector("#searchResults");
  if (!results) return;
  const customers = sortByPriority(applyCustomerFilters());
  results.innerHTML = customerTable(customers);
}

function makeMessage(customer) {
  const name = customer.name.replace(/^คุณ/, "คุณ");
  return `สวัสดีค่ะ ${name} จาก Zomin นะคะ รอบก่อนสั่ง ${customer.lastJars || 1} กระปุก ตอนนี้ใกล้ถึงรอบดูแลต่อเนื่องแล้วค่ะ ต้องการให้จัดส่งเพิ่มไหมคะ`;
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
    <section class="section">
      <div class="panel stack followup-toolbar">
        <div class="section-title">
          <h2>เตือนติดตามลูกค้า</h2>
          <p>${range.label} · ถึงวันที่ ${formatDate(range.end)}</p>
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
    ["team", "จัดการผู้ใช้", "Admin และ Staff", "ทีม"]
  ];
  const visibleCards = isAdmin() ? [...cards, ...adminCards] : cards;

  els.content.innerHTML = `
    <section class="section">
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
  els.content.innerHTML = `
    <section class="section">
      <div class="panel stack import-drop">
        <div class="section-title">
          <h2>Import CSV ออเดอร์เก่า</h2>
          <p>อัปโหลดไฟล์ .csv เพื่อตรวจสอบรายการก่อนบันทึก</p>
        </div>
        <p class="muted">ถ้าต้องการกรอกออเดอร์เก่าเอง ให้ไปที่หน้า Orders เลือกวันที่ แล้วกด Add Order</p>
        <input class="file-input" id="csvFile" type="file" accept=".csv,text/csv">
        <div class="inline">
          <button class="button secondary" data-preview-csv type="button" ${app.csvImportText ? "" : "disabled"}>แสดงตัวอย่าง</button>
          <button class="button primary" data-import="csv" type="button" ${app.csvPreview.length ? "" : "disabled"}>บันทึกออเดอร์</button>
        </div>
        ${app.csvPreviewSummary ? `
          <p class="muted">พร้อมนำเข้า ${app.csvPreviewSummary.imported} · ซ้ำ ${app.csvPreviewSummary.duplicates} · ข้อมูลไม่ครบ ${app.csvPreviewSummary.invalid}</p>
        ` : ""}
        <div class="preview-list">
          ${app.csvPreview.map(row => `
            <div class="order-card">
              <div class="order-top">
                <strong>${escapeHtml(row.name)}</strong>
                ${row.duplicate ? `<span class="badge risk">ซ้ำ - ข้าม</span>` : `<span class="badge new">พร้อมนำเข้า</span>`}
              </div>
              <div class="order-grid">
                <div><span>วันที่</span><strong>${formatDate(row.date)}</strong></div>
                <div><span>เลขออเดอร์</span><strong>${escapeHtml(row.orderNumber || "-")}</strong></div>
                <div><span>เบอร์</span><strong>${escapeHtml(row.phone)}</strong></div>
                <div><span>จำนวน</span><strong>${money(row.jars)} กระปุก</strong></div>
                <div><span>ยอด</span><strong>${money(row.amount)} บาท</strong></div>
                <div><span>สั่งจาก</span><strong>${escapeHtml(row.sourceChannel || "-")}</strong></div>
                <div><span>Facebook / Line</span><strong>${escapeHtml(row.socialName || "-")}</strong></div>
                <div><span>อาการลูกค้า</span><strong>${escapeHtml(row.tags || "-")}</strong></div>
                <div><span>ของแถม</span><strong>${escapeHtml(row.freeGift || "-")}</strong></div>
                <div><span>บัตร VIP</span><strong>${escapeHtml(row.vipCardStatus || "-")}</strong></div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
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
    <section class="section">
      <div class="metric-grid">
        ${metric("ยอดขายเดือนนี้", `${money(app.data.summary.salesThisMonth)} บาท`, "accent")}
        ${metric("ออเดอร์รวม", money(app.data.orders.length))}
        ${metric("กระปุกรวม", money(app.data.orders.reduce((sum, order) => sum + Number(order.jars || 0), 0)), "green")}
        ${metric("ลูกค้าใหม่", money(app.data.summary.newCustomers))}
        ${metric("ลูกค้าซื้อซ้ำ", money(repeatCustomers), "purple")}
        ${metric("ออเดอร์เดือนนี้", money(monthOrders.length))}
      </div>
      <div class="report-grid">
        <div class="panel stack">
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
        <div class="panel stack">
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
        <div class="panel stack">
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
      <div class="panel stack">
        <h2>Top customers</h2>
        ${customerTable(topCustomers)}
      </div>
    </section>
  `;
}

function renderTeam() {
  els.content.innerHTML = `
    <section class="section">
      <div class="two-col">
        <div class="panel stack">
          <div class="section-title">
            <h2>สิทธิ์ผู้ใช้</h2>
            <p>Admin ดูทุกอย่างและแก้ไขได้, Staff ค้นหา เพิ่มข้อมูล ดู Follow-up และโทรลูกค้า</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>ชื่อ</th><th>สิทธิ์</th><th>เบอร์โทร</th><th>สถานะ</th></tr></thead>
              <tbody>
                ${app.data.users.map(user => `
                  <tr>
                    <td><strong>${escapeHtml(user.name)}</strong></td>
                    <td>${badge(user.role)}</td>
                    <td>${escapeHtml(user.phone || "-")}</td>
                    <td>${user.active ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <form class="panel stack" id="teamForm">
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
    <section class="section">
      <div class="two-col">
        <form class="panel stack" id="settingsForm">
          <div class="section-title">
            <h2>ตั้งค่าระบบ</h2>
            <p>VIP, Template ข้อความ, LINE OA และสิทธิ์ Staff</p>
          </div>
          <label>ชื่อธุรกิจ<input name="businessName" value="${escapeHtml(settings.businessName || "Zomin")}"></label>
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
      <div class="table-wrap">
        <table class="rules-table">
          <thead><tr><th>ลูกค้าได้รับทั้งหมด</th><th>ระบบติดตามอีก</th></tr></thead>
          <tbody id="followupPreviewBody">
            ${followUpPreviewRows(safeDays).map(row => `
              <tr>
                <td>${row.units} กระปุก</td>
                <td>${row.days} วัน</td>
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
    <div class="table-wrap">
      <table class="rules-table">
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
              <td>${formatDateTime(row.received_at)}</td>
              <td>${escapeHtml(row.http_method || "-")} ${escapeHtml(String(row.http_body_length || "-"))}</td>
              <td>${row.http_is_line_request ? "Yes" : "No"}</td>
              <td>${escapeHtml(row.http_signature_validation || "-")}</td>
              <td>${escapeHtml(row.event_type || "-")}</td>
              <td>${escapeHtml(row.source_type || "-")}</td>
              <td>${escapeHtml(row.groupId || "-")}</td>
              <td>${escapeHtml(row.userId || "-")}</td>
              <td>${escapeHtml(row.text || "-")}</td>
              <td>${escapeHtml(row.parser_status || "-")}</td>
              <td>${escapeHtml(row.supabase_insert_status || "-")}</td>
              <td>${escapeHtml(row.error_message || "-")}</td>
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
          <div class="mini-stat"><span>ยอดสะสม</span><strong>${money(customer.totalSpent)} บาท</strong></div>
          <div class="mini-stat"><span>Customer Score</span><strong>${money(customer.customerScore)}</strong></div>
        </div>
        <div class="mini-stats">
          <div class="mini-stat"><span>ซื้อครั้งแรก</span><strong>${formatDate(customer.firstPurchaseDate)}</strong></div>
          <div class="mini-stat"><span>ซื้อล่าสุด</span><strong>${formatDate(customer.lastPurchaseDate)}</strong></div>
          <div class="mini-stat"><span>ควรทักอีก</span><strong>${formatDate(customer.followUpDate)}</strong></div>
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
          <div class="form-grid">
            <label>วันที่ติดต่อ<input name="date" type="date" value="${dateInputValue(customer.lastContactDate)}"></label>
            <label>ผลลัพธ์
              <select name="result">
                ${["โทรติด", "ไม่รับ", "สนใจ", "ยังไม่หมด", "สั่งซื้อแล้ว", "โทรใหม่"].map(result => `<option>${result}</option>`).join("")}
              </select>
            </label>
            <label>นัดติดตามครั้งถัดไป<input name="nextFollowUpDate" type="date"></label>
            <label>ผู้ติดต่อ<input name="staff" value="${escapeHtml(app.currentUser?.name || "")}"></label>
            <label class="span-2">หมายเหตุ<input name="note" value="${escapeHtml(customer.lastContactNote || "")}"></label>
          </div>
          <button class="button primary" type="submit">บันทึกการติดต่อ</button>
        </form>
      </div>
      <div class="panel stack detail-card">
        <h3>ประวัติออเดอร์</h3>
        <div class="timeline">
          ${customer.orders.slice().reverse().map(order => `
            <div class="timeline-item">
              <strong>${formatDate(order.date)} · ${order.jars} กระปุก · ${money(order.amount)} บาท</strong>
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
              <strong>${formatDate(log.date)} · ${escapeHtml(log.result || "-")}</strong>
              <span class="muted">${escapeHtml(log.note || "-")}</span>
              <span class="muted">ผู้ติดต่อ ${escapeHtml(log.staff || "-")}${log.nextFollowUpDate ? ` · นัด ${formatDate(log.nextFollowUpDate)}` : ""}</span>
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
  renderSubpageNav();
  const renderer = {
    login: renderLogin,
    dashboard: renderDashboard,
    orders: renderOrders,
    search: renderSearch,
    followup: renderFollowup,
    more: renderMore,
    vip: renderVip,
    risk: renderRisk,
    tags: renderTags,
    import: renderImport,
    reports: renderReports,
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
  navigateToView(view);
  render();
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
    app.view = "more";
    navigateToView("more", true);
    showToast("เมนูนี้ต้องใช้สิทธิ์ Admin");
    render();
    return;
  }
  app.view = nextView;
  render();
}

async function submitOrder(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.originSource = data.originSourceChoice === "อื่นๆ"
    ? String(data.originSourceOther || "").trim()
    : String(data.originSourceChoice || "").trim();
  delete data.originSourceChoice;
  delete data.originSourceOther;
  const orderId = app.editingOrderId;
  await api(orderId ? `/api/orders/${encodeURIComponent(orderId)}` : "/api/orders", {
    method: orderId ? "PUT" : "POST",
    body: JSON.stringify(data)
  });
  app.editingOrderId = "";
  els.orderDialog.close();
  form.reset();
  showToast(orderId ? "แก้ไขออเดอร์แล้ว" : "บันทึกออเดอร์แล้ว");
  await loadState();
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
    els.orderForm.elements.originSourceChoice.value = knownOriginSources.includes(originSource)
      ? originSource
      : originSource ? "อื่นๆ" : "";
    els.orderForm.elements.originSourceOther.value = knownOriginSources.includes(originSource) ? "" : originSource;
  } else {
    els.orderForm.elements.date.value = els.workDate.value || todayISO();
    els.orderForm.elements.amount.value = app.data?.settings?.defaultJarPrice || 750;
  }
  syncOriginSourceFields();
  els.orderDialog.showModal();
}

function syncOriginSourceFields() {
  const otherField = els.orderForm.querySelector("[data-origin-source-other]");
  if (!otherField) return;
  const showOther = els.orderForm.elements.originSourceChoice.value === "อื่นๆ";
  otherField.toggleAttribute("hidden", !showOther);
  otherField.setAttribute("aria-hidden", String(!showOther));
  els.orderForm.elements.originSourceOther.required = showOther;
  if (!showOther) els.orderForm.elements.originSourceOther.value = "";
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
  const navButton = event.target.closest("[data-view]");
  if (navButton) setView(navButton.dataset.view);

  const shortcut = event.target.closest("[data-view-shortcut]");
  if (shortcut) setView(shortcut.dataset.viewShortcut);

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
    setView("search");
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

  if (event.target.closest("[data-reset-filters]")) {
    app.filters = { q: "", tag: "", status: "", vip: "" };
    renderSearch();
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
    app.csvImportText = await file.text();
    app.csvPreview = [];
    app.csvPreviewSummary = null;
    await previewCsvImport();
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
      await api(`/api/orders/${encodeURIComponent(app.deletingOrderId)}`, {
        method: "DELETE"
      });
      app.deletingOrderId = "";
      els.deleteOrderDialog.close();
      showToast("ลบออเดอร์แล้ว");
      await loadState();
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
}

init().catch(error => {
  els.content.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
});
