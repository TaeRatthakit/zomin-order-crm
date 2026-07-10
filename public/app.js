const mainNavItems = [
  ["dashboard", "/dashboard", "หน้าหลัก", "home"],
  ["reports", "/reports", "รายงาน", "chart"],
  ["orders", "/orders", "ออเดอร์", "clipboard"],
  ["opportunities", "/opportunities", "โอกาสทำเงิน", "spark"],
  ["settings", "/settings", "จัดการธุรกิจ", "briefcase"]
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
  "/settings/store": "settingsStore",
  "/settings/finance": "settingsFinance",
  "/settings/customers": "settingsCustomers",
  "/settings/line": "settingsLineHub",
  "/settings/users": "settingsUsers",
  "/settings/import-export": "settingsImportExport",
  "/settings/subscription": "settingsSubscription",
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
const MOBILE_PROFILE_CACHE_KEY = "growup_mobile_profile_v1";

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
  mobileAnalyticsIndex: null,
  desktopAnalyticsIndex: null,
  currentUser: null,
  data: null,
  lineDebugRows: [],
  lineDebugSummary: {},
  reportMonth: "",
  reportDate: "",
  layoutMode: "",
  ordersShowAll: false,
  customersShowAll: false,
  ordersFilterQ: "",
  ordersFilterDraft: "",
  mobileOrdersDateOnly: true,
  mobileOrdersDescending: true,
  mobileOrderMenuId: "",
  mobileOrdersScrollTop: 0,
  mobileOpportunityFilter: "",
  mobileOpportunitySearchDraft: "",
  mobileOpportunitySearch: "",
  mobileOpportunitySort: "urgency",
  orderSavePending: false,
  filters: {
    q: "",
    tag: "",
    status: "",
    vip: ""
  },
  productsFilterQ: "",
  productsFilterStatus: "",
  editingOrderId: "",
  editingProductId: "",
  productSavePending: false,
  productDraftImage: "",
  productOriginalImage: "",
  productImageDebugKeys: new Set(),
  productPackageDraft: [],
  productExpandedPackageId: "",
  deletingOrderId: "",
  deletingCustomerId: "",
  editingUserId: "",
  deletingUserId: "",
  teamSavePending: false,
  profileDraftImage: "",
  profileSaving: false,
  settingsSavePending: false,
  mobileBusinessPage: "main",
  securityDetailKey: "",
  mobileBusinessCustomerId: "",
  mobileBusinessProductId: "",
  mobileBusinessProductReturnPage: "products",
  editingAdCostId: "",
  editingAdPlatformId: "",
  marketingDate: "",
  marketingMonth: "",
  businessManagementScrollRestore: null,
  businessManagementScrollRestoreToken: 0,
  mobileNavigationSequence: 0,
  stateRequestSequence: 0,
  stateRefreshInFlight: false,
  lastStateLoadedAt: 0,
  currentUserRefreshInFlight: false
};

function readCachedMobileProfile() {
  return null;
}

function cacheMobileProfile(user) {
  try {
    localStorage.removeItem(MOBILE_PROFILE_CACHE_KEY);
  } catch {
    // The server remains authoritative if browser storage is unavailable or full.
  }
}

function mergeCachedMobileProfile(user) {
  return user;
}

const adminViews = new Set([
  "settingsStore", "settingsFinance", "settingsCustomers", "settingsLineHub",
  "settingsUsers", "settingsImportExport", "settingsSubscription",
  "settingsFollowup", "settingsVip", "settingsLine", "lineDebug", "team"
]);

function isAdmin() {
  return ["Owner", "Admin"].includes(app.currentUser?.role);
}

function isOwner() {
  return app.currentUser?.role === "Owner";
}

function canManageUser(targetUser = null, nextRole = "") {
  if (isOwner()) return true;
  if (!isAdmin()) return false;
  if (targetUser?.role === "Owner") return false;
  if (nextRole === "Owner") return false;
  return true;
}

function activeOwnerCount() {
  return (app.data?.users || []).filter(user => user.role === "Owner" && user.active !== false).length;
}

function isLastActiveOwner(user) {
  return user?.role === "Owner" && user.active !== false && activeOwnerCount() <= 1;
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

function setBusinessManagementHistoryScrollRestoration(value) {
  if ("scrollRestoration" in history) history.scrollRestoration = value;
}

function clearBusinessManagementScrollRestore(options = {}) {
  app.businessManagementScrollRestore = null;
  app.businessManagementScrollRestoreToken += 1;
  if (options.deferHistoryScrollRestoration) {
    window.setTimeout(() => {
      if (!app.businessManagementScrollRestore) setBusinessManagementHistoryScrollRestoration("auto");
    }, 800);
  } else {
    setBusinessManagementHistoryScrollRestoration("auto");
  }
}

function saveBusinessManagementScrollPosition() {
  if (app.view !== "settings" || app.mobileBusinessPage !== "main") return;
  setBusinessManagementHistoryScrollRestoration("manual");
  app.businessManagementScrollRestore = {
    top: Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0))
  };
}

function restoreBusinessManagementScrollWhenReady() {
  const restore = app.businessManagementScrollRestore;
  if (!restore || app.view !== "settings" || app.mobileBusinessPage !== "main") return;
  const token = ++app.businessManagementScrollRestoreToken;
  const targetTop = Math.max(0, Number(restore.top || 0));
  let attempts = 0;
  let lastScrollHeight = 0;
  let stableFrames = 0;

  const step = () => {
    if (token !== app.businessManagementScrollRestoreToken || app.view !== "settings" || app.mobileBusinessPage !== "main") return;
    const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const maxScrollTop = Math.max(0, scrollHeight - window.innerHeight);
    stableFrames = scrollHeight === lastScrollHeight ? stableFrames + 1 : 0;
    lastScrollHeight = scrollHeight;
    attempts += 1;

    if (maxScrollTop < targetTop && stableFrames < 2 && attempts < 12) {
      requestAnimationFrame(step);
      return;
    }

    const previousBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, Math.min(targetTop, maxScrollTop));
    document.documentElement.style.scrollBehavior = previousBehavior;
    clearBusinessManagementScrollRestore({ deferHistoryScrollRestoration: true });
  };

  requestAnimationFrame(step);
}

function pushBusinessManagementHistory(page, replace = false) {
  if (app.view !== "settings") return;
  const state = {
    ...(history.state || {}),
    businessManagementPage: page
  };
  if (page === "main") delete state.businessManagementPage;
  history[replace ? "replaceState" : "pushState"](state, "", viewToRoute.settings || "/settings");
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
    briefcase: '<path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7"/><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M3 12h18"/><path d="M10 12v2"/><path d="M14 12v2"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
    wallet: '<path d="M4 7.5h13.5A2.5 2.5 0 0 1 20 10v8a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h11v3.5"/><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"/>',
    chat: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 11h.01"/><path d="M12 11h.01"/><path d="M16 11h.01"/>',
    send: '<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>',
    flag: '<path d="M4 21V5"/><path d="M4 5h11l-1.5 4L15 13H4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-5"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    arrow: '<path d="m15 18-6-6 6-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 16 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c0 .38.14.74.4 1a1.7 1.7 0 0 0 1.1.4H21a2 2 0 1 1 0 4h-.09c-.41 0-.81.15-1.1.4a1.7 1.7 0 0 0-.41 1.1Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
  };
  return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.more}</svg>`;
}

const els = {
  nav: document.querySelector("#mainNav"),
  sidebarFooter: document.querySelector("#sidebarFooter"),
  pageTitle: document.querySelector("#pageTitle"),
  pageSubtitle: document.querySelector("#pageSubtitle"),
  subpageNav: document.querySelector("#subpageNav"),
  content: document.querySelector("#content"),
  workDate: document.querySelector("#workDate"),
  workDateDisplay: document.querySelector("#workDateDisplay"),
  toast: document.querySelector("#toast"),
  headerProfile: document.querySelector("#headerProfile"),
  headerNotificationButton: document.querySelector("#headerNotificationButton"),
  headerNotificationBadge: document.querySelector("#headerNotificationBadge"),
  orderDialog: document.querySelector("#orderDialog"),
  orderForm: document.querySelector("#orderForm"),
  orderDialogTitle: document.querySelector("#orderDialogTitle"),
  orderSubmitButton: document.querySelector("#orderSubmitButton"),
  deleteOrderDialog: document.querySelector("#deleteOrderDialog"),
  deleteOrderForm: document.querySelector("#deleteOrderForm"),
  mobileDeleteOrderNumber: document.querySelector("#mobileDeleteOrderNumber"),
  deleteCustomerDialog: document.querySelector("#deleteCustomerDialog"),
  deleteCustomerForm: document.querySelector("#deleteCustomerForm"),
  deleteUserDialog: document.querySelector("#deleteUserDialog"),
  deleteUserForm: document.querySelector("#deleteUserForm"),
  deleteUserName: document.querySelector("#deleteUserName"),
  logoutDialog: document.querySelector("#logoutDialog"),
  logoutForm: document.querySelector("#logoutForm"),
  profileDialog: document.querySelector("#profileDialog"),
  profileForm: document.querySelector("#profileForm"),
  profileAvatarPreview: document.querySelector("#profileAvatarPreview"),
  customerDialog: document.querySelector("#customerDialog"),
  customerDetail: document.querySelector("#customerDetail"),
  dialogCustomerName: document.querySelector("#dialogCustomerName"),
  productDialog: document.querySelector("#productDialog"),
  productForm: document.querySelector("#productForm"),
  productDialogTitle: document.querySelector("#productDialogTitle"),
  productImagePreview: document.querySelector("#productImagePreview"),
  productSubmitButton: document.querySelector("#productSubmitButton"),
  productImageFileInput: document.querySelector("#productImageFileInput"),
  productDetailDialog: document.querySelector("#productDetailDialog"),
  productDetailTitle: document.querySelector("#productDetailTitle"),
  productDetail: document.querySelector("#productDetail")
};

async function restoreSession() {
  try {
    const res = await fetch("/api/session", {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    });
    const payload = await res.json();
    app.currentUser = payload.user?.id ? payload.user : null;
    cacheMobileProfile(app.currentUser);
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

function productCostMoney(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function normalizeProductImageSource(image) {
  let source = String(image || "").trim();
  if (!source) return "";
  if (source.startsWith('"') && source.endsWith('"')) {
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed === "string") source = parsed.trim();
    } catch {
      // Keep the original value if it is not a JSON-encoded string.
    }
  }
  if (/^data:image\/[^;,]+;base64,/i.test(source)) {
    const commaIndex = source.indexOf(",");
    return `${source.slice(0, commaIndex + 1)}${source.slice(commaIndex + 1).replace(/\s+/g, "")}`;
  }
  const compact = source.replace(/\s+/g, "");
  if (/^[a-z0-9+/]+={0,2}$/i.test(compact) && compact.length >= 32) {
    const mimeType = compact.startsWith("iVBOR") ? "image/png"
      : compact.startsWith("/9j/") ? "image/jpeg"
        : compact.startsWith("R0lGOD") ? "image/gif"
          : compact.startsWith("UklGR") ? "image/webp"
            : "image/jpeg";
    return `data:${mimeType};base64,${compact}`;
  }
  return source;
}

function productImageSourceType(value) {
  if (value === null) return "null";
  if (typeof value !== "string") return typeof value;
  const source = value.trim();
  if (!source) return "empty-string";
  if (/^data:image\/[^;,]+;base64,/i.test(source)) return "data-image-base64";
  if (/^https?:\/\//i.test(source)) return "http-url";
  if (/^[a-z0-9+/=\s]+$/i.test(source) && source.length >= 32) return "raw-base64";
  return "other-string";
}

function logProductImageDebug(productId, productName, imageValue, finalSource) {
  if (!isMobileViewport() || !productId) return;
  const debugKey = `${productId}|${productImageSourceType(imageValue)}|${productImageSourceType(finalSource)}|${String(imageValue || "").length}`;
  if (app.productImageDebugKeys.has(debugKey)) return;
  app.productImageDebugKeys.add(debugKey);
  console.debug("[product-image-debug]", {
    productId,
    name: productName,
    imageFieldName: "image",
    imageValueType: productImageSourceType(imageValue),
    imageValueLength: String(imageValue || "").length,
    finalImgSrcType: productImageSourceType(finalSource)
  });
}

function productImageMarkup(image, productName = "", fallback = "", productId = "") {
  const source = normalizeProductImageSource(image);
  logProductImageDebug(productId, productName, image, source);
  if (!source) return fallback;
  return `<img src="${escapeHtml(source)}" alt="${escapeHtml(productName)}">`;
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

function formatDatePill(dateValue) {
  if (!dateValue) return "-";
  const [y, m, d] = String(dateValue).split("-").map(Number);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String(y).padStart(4, "0")}`;
}

function formatMobileDatePill(dateValue) {
  if (!dateValue) return "-";
  const [y, m, d] = String(dateValue).split("-").map(Number);
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String(y % 100).padStart(2, "0")}`;
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
    dashboard: "แดชบอร์ด",
    opportunities: "โอกาสทำเงิน",
    orders: "ออเดอร์",
    customers: "ลูกค้า",
    products: "สินค้า",
    marketing: "การตลาด",
    reports: "รายงาน",
    aiInsights: "ข้อมูลเชิงลึกจาก AI",
    broadcast: "กระจายข้อความ",
    campaigns: "แคมเปญ",
    pricing: "แพ็กเกจ",
    notifications: "แจ้งเตือน",
    vip: "ลูกค้า VIP",
    risk: "ลูกค้าเสี่ยงหาย",
    tags: "อาการลูกค้า",
    import: "Import Orders",
    team: "จัดการทีมงาน",
    settings: "จัดการธุรกิจ",
    settingsStore: "ข้อมูลร้านค้า",
    settingsFinance: "การเงิน",
    settingsCustomers: "ลูกค้า",
    settingsLineHub: "LINE OA",
    settingsUsers: "ผู้ใช้งานและสิทธิ์",
    settingsImportExport: "นำเข้า / ส่งออก",
    settingsSubscription: "แพ็กเกจ",
    settingsFollowup: "ตั้งค่าการติดตาม",
    settingsVip: "ตั้งค่า VIP",
    settingsLine: "ตั้งค่า LINE OA",
    lineDebug: "ตรวจสอบไลน์"
  };
  return titles[view] || "หน้าหลัก";
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 820px)").matches;
}

function waitForImageElement(image) {
  if (image.complete) return Promise.resolve();
  return new Promise(resolve => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  });
}

function waitForTwoFrames() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function finishAppStartup() {
  const root = document.documentElement;
  const loader = document.querySelector("#appStartupLoader");
  if (!root.classList.contains("app-startup-pending") || !loader) return;

  const logo = loader.querySelector("img");
  if (logo) await waitForImageElement(logo);
  await waitForTwoFrames();

  root.classList.add("app-startup-revealing");
  loader.classList.add("is-exiting");
  await new Promise(resolve => window.setTimeout(resolve, 300));
  root.classList.remove("app-startup-pending", "app-startup-revealing");
  loader.remove();
}

const moreSubpages = new Set([
  "vip", "risk", "tags", "import", "reports", "team", "settings",
  "settingsStore", "settingsFinance", "settingsCustomers", "settingsLineHub", "settingsUsers", "settingsImportExport", "settingsSubscription",
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

function toastStatusFor(message, status = "") {
  const explicitStatus = String(status || "").toLowerCase();
  if (["success", "loading", "update", "error"].includes(explicitStatus)) return explicitStatus;
  const text = String(message || "").toLowerCase();
  if (/ไม่สำเร็จ|ไม่ถูกต้อง|ผิดพลาด|error|ไม่มีสิทธิ์|ไม่สามารถ|ไม่พบ|กรุณา|หมดอายุ|not found|failed/.test(text)) return "error";
  if (/กำลัง|โหลด|นำเข้า/.test(text)) return "loading";
  if (/แก้ไข|อัปเดต|update|เปิดใช้|ปิดใช้|ลบ|เก็บถาวร|rollback|คัดลอก/.test(text)) return "update";
  return "success";
}

function toastTitleFor(status) {
  return {
    success: "สำเร็จ",
    loading: "กำลังดำเนินการ",
    update: "อัปเดตแล้ว",
    error: "เกิดข้อผิดพลาด"
  }[status] || "สำเร็จ";
}

function toastIconFor(status) {
  return {
    success: "✓",
    loading: "⏳",
    update: "✎",
    error: "!"
  }[status] || "✓";
}

function hideToast() {
  if (!els.toast || els.toast.hidden) return;
  els.toast.classList.remove("is-visible");
  els.toast.classList.add("is-hiding");
  window.clearTimeout(showToast.timer);
  window.clearTimeout(showToast.hideTimer);
  showToast.hideTimer = window.setTimeout(() => {
    els.toast.hidden = true;
    els.toast.classList.remove("is-hiding");
  }, 260);
}

function showToast(message, status = "") {
  const detail = String(message || "");
  const tone = toastStatusFor(detail, status);
  els.toast.className = `toast toast-${tone}`;
  els.toast.setAttribute("role", tone === "error" ? "alert" : "status");
  els.toast.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  els.toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${toastIconFor(tone)}</span>
    <span class="toast-copy">
      <strong>${escapeHtml(toastTitleFor(tone))}</strong>
      <small>${escapeHtml(detail)}</small>
    </span>
    <button class="toast-close" type="button" aria-label="ปิดการแจ้งเตือน">×</button>
  `;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  window.clearTimeout(showToast.hideTimer);
  requestAnimationFrame(() => els.toast.classList.add("is-visible"));
  els.toast.querySelector(".toast-close")?.addEventListener("click", hideToast, { once: true });
  showToast.timer = window.setTimeout(hideToast, tone === "loading" ? 4000 : 3200);
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

function elementId(element) {
  return element?.getAttribute?.("id") || "";
}

async function loadState() {
  const selectedDate = els.workDate?.value || todayISO();
  const sequence = ++app.stateRequestSequence;
  try {
    const payload = await api(`/api/state?date=${encodeURIComponent(selectedDate)}`);
    if (sequence !== app.stateRequestSequence) return;
    app.data = payload;
    app.lastStateLoadedAt = Date.now();
    app.desktopAnalyticsIndex = null;
    app.mobileAnalyticsIndex = null;
    if (app.data.currentUser) {
      app.currentUser = app.data.currentUser;
      app.data.currentUser = app.currentUser;
      cacheMobileProfile(app.currentUser);
    }
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      clearBusinessManagementScrollRestore();
      app.mobileBusinessPage = "main";
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
  if (isImportCenterActive() && isAdmin()) {
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

function invalidateStateRequests() {
  app.stateRequestSequence += 1;
}

async function refreshSharedState({ force = false } = {}) {
  if (!app.currentUser || app.view === "login" || app.stateRefreshInFlight) return;
  if (app.profileSaving || app.orderSavePending || app.productSavePending || app.settingsSavePending || app.teamSavePending) return;
  if (!force && app.lastStateLoadedAt && Date.now() - app.lastStateLoadedAt < 5000) return;
  app.stateRefreshInFlight = true;
  try {
    await loadState();
  } catch (error) {
    if (error.status !== 401) console.warn("[state-sync]", error.message || error);
  } finally {
    app.stateRefreshInFlight = false;
  }
}

function userSyncSignature(user = {}) {
  return JSON.stringify({
    id: user.id || "",
    username: user.username || "",
    name: user.name || "",
    avatar: user.avatar || "",
    role: user.role || "",
    active: user.active !== false
  });
}

async function refreshCurrentUser() {
  if (!app.currentUser || app.view === "login" || app.currentUserRefreshInFlight || app.profileSaving || app.teamSavePending) return;
  if (document.visibilityState && document.visibilityState !== "visible") return;
  app.currentUserRefreshInFlight = true;
  try {
    const previousSignature = userSyncSignature(app.currentUser);
    const payload = await api("/api/session");
    if (!payload.user?.id) {
      clearSession();
      clearBusinessManagementScrollRestore();
      app.mobileBusinessPage = "main";
      app.view = "login";
      navigateToView("login", true);
      render();
      return;
    }
    const nextUser = payload.user;
    if (userSyncSignature(nextUser) === previousSignature) return;
    invalidateStateRequests();
    app.currentUser = nextUser;
    if (app.data) {
      app.data.currentUser = nextUser;
      app.data.users = (app.data.users || []).map(user => user.id === nextUser.id ? { ...user, ...nextUser } : user);
      if (!app.data.users.some(user => user.id === nextUser.id)) app.data.users.push(nextUser);
    }
    cacheMobileProfile(nextUser);
    if (!canAccessView(app.view)) {
      app.view = "settings";
      navigateToView("settings", true);
    }
    render();
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      clearBusinessManagementScrollRestore();
      app.mobileBusinessPage = "main";
      app.view = "login";
      navigateToView("login", true);
      render();
    } else {
      console.warn("[user-sync]", error.message || error);
    }
  } finally {
    app.currentUserRefreshInFlight = false;
  }
}

function loadStateAfterLogin() {
  loadState().catch(error => {
    if (error.status === 401) return;
    showToast(error.message || "โหลดข้อมูลไม่สำเร็จ");
    els.content.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(error.message || "กรุณาลองใหม่")}</div>`;
  });
}

function renderNav() {
  if (app.view === "login") {
    els.nav.innerHTML = "";
    if (els.sidebarFooter) {
      els.sidebarFooter.hidden = true;
      els.sidebarFooter.innerHTML = "";
    }
    return;
  }
  const activeGroupMap = {
    vip: "settings",
    risk: "notifications",
    tags: "customers",
    import: "settings",
    team: "settings",
    pricing: "pricing",
    settingsStore: "settings",
    settingsFinance: "settings",
    settingsCustomers: "settings",
    settingsLineHub: "settings",
    settingsUsers: "settings",
    settingsImportExport: "settings",
    settingsSubscription: "settings",
    settingsFollowup: "settings",
    settingsVip: "settings",
    settingsLine: "settings",
    lineDebug: "settings"
  };
  const activeGroup = activeGroupMap[app.view] || app.view;
  els.nav.innerHTML = mainNavItems
    .map(([id, path, label, icon]) => `
      <button class="nav-button ${activeGroup === id ? "active" : ""}" data-view="${id}" data-path="${path}" aria-label="${escapeHtml(label)}">
        <span class="nav-index">${iconSvg(icon)}</span>
        <span>${escapeHtml(label)}</span>
      </button>
    `)
    .join("");
}

function sidebarNotificationCount() {
  if (!app.data) return 0;
  return liveNotificationItems().reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function currentUserAvatar() {
  return String(app.currentUser?.avatar || "/mobile-home-avatar.png").trim();
}

function markAvatarLoaded(image) {
  if (!image) return;
  if (image.complete && image.naturalWidth > 0) image.classList.add("is-loaded");
  else image.addEventListener("load", () => image.classList.add("is-loaded"), { once: true });
}

function setProfileSaveState(isSaving) {
  app.profileSaving = isSaving;
  const button = document.querySelector("#profileSubmitButton");
  if (!button) return;
  const displayName = String(els.profileForm?.elements.displayName?.value || "").trim();
  const nameChanged = displayName !== String(app.currentUser?.name || "").trim();
  const imageChanged = Boolean(app.profileDraftImage);
  button.disabled = isSaving || !displayName || (!nameChanged && !imageChanged);
  button.dataset.loading = isSaving ? "true" : "false";
  button.textContent = isSaving ? "กำลังบันทึก..." : "บันทึกโปรไฟล์";
}

function syncProfileAvatarPreview() {
  if (!els.profileAvatarPreview) return;
  const avatar = escapeHtml(app.profileDraftImage || currentUserAvatar());
  const initialText = escapeHtml(initials(app.currentUser?.name || "GP"));
  els.profileAvatarPreview.innerHTML = avatar
    ? `<span class="header-profile-avatar-core">${initialText}</span><img class="profile-avatar-image" src="${avatar}" alt="${escapeHtml(app.currentUser?.name || "Growup Pilot")}" loading="eager" decoding="async" width="92" height="92"><span class="header-profile-badge">👑</span>`
    : `<span class="header-profile-avatar-core">${initialText}</span><span class="header-profile-badge">👑</span>`;
  markAvatarLoaded(els.profileAvatarPreview.querySelector("img"));
}

function openProfileDialog() {
  if (!els.profileDialog || !els.profileForm || !app.currentUser) return;
  app.profileDraftImage = "";
  els.profileForm.reset();
  if (els.profileForm.elements.displayName) {
    els.profileForm.elements.displayName.value = app.currentUser.name || "";
  }
  const input = document.querySelector("#profileImageInput");
  if (input) input.value = "";
  syncProfileAvatarPreview();
  setProfileSaveState(false);
  els.profileDialog.showModal();
}

function avatarMarkup(name, avatar, className = "header-profile-avatar", interactive = false) {
  const safeName = escapeHtml(name || "Growup Pilot");
  const safeAvatar = escapeHtml(avatar || "");
  const initialText = escapeHtml(initials(name || "GP"));
  const image = safeAvatar
    ? `<img class="profile-avatar-image" src="${safeAvatar}" alt="${safeName}" loading="${isMobileViewport() || interactive ? "eager" : "lazy"}" decoding="async" width="74" height="74"${isMobileViewport() ? ' fetchpriority="high"' : ""}>`
    : "";
  return `
    <span class="${className}${interactive ? " is-interactive" : ""}" ${interactive ? 'role="button" tabindex="0" aria-label="เปิดการตั้งค่าโปรไฟล์"' : 'aria-hidden="true"'}>
      <span class="header-profile-avatar-core">${initialText}</span>
      ${image}
      <span class="header-profile-badge">👑</span>
    </span>
  `;
}

function syncMobileHeaderProfile() {
  const name = String(app.currentUser?.name || "");
  const avatar = currentUserAvatar();
  const existing = els.headerProfile.querySelector(".header-profile-trigger");
  if (!existing) {
    els.headerProfile.innerHTML = `
      <button class="header-profile-trigger" type="button" data-open-profile aria-label="เปิดการตั้งค่าโปรไฟล์">
        ${avatarMarkup(name, avatar)}
        <div class="header-profile-copy">
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(profileRoleLabel(app.currentUser.role))}</span>
        </div>
      </button>
    `;
  } else {
    const image = existing.querySelector(".profile-avatar-image");
    if (image && image.getAttribute("src") !== avatar) {
      image.classList.remove("is-loaded");
      image.setAttribute("src", avatar);
    }
    const fallback = existing.querySelector(".header-profile-avatar-core");
    if (fallback) fallback.textContent = initials(name || "GP");
    const nameElement = existing.querySelector(".header-profile-copy strong");
    if (nameElement) nameElement.textContent = name;
    const roleElement = existing.querySelector(".header-profile-copy span");
    if (roleElement) roleElement.textContent = profileRoleLabel(app.currentUser.role);
  }
  markAvatarLoaded(els.headerProfile.querySelector(".profile-avatar-image"));
}

function updateShell() {
  document.body.classList.toggle("login-view", app.view === "login");
  document.body.classList.toggle("mobile-app-shell", isMobileViewport());
  document.body.classList.toggle("desktop-app-shell", !isMobileViewport());
  document.body.classList.toggle("mobile-home-view", isMobileViewport() && app.view === "dashboard");
  document.body.classList.toggle("mobile-orders-view", isMobileViewport() && app.view === "orders");
  document.body.classList.toggle("mobile-import-view", isMobileViewport() && isImportCenterActive());
  document.body.classList.toggle("mobile-reports-view", isMobileViewport() && app.view === "reports");
  document.body.classList.toggle("mobile-opportunities-view", isMobileViewport() && app.view === "opportunities");
  document.body.classList.toggle("desktop-dashboard-view", !isMobileViewport() && app.view === "dashboard");
  if (!els.headerProfile) return;
  if (els.workDateDisplay) {
    const dateValue = els.workDate?.value || app.data?.summary?.selectedDate || todayISO();
    els.workDateDisplay.textContent = isMobileViewport() ? formatMobileDatePill(dateValue) : formatDatePill(dateValue);
  }
  if (!app.currentUser || app.view === "login") {
    els.headerProfile.hidden = true;
    els.headerProfile.innerHTML = "";
    if (els.sidebarFooter) {
      els.sidebarFooter.hidden = true;
      els.sidebarFooter.innerHTML = "";
    }
    if (els.headerNotificationBadge) {
      els.headerNotificationBadge.hidden = true;
      els.headerNotificationBadge.textContent = "0";
    }
    return;
  }
  const notificationCount = sidebarNotificationCount();
  if (els.headerNotificationBadge) {
    els.headerNotificationBadge.hidden = notificationCount <= 0;
    els.headerNotificationBadge.textContent = String(notificationCount);
  }
  els.headerProfile.hidden = false;
  if (isMobileViewport()) syncMobileHeaderProfile();
  else {
    els.headerProfile.innerHTML = `
      <button class="header-profile-trigger" type="button" data-open-profile aria-label="เปิดการตั้งค่าโปรไฟล์">
        ${avatarMarkup(app.currentUser.name, currentUserAvatar())}
        <div class="header-profile-copy">
          <strong>${escapeHtml(app.currentUser.name)}</strong>
          <span>${escapeHtml(profileRoleLabel(app.currentUser.role))}</span>
        </div>
      </button>
    `;
    markAvatarLoaded(els.headerProfile.querySelector(".profile-avatar-image"));
  }
  if (els.sidebarFooter) {
    els.sidebarFooter.hidden = false;
    els.sidebarFooter.innerHTML = `
      <article class="sidebar-upgrade-card">
        <div class="sidebar-upgrade-head">
          <div class="sidebar-upgrade-icon" aria-hidden="true">♛</div>
          <div class="sidebar-upgrade-copy">
            <strong>อัปเกรดเป็น Pro</strong>
            <span>ปลดล็อกฟีเจอร์ขั้นสูง</span>
          </div>
        </div>
        <button class="button primary" type="button" data-view-shortcut="pricing">อัปเกรดเลย</button>
      </article>
      <article class="sidebar-profile-card">
        <div class="sidebar-profile-avatar" aria-hidden="true">${escapeHtml(initials(app.currentUser.name || "GP"))}</div>
        <div class="sidebar-profile-copy">
          <strong>${escapeHtml(app.currentUser.name)}</strong>
          <span>${escapeHtml(profileRoleLabel(app.currentUser.role))}</span>
        </div>
        <button class="sidebar-profile-action" type="button" data-logout aria-label="ออกจากระบบ">›</button>
      </article>
      <div class="sidebar-theme-switch" aria-label="ธีมมืด">
        <span aria-hidden="true">☀</span>
        <span class="theme-switch-track"><i>☾</i></span>
      </div>
    `;
  }
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

function dashboardTrendSeries(metric, length = 10) {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  return Array.from({ length }, (_, index) => {
    const date = addDaysISO(selectedDate, index - (length - 1));
    const dayOrders = app.data.orders.filter(order => order.date === date);
    const daySales = dayOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    const month = monthKey(date);
    const monthOrders = app.data.orders.filter(order => monthKey(order.date) === month && order.date <= date);
    const dueCustomers = app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= date);
    const silentCustomers = app.data.customers.filter(customer => !customer.lastPurchaseDate || !String(customer.lastPurchaseDate).startsWith(month));
    if (metric === "salesToday") return daySales;
    if (metric === "salesThisMonth") return monthOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    if (metric === "ordersToday") return dayOrders.length;
    if (metric === "ordersThisMonth") return monthOrders.length;
    if (metric === "profitToday") return profitBreakdownForOrders(dayOrders).profit;
    if (metric === "opportunityToday") return estimatedOpportunityRevenue(dueCustomers, 0.36) + estimatedOpportunityRevenue(silentCustomers, 0.18);
    return 0;
  });
}

function dashboardSparkline(series = [], tone = "violet") {
  const values = series.map(value => Number(value || 0));
  const width = 280;
  const height = 92;
  const padding = 6;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = padding + (index * (width - padding * 2)) / Math.max(values.length - 1, 1);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point}`).join(" ");
  const areaPath = `${linePath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z`;
  const toneMap = {
    violet: { stroke: "#bf5cff", glow: "rgba(191, 92, 255, 0.85)", fill: "rgba(177, 95, 255, 0.26)" },
    blue: { stroke: "#4e73ff", glow: "rgba(78, 115, 255, 0.82)", fill: "rgba(78, 115, 255, 0.24)" },
    gold: { stroke: "#ffd24a", glow: "rgba(255, 210, 74, 0.82)", fill: "rgba(255, 210, 74, 0.22)" },
    pink: { stroke: "#ff5caa", glow: "rgba(255, 92, 170, 0.82)", fill: "rgba(255, 92, 170, 0.22)" }
  };
  const palette = toneMap[tone] || toneMap.violet;
  const [lastX, lastY] = (points[points.length - 1] || `${width - padding},${height / 2}`).split(",");
  return `
    <svg class="dashboard-sparkline tone-${escapeHtml(tone)}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill-${tone}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="${palette.fill}" />
          <stop offset="100%" stop-color="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <path class="dashboard-sparkline-area" d="${areaPath}" fill="url(#spark-fill-${tone})"></path>
      <path class="dashboard-sparkline-line" d="${linePath}" stroke="${palette.stroke}" style="--spark-glow:${palette.glow};"></path>
      <circle class="dashboard-sparkline-point" cx="${lastX}" cy="${lastY}" r="4.5" fill="${palette.stroke}" style="--spark-glow:${palette.glow};"></circle>
    </svg>
  `;
}

function dashboardCardIcon(kind) {
  const icons = {
    sales: '<path d="M12 3v18"/><path d="M16.5 7.5c0-1.9-2-3.5-4.5-3.5S7.5 5.6 7.5 7.5 9.5 11 12 11s4.5 1.6 4.5 3.5-2 3.5-4.5 3.5-4.5-1.6-4.5-3.5"/>',
    wallet: '<path d="M4 7.5h13.5A2.5 2.5 0 0 1 20 10v8a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h11v3.5"/><path d="M16 12h5v4h-5a2 2 0 0 1 0-4Z"/>',
    bag: '<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
    box: '<path d="M21 8.5 12 13 3 8.5"/><path d="M3 8.5 12 3l9 5.5v7L12 21l-9-5.5z"/><path d="M12 13v8"/>',
    database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="3"/><path d="M7 3.5v4"/><path d="M17 3.5v4"/><path d="M3.5 10.5h17"/>',
    orders: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 7.5h8"/><path d="M8 12h8"/><path d="M8 16.5h5"/>',
    profit: '<path d="M4 16 9 11l3 3 8-8"/><path d="M16 6h4v4"/><path d="M4 20h16"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 4v3"/><path d="M20 12h-3"/><path d="m17.5 6.5-2 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    sort: '<path d="M8 4v16"/><path d="m4 8 4-4 4 4"/><path d="M16 20V4"/><path d="m12 16 4 4 4-4"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>'
  };
  return `<svg class="metric-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind] || icons.sales}</svg>`;
}

function dashboardKpiCard({ label, value, icon, tone = "", delta, hint, series, area }) {
  return `
    <article class="metric-card dashboard-kpi dashboard-kpi-card ${tone}" style="grid-area:${escapeHtml(area)};">
      <div class="metric-top dashboard-kpi-head">
        <div>
          <span class="dashboard-kpi-label">${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
        <div class="metric-icon dashboard-icon-shell" aria-hidden="true">${icon}</div>
      </div>
      <div class="metric-foot dashboard-kpi-foot">
        <span class="trend trend-${escapeHtml(delta.trend)}">${escapeHtml(delta.summary)}</span>
        <small>${escapeHtml(hint)}</small>
      </div>
      <div class="dashboard-kpi-chart-wrap">
        ${dashboardSparkline(series, tone)}
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
  const configuredCosts = new Map(
    normalizeProductCostEntries(app.data?.settings || {})
      .map(entry => [entry.name, entry])
  );
  for (const order of app.data.orders) {
    const name = String(order.items || "Growup Formula").trim() || "Growup Formula";
    if (!map.has(name)) {
      const costConfig = configuredCosts.get(name);
      map.set(name, {
        name,
        soldCount: 0,
        orderCount: 0,
        revenue: 0,
        costPerJar: Number(costConfig?.costPerJar || 0),
        costEnabled: Boolean(costConfig?.enabled)
      });
    }
    const item = map.get(name);
    item.soldCount += Number(order.jars || 0);
    item.orderCount += 1;
    item.revenue += Number(order.amount || 0);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

function normalizeProductName(value) {
  return String(value || "").trim();
}

function normalizeProductCostEntries(settings = {}) {
  const configured = Array.isArray(settings.productCosts) ? settings.productCosts : [];
  const fromOrders = Array.from(new Set((app.data?.orders || []).map(order => normalizeProductName(order.items || "Growup Formula")).filter(Boolean)));
  const map = new Map();
  for (const item of configured) {
    const name = normalizeProductName(item?.name);
    if (!name) continue;
    map.set(name, {
      id: String(item.id || `pc_${name.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}`),
      name,
      costPerJar: Number(item.costPerJar || 0),
      enabled: item.enabled !== false
    });
  }
  for (const name of fromOrders) {
    if (!map.has(name)) {
      map.set(name, {
        id: `pc_${name.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}`,
        name,
        costPerJar: 0,
        enabled: true
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "th"));
}

function normalizeAdditionalCostEntries(settings = {}) {
  const configured = Array.isArray(settings.additionalCosts) ? settings.additionalCosts : [];
  const allowedTypes = new Set(["fixed_per_order", "per_item", "percent_sales"]);
  return configured
    .map((item, index) => ({
      id: String(item?.id || `ac_${index + 1}`),
      name: String(item?.name || "").trim(),
      amount: Number(item?.amount || 0),
      type: allowedTypes.has(item?.type) ? item.type : "fixed_per_order",
      enabled: item?.enabled !== false
    }))
    .filter(item => item.name);
}

function productCostForOrder(order, settings = app.data?.settings || {}) {
  const productName = normalizeProductName(order?.items || "Growup Formula");
  const productConfig = normalizeProductCostEntries(settings).find(item => item.name === productName);
  if (!productConfig?.enabled) return 0;
  const quantity = order?.packageId
    ? Number(order?.totalQuantityShipped || order?.jars || 0)
    : Number(order?.jars || 0);
  return quantity * Number(productConfig.costPerJar || 0);
}

function packageExpenseTotalForOrder(order) {
  if (!order?.packageId) return 0;
  return normalizePackageExpenses(order.packageExpenses)
    .filter(expense => expense.enabled)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
}

function additionalCostTypeLabel(type) {
  return {
    fixed_per_order: "คงที่ต่อออเดอร์",
    per_item: "ต่อชิ้น",
    percent_sales: "% ของยอดขาย"
  }[type] || "คงที่ต่อออเดอร์";
}

function additionalCostMethodSummary(item = {}) {
  const amount = Number(item.amount || 0);
  if (item.type === "percent_sales") return `${marketingNumber(amount)}% ของยอดขาย`;
  if (item.type === "per_item") return `${money(amount)} บาทต่อชิ้น`;
  return `${money(amount)} บาทต่อออเดอร์`;
}

function additionalCostBreakdownForOrders(orders = [], settings = app.data?.settings || {}) {
  const rows = Array.isArray(orders) ? orders : [];
  const orderCount = rows.length;
  const itemCount = rows.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const sales = rows.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  return normalizeAdditionalCostEntries(settings)
    .filter(item => item.enabled)
    .map(item => {
      const total = item.type === "percent_sales"
        ? sales * Number(item.amount || 0) / 100
        : item.type === "per_item"
          ? itemCount * Number(item.amount || 0)
          : orderCount * Number(item.amount || 0);
      return { ...item, total };
    });
}

function additionalCostTotalForOrders(orders = [], settings = app.data?.settings || {}) {
  return additionalCostBreakdownForOrders(orders, settings)
    .reduce((sum, item) => sum + Number(item.total || 0), 0);
}

const PROFIT_SNAPSHOT_VERSION = 1;
const PROFIT_SNAPSHOT_FIELDS = [
  "revenueSnapshot",
  "productCostSnapshot",
  "packageExpenseSnapshot",
  "globalExpenseSnapshot",
  "profitBeforeAdsSnapshot"
];

function hasOrderProfitSnapshot(order = {}) {
  return Number(order.profitSnapshotVersion || 0) >= PROFIT_SNAPSHOT_VERSION
    && PROFIT_SNAPSHOT_FIELDS.every(field => Number.isFinite(Number(order[field])));
}

function fallbackProfitForOrder(order, settings) {
  const sales = Number(order?.amount || 0);
  const productCosts = productCostForOrder(order, settings);
  const packageExpenses = packageExpenseTotalForOrder(order);
  const globalAdditionalCosts = additionalCostTotalForOrders([order], settings);
  const profitBeforeAds = sales - productCosts - packageExpenses - globalAdditionalCosts;
  return {
    sales,
    productCosts,
    packageExpenses,
    globalAdditionalCosts,
    profitBeforeAds,
    profitAfterAds: profitBeforeAds,
    source: "fallback"
  };
}

function profitForOrder(order, settings = app.data?.settings || {}) {
  if (!hasOrderProfitSnapshot(order)) return fallbackProfitForOrder(order, settings);
  const profitBeforeAds = Number(order.profitBeforeAdsSnapshot);
  const profitAfterAds = Number.isFinite(Number(order.profitAfterAdsSnapshot))
    ? Number(order.profitAfterAdsSnapshot)
    : profitBeforeAds;
  return {
    sales: Number(order.revenueSnapshot),
    productCosts: Number(order.productCostSnapshot),
    packageExpenses: Number(order.packageExpenseSnapshot),
    globalAdditionalCosts: Number(order.globalExpenseSnapshot),
    profitBeforeAds,
    profitAfterAds,
    source: String(order.profitSnapshotSource || "snapshot")
  };
}

function profitBreakdownForOrders(orders = [], settings = app.data?.settings || {}) {
  const rows = Array.isArray(orders) ? orders : [];
  const values = rows.map(order => profitForOrder(order, settings));
  const sales = values.reduce((sum, item) => sum + item.sales, 0);
  const productCosts = values.reduce((sum, item) => sum + item.productCosts, 0);
  const globalAdditionalCosts = values.reduce((sum, item) => sum + item.globalAdditionalCosts, 0);
  const packageExpenses = values.reduce((sum, item) => sum + item.packageExpenses, 0);
  const profitBeforeAds = values.reduce((sum, item) => sum + item.profitBeforeAds, 0);
  const profitAfterAds = values.reduce((sum, item) => sum + item.profitAfterAds, 0);
  const additionalCosts = globalAdditionalCosts + packageExpenses;
  return {
    sales,
    productCosts,
    packageExpenses,
    globalAdditionalCosts,
    additionalCosts,
    profitBeforeAds,
    profitAfterAds,
    profit: profitAfterAds,
    snapshotOrderCount: values.filter(item => item.source !== "fallback").length,
    fallbackOrderCount: values.filter(item => item.source === "fallback").length
  };
}

const DEFAULT_AD_PLATFORMS = [
  ["facebook_ads", "Facebook Ads"],
  ["tiktok_ads", "TikTok Ads"],
  ["google_ads", "Google Ads"],
  ["line_oa", "LINE OA"],
  ["shopee_ads", "Shopee Ads"],
  ["lazada_ads", "Lazada Ads"],
  ["other", "Other"]
].map(([id, name]) => ({ id, name, enabled: true }));

function normalizeAdPlatforms(settings = app.data?.settings || {}) {
  const configured = Array.isArray(settings.adPlatforms) ? settings.adPlatforms : DEFAULT_AD_PLATFORMS;
  return configured.map((platform, index) => ({
    id: String(platform?.id || `ad_platform_${index + 1}`),
    name: String(platform?.name || "").trim(),
    enabled: platform?.enabled !== false
  })).filter(platform => platform.name);
}

function normalizeAdCostRecords(settings = app.data?.settings || {}) {
  const allowedModes = new Set(["fixed_amount", "percent_sales", "cost_per_order"]);
  return (Array.isArray(settings.adCostRecords) ? settings.adCostRecords : [])
    .map((record, index) => ({
      id: String(record?.id || `ad_cost_${index + 1}`),
      date: String(record?.date || ""),
      productId: String(record?.productId || ""),
      productName: String(record?.productName || "").trim(),
      platformId: String(record?.platformId || ""),
      platformName: String(record?.platformName || "").trim(),
      campaignName: String(record?.campaignName || "").trim(),
      costMode: allowedModes.has(record?.costMode) ? record.costMode : "fixed_amount",
      value: Math.max(0, Number(record?.value || 0)),
      enabled: record?.enabled !== false,
      note: String(record?.note || "").trim()
    }))
    .filter(record => record.date && record.productName && record.platformName);
}

function orderMatchesAdRecord(order, record) {
  if (String(order?.date || "") !== record.date) return false;
  if (record.productId && order?.productId) return String(order.productId) === record.productId;
  return normalizeProductName(order?.items).toLocaleLowerCase("th-TH")
    === record.productName.toLocaleLowerCase("th-TH");
}

function adCostForRecord(record, orders = app.data?.orders || []) {
  if (!record?.enabled) return 0;
  const matches = orders.filter(order => orderMatchesAdRecord(order, record));
  if (record.costMode === "percent_sales") {
    return matches.reduce((sum, order) => sum + profitForOrder(order).sales, 0) * record.value / 100;
  }
  if (record.costMode === "cost_per_order") return matches.length * record.value;
  return record.value;
}

function marketingPerformanceForPeriod({ date = "", month = "" } = {}) {
  const allOrders = app.data?.orders || [];
  const periodOrders = allOrders.filter(order => date ? order.date === date : month ? monthKey(order.date) === month : true);
  const records = normalizeAdCostRecords()
    .filter(record => record.enabled && (date ? record.date === date : month ? monthKey(record.date) === month : true))
    .map(record => ({ ...record, cost: adCostForRecord(record, allOrders) }));
  const breakdown = profitBreakdownForOrders(periodOrders);
  const adCost = records.reduce((sum, record) => sum + record.cost, 0);
  const productMap = new Map();
  const productKey = (id, name) => id || `name:${normalizeProductName(name).toLocaleLowerCase("th-TH")}`;
  periodOrders.forEach(order => {
    const key = productKey(order.productId, order.items);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: String(order.productId || ""),
        productName: normalizeProductName(order.items) || "ไม่ระบุสินค้า",
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    const row = productMap.get(key);
    const profit = profitForOrder(order);
    row.sales += profit.sales;
    row.orderCount += 1;
    row.profitBeforeAds += profit.profitBeforeAds;
  });
  records.forEach(record => {
    const key = productKey(record.productId, record.productName);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: record.productId,
        productName: record.productName,
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    productMap.get(key).adCost += record.cost;
  });

  const platformMap = new Map();
  records.forEach(record => {
    const key = record.platformId || `name:${record.platformName.toLocaleLowerCase("th-TH")}`;
    if (!platformMap.has(key)) {
      platformMap.set(key, {
        platformId: record.platformId,
        platformName: record.platformName,
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    platformMap.get(key).adCost += record.cost;
  });
  const allocationGroups = new Map();
  records.forEach(record => {
    const key = `${record.date}|${productKey(record.productId, record.productName)}`;
    if (!allocationGroups.has(key)) allocationGroups.set(key, []);
    allocationGroups.get(key).push(record);
  });
  allocationGroups.forEach(group => {
    const matchingOrders = periodOrders.filter(order => orderMatchesAdRecord(order, group[0]));
    const sales = matchingOrders.reduce((sum, order) => sum + profitForOrder(order).sales, 0);
    const profit = matchingOrders.reduce((sum, order) => sum + profitForOrder(order).profitBeforeAds, 0);
    const groupCost = group.reduce((sum, record) => sum + record.cost, 0);
    group.forEach(record => {
      const key = record.platformId || `name:${record.platformName.toLocaleLowerCase("th-TH")}`;
      const row = platformMap.get(key);
      const share = groupCost > 0 ? record.cost / groupCost : 1 / group.length;
      row.sales += sales * share;
      row.orderCount += matchingOrders.length * share;
      row.profitBeforeAds += profit * share;
    });
  });
  const finishRow = row => ({
    ...row,
    profitAfterAds: row.profitBeforeAds - row.adCost,
    roas: row.adCost ? row.sales / row.adCost : 0,
    adCostPercent: row.sales ? row.adCost / row.sales * 100 : 0,
    costPerOrder: row.orderCount ? row.adCost / row.orderCount : 0
  });
  return {
    sales: breakdown.sales,
    orderCount: periodOrders.length,
    profitBeforeAds: breakdown.profitBeforeAds,
    adCost,
    profitAfterAds: breakdown.profitBeforeAds - adCost,
    roas: adCost ? breakdown.sales / adCost : 0,
    adCostPercent: breakdown.sales ? adCost / breakdown.sales * 100 : 0,
    costPerOrder: periodOrders.length ? adCost / periodOrders.length : 0,
    productPerformance: [...productMap.values()].map(finishRow).sort((a, b) => b.sales - a.sales),
    platformPerformance: [...platformMap.values()].map(finishRow).sort((a, b) => b.adCost - a.adCost),
    calculatedRecords: records
  };
}

function marketingNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function adCostModeLabel(mode) {
  return {
    fixed_amount: "จำนวนเงินคงที่",
    percent_sales: "% ของยอดขาย",
    cost_per_order: "ค่าใช้จ่ายต่อออเดอร์"
  }[mode] || "จำนวนเงินคงที่";
}

function normalizePackageExpenses(expenses = []) {
  return (Array.isArray(expenses) ? expenses : [])
    .map((expense, index) => ({
      id: String(expense?.id || `expense_${index + 1}`),
      name: String(expense?.name || "").trim(),
      amount: Math.max(0, Number(expense?.amount || 0)),
      enabled: expense?.enabled !== false
    }))
    .filter(expense => expense.name);
}

function normalizeSalesPackages(packages = []) {
  return (Array.isArray(packages) ? packages : []).map((item, index) => {
    const paidQuantity = Math.max(0, Number(item?.paidQuantity || 0));
    const freeQuantity = Math.max(0, Number(item?.freeQuantity || 0));
    return {
      id: String(item?.id || `package_${index + 1}`),
      name: String(item?.name || `แพ็กเกจ ${index + 1}`).trim() || `แพ็กเกจ ${index + 1}`,
      paidQuantity,
      freeQuantity,
      totalQuantityShipped: Math.max(0, Number(item?.totalQuantityShipped ?? paidQuantity + freeQuantity)),
      salePrice: Math.max(0, Number(item?.salePrice || 0)),
      enabled: item?.enabled !== false,
      expenses: normalizePackageExpenses(item?.expenses)
    };
  });
}

function normalizeProductRecords(settings = app.data?.settings || {}) {
  const stored = Array.isArray(settings.products) ? settings.products : [];
  const normalized = stored.map((product, index) => ({
    id: String(product?.id || `product_${index + 1}`),
    image: normalizeProductImageSource(product?.image),
    name: String(product?.name || "").trim(),
    sku: String(product?.sku || "").trim(),
    description: String(product?.description || "").trim(),
    salePrice: Number(product?.salePrice || 0),
    costPerItem: Number(product?.costPerItem || 0),
    stockQuantity: Number(product?.stockQuantity || 0),
    lowStockAlert: Number(product?.lowStockAlert || 0),
    status: String(product?.status || "พร้อมขาย").trim() || "พร้อมขาย",
    followUpEnabled: product?.followUpEnabled !== false,
    followUpDays: Math.max(1, Number(product?.followUpDays || 15)),
    followUpRule: String(product?.followUpRule || "1 ชิ้น = 15 วัน").trim() || "1 ชิ้น = 15 วัน",
    archived: Boolean(product?.archived),
    createdAt: String(product?.createdAt || "").trim(),
    updatedAt: String(product?.updatedAt || "").trim(),
    salesPackages: normalizeSalesPackages(product?.salesPackages)
  })).filter(product => product.name);
  const unique = new Map();
  for (const product of normalized) {
    const key = `${String(product.sku || "").trim().toLowerCase()}|${String(product.name || "").trim().toLowerCase()}`;
    const existing = unique.get(key);
    if (!existing || (existing.archived && !product.archived)) unique.set(key, product);
  }
  return [...unique.values()];
}

function productStatsMap() {
  const map = new Map();
  for (const order of app.data.orders) {
    const key = normalizeProductName(order.items || "Growup Formula");
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        revenue: 0,
        soldCount: 0,
        orderCount: 0,
        lastOrderDate: "",
        followUpCustomers: 0
      });
    }
    const item = map.get(key);
    item.revenue += Number(order.amount || 0);
    item.soldCount += Number(order.jars || 0);
    item.orderCount += 1;
    item.lastOrderDate = String(order.date || "") > item.lastOrderDate ? String(order.date || "") : item.lastOrderDate;
  }
  for (const customer of app.data.customers) {
    for (const order of customer.orders || []) {
      const key = normalizeProductName(order.items || "Growup Formula");
      if (!key || !map.has(key)) continue;
      if (customer.followUpDate) map.get(key).followUpCustomers += 1;
    }
  }
  return map;
}

function productStatus(product, stats) {
  if (product.archived) return "เก็บถาวร";
  if (product.status && !["พร้อมขาย", "ใกล้หมด", "เหลือน้อย", "ปิดการขาย"].includes(product.status)) return product.status;
  if (product.stockQuantity <= 0) return "ปิดการขาย";
  if (product.stockQuantity <= Number(product.lowStockAlert || 0)) return "ใกล้หมด";
  if (product.stockQuantity <= Math.max(Number(product.lowStockAlert || 0) * 2, 10)) return "เหลือน้อย";
  return product.status || "พร้อมขาย";
}

function productRowsData() {
  const statsByName = productStatsMap();
  const stored = normalizeProductRecords();
  const merged = [];
  const seen = new Set();
  for (const product of stored) {
    const stats = statsByName.get(product.name) || { revenue: 0, soldCount: 0, orderCount: 0, lastOrderDate: "", followUpCustomers: 0 };
    merged.push({
      ...product,
      revenue: stats.revenue,
      soldCount: stats.soldCount,
      orderCount: stats.orderCount,
      followUpCustomers: stats.followUpCustomers,
      computedStatus: productStatus(product, stats)
    });
    seen.add(product.name);
  }
  for (const [name, stats] of statsByName.entries()) {
    if (seen.has(name)) continue;
    merged.push({
      id: `derived_${name.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}`,
      image: "",
      name,
      sku: "",
      description: "",
      salePrice: stats.soldCount ? Math.round(stats.revenue / Math.max(stats.soldCount, 1)) : 0,
      costPerItem: 0,
      stockQuantity: 0,
      lowStockAlert: 0,
      status: "พร้อมขาย",
      followUpEnabled: true,
      followUpDays: 15,
      followUpRule: "1 ชิ้น = 15 วัน",
      archived: false,
      revenue: stats.revenue,
      soldCount: stats.soldCount,
      orderCount: stats.orderCount,
      followUpCustomers: stats.followUpCustomers,
      computedStatus: "พร้อมขาย",
      derived: true
    });
  }
  const q = app.productsFilterQ.trim().toLowerCase();
  return merged
    .filter(product => !product.archived)
    .filter(product => !q || [product.name, product.sku, product.description].join(" ").toLowerCase().includes(q))
    .filter(product => !app.productsFilterStatus || product.computedStatus === app.productsFilterStatus)
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, "th"));
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

function liveNotificationItems() {
  return notificationItems().filter(item => Number(item.count || 0) > 0);
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
        <header class="login-page-header" aria-label="Growup Pilot">
          <img class="login-page-logo" src="/icons/login-logo-192.png?v=20260708-login-logo-fast-v1" alt="" aria-hidden="true" width="84" height="84" fetchpriority="high" loading="eager" decoding="async">
          <strong>Growup<span>Pilot</span></strong>
          <p>ระบบจัดการธุรกิจของคุณ ให้เติบโตไปด้วยกัน</p>
        </header>
        <form class="login-card" id="loginForm">
          <div class="login-card-heading">
            <h1>ยินดีต้อนรับ<span>กลับมา</span></h1>
            <p>เข้าสู่ระบบเพื่อไปต่อกับ Growup Pilot</p>
          </div>
          <label>ชื่อผู้ใช้งาน
            <input name="username" autocomplete="username" required placeholder="กรอกชื่อผู้ใช้งาน">
          </label>
          <label>รหัสผ่าน
            <input name="password" autocomplete="current-password" type="password" required placeholder="กรอกรหัสผ่าน">
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
      <td data-label="สินค้า">${escapeHtml(order.items || "-")}</td>
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
  if (!orders.length) {
    return `
      <div class="empty-state orders-empty-state">
        <span class="orders-empty-icon" aria-hidden="true">${iconSvg("clipboard")}</span>
        <strong>ไม่พบออเดอร์ในมุมมองนี้</strong>
        <p>ลองเปลี่ยนวันที่ ค้นหาด้วยคำอื่น หรือเปิดแสดงออเดอร์ทั้งหมด</p>
        <button class="button primary" type="button" data-open-order>+ เพิ่มออเดอร์</button>
      </div>
    `;
  }
  const sorted = sortOrdersAscending(orders);
  return `
    <div class="workspace-table-wrap mobile-stack-wrap" id="orderList">
      <table class="workspace-table mobile-stack-table">
        <thead>
          <tr>
            <th>ออเดอร์</th>
            <th>สินค้า</th>
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

function dashboardChangeText(currentValue, previousValue, unit = "") {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);
  if (previous <= 0) {
    if (current <= 0) return "0.0%";
    return "+100.0%";
  }
  const percent = ((current - previous) / previous) * 100;
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(1)}%${unit}`;
}

function dashboardChannelRows(selectedDate) {
  const colors = ["#8b3dff", "#ffb11f", "#23c7ff", "#49e58f"];
  const todaysOrders = app.data.orders.filter(order => order.date === selectedDate);
  const map = new Map();
  for (const order of todaysOrders) {
    const channel = summarizeSalesChannel(displayOrderChannel(order));
    if (!map.has(channel)) map.set(channel, { name: channel, revenue: 0 });
    map.get(channel).revenue += Number(order.amount || 0);
  }
  const rows = [...map.values()].sort((a, b) => b.revenue - a.revenue);
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return rows.slice(0, 4).map((row, index) => ({
    ...row,
    color: colors[index % colors.length],
    percent: total ? (row.revenue / total) * 100 : 0
  }));
}

function mobileDashboardAlertItems() {
  const colors = ["purple", "amber", "cyan"];
  const icons = ["bell", "profit", "clipboard"];
  const thaiOnly = value => String(value || "")
    .replace(/Broadcast/gi, "ส่งข้อความ")
    .replace(/stock/gi, "สต๊อก")
    .replace(/VIP/gi, "ลูกค้าคนสำคัญ");
  const items = liveNotificationItems()
    .slice(0, 3)
    .map((item, index) => ({
      ...item,
      title: thaiOnly(item.title),
      detail: thaiOnly(item.detail),
      tone: colors[index % colors.length],
      icon: icons[index % icons.length],
      time: liveNotificationTimestamp(item)
    }));
  return items;
}

function liveNotificationTimestamp(item) {
  const selectedDate = app.data?.summary?.selectedDate || todayISO();
  if (item.type === "follow-up customers" || item.type === "VIP reminders") return `อัปเดต ${formatDatePill(selectedDate)}`;
  return "อัปเดตล่าสุด";
}

function mobileDashboardMetricCard({ label, value, deltaText, tone, icon }) {
  return `
    <article class="mobile-kpi-card mobile-kpi-${tone}">
      <div class="mobile-kpi-icon" aria-hidden="true">${dashboardCardIcon(icon)}</div>
      <span class="mobile-kpi-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <span class="mobile-kpi-delta">${escapeHtml(deltaText)}</span>
    </article>
  `;
}

function mobileDashboardSummaryCard(rows, totalSales) {
  const hasRows = rows.length > 0;
  const fallbackRows = [
    { name: "หน้าร้าน", revenue: 0, percent: hasRows ? 0 : 49.7, color: "#6f2cff" },
    { name: "ออนไลน์", revenue: 0, percent: hasRows ? 0 : 32.8, color: "#ff9f0a" },
    { name: "อื่นๆ", revenue: 0, percent: hasRows ? 0 : 17.5, color: "#159bd3" }
  ];
  const displayRows = rows.slice(0, 3);
  for (const fallback of fallbackRows) {
    if (displayRows.length >= 3) break;
    if (!displayRows.some(row => row.name === fallback.name)) displayRows.push(fallback);
  }
  const gradient = displayRows.length
    ? displayRows.map((row, index) => {
      const start = displayRows.slice(0, index).reduce((sum, item) => sum + item.percent, 0);
      return `${row.color} ${start}% ${start + row.percent}%`;
    }).join(", ")
    : "#8b3dff 0% 100%";
  return `
    <article class="mobile-summary-card">
      <div class="mobile-summary-head">
        <h3>ภาพรวมธุรกิจวันนี้</h3>
        <span aria-hidden="true">›</span>
      </div>
      <div class="mobile-summary-body">
        <div class="mobile-summary-donut" style="--donut-gradient:${gradient};">
          <div>
            <span>ยอดขายรวม</span>
            <strong>${money(totalSales)}</strong>
            <small>บาท</small>
          </div>
        </div>
        <div class="mobile-summary-legend">
          ${displayRows.map(row => `
            <div class="mobile-summary-row">
              <span class="mobile-summary-name"><i style="background:${row.color}"></i>${escapeHtml(row.name)}</span>
              <strong>${money(row.revenue)} บาท</strong>
              <span>${row.percent.toFixed(1)}%</span>
            </div>
          `).join("")}
        </div>
      </div>
    </article>
  `;
}

function mobileDashboardAlertsCard(items) {
  return `
    <article class="mobile-alerts-card">
      <div class="mobile-summary-head">
        <h3>แจ้งเตือนสำคัญ</h3>
        <button class="mobile-link-button" type="button" data-view-shortcut="notifications">ดูทั้งหมด <span aria-hidden="true">›</span></button>
      </div>
      <div class="mobile-alerts-list">
        ${items.map(item => `
          <button class="mobile-alert-item" type="button" data-view-shortcut="notifications">
            <span class="mobile-alert-icon ${item.tone}" aria-hidden="true">${dashboardCardIcon(item.icon)}</span>
            <span class="mobile-alert-copy">
              <strong>${escapeHtml(item.title)} ${money(item.count)} รายการ</strong>
              <small>${escapeHtml(item.detail)}</small>
            </span>
            <span class="mobile-alert-meta">
              <small>${escapeHtml(item.time)}</small>
              <i class="mobile-alert-dot ${item.tone}"></i>
            </span>
          </button>
        `).join("") || `<div class="empty-state">ยังไม่มีแจ้งเตือนสำหรับวันนี้</div>`}
      </div>
    </article>
  `;
}

function renderMobileDashboard(viewModel) {
  const { s, compactDate, salesDelta, ordersDelta, profitDelta, opportunityDelta, estimatedProfitToday, opportunityCount, channelRows, alerts } = viewModel;
  els.content.innerHTML = `
    <section class="section saas-page mobile-dashboard-page">
      <div class="mobile-dashboard-shell">
        <section class="mobile-hero-card">
          <img
            class="mobile-hero-image"
            src="/mobile-home-hero.png?v=20260703-mobile-hero-clean"
            alt="จัดการธุรกิจให้เติบโต ไปกับ Growup Pilot"
            loading="eager"
            fetchpriority="high"
            decoding="sync"
          >
        </section>

        <section class="mobile-kpi-grid">
          ${mobileDashboardMetricCard({ label: "ยอดขายวันนี้", value: money(s.salesToday), deltaText: dashboardChangeText(s.salesToday, s.salesToday - salesDelta.diff), tone: "green", icon: "wallet" })}
          ${mobileDashboardMetricCard({ label: "ออเดอร์วันนี้", value: money(s.ordersToday || 0), deltaText: dashboardChangeText(s.ordersToday || 0, (s.ordersToday || 0) - ordersDelta.diff), tone: "amber", icon: "bag" })}
          ${mobileDashboardMetricCard({ label: "กำไรวันนี้", value: money(estimatedProfitToday), deltaText: dashboardChangeText(estimatedProfitToday, estimatedProfitToday - profitDelta.diff), tone: "violet", icon: "database" })}
          ${mobileDashboardMetricCard({ label: "โอกาสทำเงิน", value: money(opportunityCount), deltaText: dashboardChangeText(opportunityCount, Math.max(0, opportunityCount - 1)), tone: "cyan", icon: "target" })}
        </section>

        ${mobileDashboardSummaryCard(channelRows, s.salesToday || 0)}
        ${mobileDashboardAlertsCard(alerts)}
      </div>
    </section>
  `;
}

function desktopInsightTable(rows) {
  if (!rows.length) return `<div class="empty-state">ยังไม่มีข้อมูลช่องทางขายของวันนี้</div>`;
  return rows.map(row => `
    <div class="desktop-channel-row">
      <span class="desktop-channel-label"><i style="background:${row.color}"></i>${escapeHtml(row.name)}</span>
      <strong>${money(row.revenue)} บาท</strong>
      <span>${row.percent.toFixed(1)}%</span>
    </div>
  `).join("");
}

function desktopOpportunityRows(rows) {
  return rows.slice(0, 4).map(item => `
    <button class="desktop-opportunity-row" type="button" data-view-shortcut="${escapeHtml(item.targetView)}">
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.description)}</small>
      </span>
      <span class="desktop-opportunity-meta">${money(item.revenue)} บาท</span>
    </button>
  `).join("");
}

function desktopCustomerOpportunities() {
  const scoreSteps = [85, 72, 68, 60, 55];
  const customers = [...(app.data.customers || [])]
    .filter(customer => Number(customer.totalSpent || customer.lastAmount || 0) > 0)
    .sort((a, b) => Number(b.customerScore || b.totalSpent || 0) - Number(a.customerScore || a.totalSpent || 0))
    .slice(0, 5);
  const reasons = [
    ["เคยซื้อซ้ำ 3 ครั้ง", "สนใจสินค้ากลุ่มสุขภาพ"],
    ["ดูสินค้า 5 รายการ", "ยังไม่ได้สั่งซื้อ"],
    ["เพิ่มสินค้าลงตะกร้า", "แต่ยังไม่ได้ชำระเงิน"],
    ["แชทสอบถามสินค้า", "รอการตอบกลับ"],
    ["เปิดดูเพจหลายครั้ง", "สนใจโปรโมชั่น"]
  ];
  return customers.map((customer, index) => ({
    id: customer.id,
    name: customer.name || `ลูกค้า ${index + 1}`,
    lastDate: customer.lastPurchaseDate,
    reason: reasons[index]?.[0] || "มีแนวโน้มซื้อซ้ำ",
    detail: reasons[index]?.[1] || "ควรติดตามวันนี้",
    score: scoreSteps[index] || Math.max(45, 85 - index * 7),
    value: Math.round(Number(customer.lastAmount || customer.totalSpent / Math.max(customer.purchaseCount || 1, 1) || 980))
  }));
}

function desktopOpportunityTable(rows) {
  if (!rows.length) return `<div class="empty-state">ยังไม่มีลูกค้าที่ควรติดตามในวันนี้</div>`;
  return `
    <div class="grow-opportunity-table">
      <div class="grow-opportunity-head">
        <span>ลูกค้า</span><span>เหตุผลที่แนะนำ</span><span>โอกาสสำเร็จ</span><span>มูลค่าที่คาดว่าได้</span><span>การดำเนินการ</span>
      </div>
      ${rows.map((item, index) => `
        <div class="grow-opportunity-row">
          <div class="grow-customer">
            <span class="grow-avatar avatar-${index + 1}">${escapeHtml(initials(item.name))}</span>
            <span><strong>${escapeHtml(item.name)}</strong><small>${item.lastDate ? `สั่งซื้อครั้งล่าสุด ${formatShortDate(item.lastDate)}` : "ลูกค้าเป้าหมายวันนี้"}</small></span>
          </div>
          <span class="grow-reason"><strong>${escapeHtml(item.reason)}</strong><small>${escapeHtml(item.detail)}</small></span>
          <span class="grow-score score-${index + 1}" style="--score:${item.score * 3.6}deg"><i>${item.score}%</i></span>
          <strong class="grow-value">${money(item.value)} บาท</strong>
          <span class="grow-actions">
            <button class="grow-follow-button" type="button" data-open-customer="${escapeHtml(item.id)}">ติดตามเลย</button>
            <button class="grow-chat-button" type="button" data-open-customer="${escapeHtml(item.id)}" aria-label="เปิดข้อมูลลูกค้า">${iconSvg("chat")}</button>
          </span>
        </div>
      `).join("")}
    </div>
  `;
}

function desktopDashboardChannelRows(selectedDate) {
  const selectedMonth = String(selectedDate || todayISO()).slice(0, 7);
  const colors = ["#0878ff", "#15d67a", "#ff9f0a", "#8e2cff", "#969dd8"];
  const orders = (app.data.orders || []).filter(order => String(order.date || "").startsWith(selectedMonth));
  const map = new Map();
  for (const order of orders) {
    const channel = summarizeSalesChannel(displayOrderChannel(order));
    if (!map.has(channel)) map.set(channel, { name: channel, revenue: 0, count: 0 });
    const row = map.get(channel);
    row.revenue += Number(order.amount || 0);
    row.count += 1;
  }
  const sorted = [...map.values()].sort((a, b) => b.revenue - a.revenue);
  const primary = sorted.slice(0, 4);
  if (sorted.length > 4) {
    primary.push(sorted.slice(4).reduce((result, row) => ({
      name: "อื่นๆ",
      revenue: result.revenue + row.revenue,
      count: result.count + row.count
    }), { name: "อื่นๆ", revenue: 0, count: 0 }));
  }
  const total = primary.reduce((sum, row) => sum + row.revenue, 0);
  return primary.map((row, index) => ({
    ...row,
    color: colors[index % colors.length],
    percent: total ? row.revenue / total * 100 : 0
  }));
}

function desktopDashboardDonutGradient(rows) {
  if (!rows.length) return "#233249 0% 100%";
  let offset = 0;
  return rows.map(row => {
    const start = offset;
    offset += row.percent;
    return `${row.color} ${start.toFixed(2)}% ${offset.toFixed(2)}%`;
  }).join(", ");
}

function desktopReferenceKpiCard({ label, value, deltaText, tone, icon, hint }) {
  const trend = String(deltaText).startsWith("-") ? "down" : "up";
  return `
    <article class="desktop-reference-kpi tone-${escapeHtml(tone)}">
      <span class="desktop-reference-kpi-icon" aria-hidden="true">${dashboardCardIcon(icon)}</span>
      <div class="desktop-reference-kpi-copy">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small class="${trend}">${trend === "down" ? "↓" : "↑"} ${escapeHtml(deltaText.replace(/^[+-]/, ""))}</small>
        <em>${escapeHtml(hint)}</em>
      </div>
    </article>
  `;
}

function desktopReferenceChannelIcon(name, index) {
  const normalized = String(name || "").toLowerCase();
  const label = normalized.includes("facebook") ? "f"
    : normalized.includes("line") ? "LINE"
      : normalized.includes("โทร") ? "☎"
        : normalized.includes("ติดตาม") ? "◎"
          : "•";
  return `<span class="desktop-reference-channel-icon channel-${index + 1}" aria-hidden="true">${label}</span>`;
}

function desktopReferenceQuickActions() {
  const actions = [
    { title: "สร้างออเดอร์", detail: "สร้างออเดอร์ใหม่ได้อย่างรวดเร็ว", icon: "spark", tone: "purple", attribute: "data-open-order" },
    { title: "จัดการสินค้า", detail: "เพิ่ม แก้ไข และจัดการสินค้าในร้าน", icon: "box", tone: "orange", view: "products" },
    { title: "รายงาน", detail: "ดูรายงานและสถิติธุรกิจแบบละเอียด", icon: "chart", tone: "blue", view: "reports" },
    { title: "โอกาสทำเงิน", detail: "ติดตามและจัดการโอกาสการขาย", icon: "spark", tone: "green", view: "opportunities" },
    { title: "เพิ่มลูกค้า", detail: "เพิ่มลูกค้าใหม่และติดต่ออย่างมีประสิทธิภาพ", icon: "users", tone: "violet", view: "customers" },
    { title: "การตลาด", detail: "สร้างแคมเปญและโปรโมทธุรกิจ", icon: "send", tone: "pink", view: "marketing" }
  ];
  return actions.map(action => `
    <button class="desktop-reference-quick-action tone-${escapeHtml(action.tone)}" type="button"
      ${action.view ? `data-view-shortcut="${escapeHtml(action.view)}"` : action.attribute}>
      <span class="desktop-reference-quick-icon">${iconSvg(action.icon)}</span>
      <span><strong>${escapeHtml(action.title)}</strong><small>${escapeHtml(action.detail)}</small></span>
    </button>
  `).join("");
}

function renderDesktopDashboard(viewModel) {
  const { s, estimatedProfitToday, revenueOpportunity, todaysOrders } = viewModel;
  const selectedMonth = String(s.selectedDate || todayISO()).slice(0, 7);
  const channelRows = desktopDashboardChannelRows(s.selectedDate);
  const monthOrders = (app.data.orders || []).filter(order => String(order.date || "").startsWith(selectedMonth));
  const monthCustomerIds = new Set(monthOrders.map(order => order.customerId));
  const monthCustomers = (app.data.customers || []).filter(customer => monthCustomerIds.has(customer.id));
  const newCustomers = monthCustomers.filter(customer => String(customer.firstPurchaseDate || customer.createdAt || "").startsWith(selectedMonth)).length;
  const repeatCustomers = monthCustomers.filter(customer => Number(customer.purchaseCount || 0) > 1).length;
  const vipCounts = {
    VIP: (app.data.customers || []).filter(customer => customer.vipLevel === "VIP").length,
    VVIP: (app.data.customers || []).filter(customer => customer.vipLevel === "VVIP").length,
    "SUPER VIP": (app.data.customers || []).filter(customer => customer.vipLevel === "SUPER VIP").length
  };
  const monthlySales = channelRows.reduce((sum, row) => sum + row.revenue, 0);
  const unitsSoldToday = todaysOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const setup = mobileSetupWizardState();
  const yesterdaySales = Number(s.salesToday || 0) - Number(viewModel.salesDelta.diff || 0);
  const yesterdayOrders = Number(s.ordersToday || 0) - Number(viewModel.ordersDelta.diff || 0);
  const yesterdayProfit = Number(estimatedProfitToday || 0) - Number(viewModel.profitDelta.diff || 0);
  const previousOpportunity = Number(revenueOpportunity || 0) - Number(viewModel.opportunityDelta.diff || 0);
  const previousUnits = (app.data.orders || [])
    .filter(order => order.date === addDaysISO(s.selectedDate, -1))
    .reduce((sum, order) => sum + Number(order.jars || 0), 0);
  els.content.innerHTML = `
    <section class="desktop-reference-dashboard" aria-label="แดชบอร์ด Growup Pilot">
      <div class="desktop-reference-dashboard-shell">
        <section class="desktop-reference-hero-grid">
          <article class="desktop-reference-growth-banner">
            <img src="/desktop-dashboard-hero.webp?v=20260706-webp-v1" alt="จัดการธุรกิจให้เติบโต ไปกับ Growup Pilot" loading="eager" fetchpriority="high">
          </article>
          <article class="desktop-reference-onboarding">
            <div class="desktop-reference-onboarding-title">
              <span>เริ่มต้นใช้งาน</span>
              <strong>Growup Pilot</strong>
            </div>
            <img class="desktop-reference-rocket" src="/desktop-onboarding-rocket.webp?v=20260706-webp-v1" alt="" aria-hidden="true" loading="eager" decoding="async">
            <div class="desktop-reference-onboarding-summary">
              <div class="desktop-reference-setup-ring" style="--setup-progress:${setup.percent * 3.6}deg">
                <strong>${setup.percent}%</strong>
                <small>พร้อมใช้งาน</small>
              </div>
              <div class="desktop-reference-setup-copy">
                <span>เสร็จแล้ว ${setup.completeCount} จาก ${setup.steps.length} ขั้นตอน</span>
                <div class="desktop-reference-setup-track"><i style="width:${setup.percent}%"></i></div>
                <button type="button" data-view-shortcut="settings">ดูขั้นตอนทั้งหมด <b aria-hidden="true">→</b></button>
              </div>
            </div>
          </article>
        </section>

        <section class="desktop-reference-kpi-grid">
          ${desktopReferenceKpiCard({ label: "ยอดขายวันนี้", value: `฿${money(s.salesToday)}`, deltaText: dashboardChangeText(s.salesToday, yesterdaySales), tone: "green", icon: "wallet", hint: "เทียบกับเมื่อวาน" })}
          ${desktopReferenceKpiCard({ label: "ออเดอร์วันนี้", value: money(s.ordersToday || 0), deltaText: dashboardChangeText(s.ordersToday || 0, yesterdayOrders), tone: "orange", icon: "bag", hint: "เทียบกับเมื่อวาน" })}
          ${desktopReferenceKpiCard({ label: "กำไรวันนี้", value: `฿${money(estimatedProfitToday)}`, deltaText: dashboardChangeText(estimatedProfitToday, yesterdayProfit), tone: "purple", icon: "database", hint: "เทียบกับเมื่อวาน" })}
          ${desktopReferenceKpiCard({ label: "ขายได้วันนี้", value: `${money(unitsSoldToday)} ชิ้น`, deltaText: dashboardChangeText(unitsSoldToday, previousUnits), tone: "blue", icon: "box", hint: "เทียบกับเมื่อวาน" })}
          ${desktopReferenceKpiCard({ label: "โอกาสสร้างยอดขายวันนี้", value: `฿${money(revenueOpportunity)}`, deltaText: dashboardChangeText(revenueOpportunity, previousOpportunity), tone: "pink", icon: "target", hint: `จาก ${money(viewModel.opportunityCount)} ลูกค้า` })}
        </section>

        <section class="desktop-reference-insight-grid">
          <article class="desktop-reference-card desktop-reference-channel-chart">
            <div class="desktop-reference-card-head">
              <h2>ช่องทางการขาย <small>(เดือนนี้)</small></h2>
              <button type="button" data-view-shortcut="reports">เดือนนี้⌄</button>
            </div>
            ${channelRows.length ? `
              <div class="desktop-reference-channel-chart-body">
                <div class="desktop-reference-donut" style="--donut:${desktopDashboardDonutGradient(channelRows)}">
                  <div><strong>฿${money(monthlySales)}</strong><small>ยอดขายรวม</small></div>
                </div>
                <div class="desktop-reference-chart-legend">
                  ${channelRows.map(row => `
                    <div>
                      <span><i style="background:${row.color}"></i>${escapeHtml(row.name)}</span>
                      <b>${row.percent.toFixed(0)}%</b>
                      <strong>฿${money(row.revenue)}</strong>
                    </div>
                  `).join("")}
                </div>
              </div>
            ` : `<div class="desktop-reference-empty">ยังไม่มีข้อมูลช่องทางขายในเดือนนี้</div>`}
          </article>

          <article class="desktop-reference-card desktop-reference-channel-list-card">
            <div class="desktop-reference-card-head">
              <h2>ช่องทางขาย <small>(จำนวนออเดอร์ เดือนนี้)</small></h2>
              <button type="button" data-view-shortcut="reports">เดือนนี้⌄</button>
            </div>
            <div class="desktop-reference-channel-list">
              ${channelRows.map((row, index) => `
                <div>
                  <span>${desktopReferenceChannelIcon(row.name, index)}${escapeHtml(row.name)}</span>
                  <strong>${money(row.count)} ออเดอร์</strong>
                </div>
              `).join("") || `<div class="desktop-reference-empty">ยังไม่มีออเดอร์ในเดือนนี้</div>`}
            </div>
          </article>

          <article class="desktop-reference-card desktop-reference-customer-card">
            <div class="desktop-reference-card-head">
              <h2>ลูกค้า <small>(เดือนนี้)</small></h2>
              <button type="button" data-view-shortcut="customers">เดือนนี้⌄</button>
            </div>
            <div class="desktop-reference-customer-stats">
              <button type="button" data-view-shortcut="customers">
                <span class="new">${iconSvg("users")}</span>
                <span><small>ลูกค้าใหม่</small><strong>${money(newCustomers)} คน</strong><em>↑ ${dashboardChangeText(newCustomers, Math.max(0, newCustomers - 1)).replace(/^[+-]/, "")}</em></span>
              </button>
              <button type="button" data-view-shortcut="customers">
                <span class="repeat">↻</span>
                <span><small>ลูกค้าเก่ากลับมาซื้อซ้ำ</small><strong>${money(repeatCustomers)} คน</strong><em>↑ ${dashboardChangeText(repeatCustomers, Math.max(0, repeatCustomers - 1)).replace(/^[+-]/, "")}</em></span>
              </button>
            </div>
            <div class="desktop-reference-vip-head">
              <h3>ลูกค้า VIP</h3>
              <button type="button" data-view-shortcut="vip">ดูทั้งหมด →</button>
            </div>
            <div class="desktop-reference-vip-grid">
              <button type="button" data-view-shortcut="vip"><span class="vip">♛</span><span><small>VIP</small><strong>${money(vipCounts.VIP)} คน</strong></span></button>
              <button type="button" data-view-shortcut="vip"><span class="vvip">♛</span><span><small>VVIP</small><strong>${money(vipCounts.VVIP)} คน</strong></span></button>
              <button type="button" data-view-shortcut="vip"><span class="super">◆</span><span><small>SUPER VIP</small><strong>${money(vipCounts["SUPER VIP"])} คน</strong></span></button>
            </div>
          </article>
        </section>

        <section class="desktop-reference-quick-grid" aria-label="เมนูลัด">
          ${desktopReferenceQuickActions()}
        </section>
      </div>
    </section>
  `;
}

function renderDashboard() {
  const s = app.data.summary;
  const opportunities = opportunityCardsData();
  const yesterday = addDaysISO(s.selectedDate, -1);
  const yesterdayOrders = app.data.orders.filter(order => order.date === yesterday);
  const yesterdaySales = yesterdayOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const yesterdayOrderCount = yesterdayOrders.length;
  const monthStart = `${String(s.selectedDate).slice(0, 8)}01`;
  const monthToDateOrders = app.data.orders.filter(order => order.date >= monthStart && order.date <= s.selectedDate);
  const previousMonthReference = addDaysISO(monthStart, -1);
  const previousMonthKey = monthKey(previousMonthReference);
  const previousMonthOrders = app.data.orders.filter(order => monthKey(order.date) === previousMonthKey);
  const previousMonthSales = previousMonthOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const revenueOpportunity = opportunities.reduce((sum, item) => sum + item.revenue, 0);
  const todaysOrders = app.data.orders.filter(order => order.date === s.selectedDate);
  const todayProfitBreakdown = profitBreakdownForOrders(todaysOrders);
  const productCostsToday = todayProfitBreakdown.productCosts;
  const additionalCostsToday = todayProfitBreakdown.additionalCosts;
  const estimatedProfitToday = todayProfitBreakdown.profit;
  const previousOpportunityRevenue = estimatedOpportunityRevenue(
    app.data.customers.filter(customer => customer.followUpDate && customer.followUpDate <= yesterday),
    0.36
  ) + estimatedOpportunityRevenue(
    app.data.customers.filter(customer => !customer.lastPurchaseDate || !String(customer.lastPurchaseDate).startsWith(previousMonthKey)),
    0.18
  );
  const salesDelta = dashboardDelta(s.salesToday, yesterdaySales, "currency");
  const salesMonthDelta = dashboardDelta(s.salesThisMonth || 0, previousMonthSales, "currency");
  const ordersDelta = dashboardDelta(s.ordersToday || 0, yesterdayOrderCount);
  const ordersMonthDelta = dashboardDelta(s.ordersThisMonth || 0, previousMonthOrders.length);
  const yesterdayProfit = profitBreakdownForOrders(yesterdayOrders).profit;
  const profitDelta = dashboardDelta(estimatedProfitToday, yesterdayProfit, "currency");
  const opportunityDelta = dashboardDelta(revenueOpportunity, previousOpportunityRevenue, "currency");
  const compactDate = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date(`${s.selectedDate}T12:00:00+07:00`));
  const channelRows = dashboardChannelRows(s.selectedDate);
  const viewModel = {
    s,
    compactDate,
    salesDelta,
    salesMonthDelta,
    ordersDelta,
    profitDelta,
    opportunityDelta,
    estimatedProfitToday,
    productCostsToday,
    additionalCostsToday,
    revenueOpportunity,
    opportunityCount: opportunities.reduce((sum, item) => sum + item.count, 0),
    monthToDateOrders,
    todaysOrders,
    opportunities,
    channelRows,
    alerts: mobileDashboardAlertItems()
  };

  if (isMobileViewport()) {
    renderMobileDashboard(viewModel);
    return;
  }
  renderDesktopDashboard(viewModel);
}

const businessManagementItems = [
  { view: "settingsStore", title: "ตั้งค่า", description: "ข้อมูลร้านค้า การเงิน สิทธิ์ และการตั้งค่าระบบ", icon: iconSvg("settings") },
  { view: "products", title: "สินค้า", description: "คลังสินค้า สต๊อก และข้อมูลสินค้าทั้งหมด", icon: iconSvg("box") },
  { view: "customers", title: "ลูกค้า", description: "ดูโปรไฟล์ลูกค้า การติดตาม และสถานะ VIP", icon: iconSvg("users") },
  { view: "aiInsights", title: "ข้อมูลเชิงลึกจาก AI", description: "คำแนะนำเชิงธุรกิจจากข้อมูลล่าสุดของร้าน", icon: iconSvg("stars") }
];

function mobileBusinessStartDate() {
  const dates = [
    ...(app.data.orders || []).map(order => order.date),
    ...(app.data.customers || []).flatMap(customer => [customer.createdAt, customer.firstPurchaseDate])
  ].filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")));
  return dates.sort()[0] || "";
}

function mobileBusinessIcon(name) {
  return `<span class="mobile-business-icon" aria-hidden="true">${iconSvg(name)}</span>`;
}

function mobileBusinessHeader(title, description, icon = "briefcase") {
  return `
    <header class="mobile-business-subhead">
      <button class="mobile-business-back" type="button" data-business-page="main" aria-label="กลับหน้าจัดการธุรกิจ">${iconSvg("arrow")}</button>
      ${mobileBusinessIcon(icon)}
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
    </header>
  `;
}

function mobileBusinessEmpty(title, description) {
  return `
    <div class="mobile-business-empty">
      ${mobileBusinessIcon("clipboard")}
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
    </div>
  `;
}

function securityStatusText(user) {
  return user?.active === false ? "ปิดใช้งาน" : "ใช้งานอยู่";
}

function securityLastLoginText(user) {
  const value = user?.lastLoginAt || user?.lastLogin || user?.lastActiveAt || "";
  return value ? formatDate(value) : "เซสชันปัจจุบัน";
}

function securityCenterCards(user) {
  return [
    {
      key: "account",
      title: "ข้อมูลบัญชีของคุณ",
      description: "ดูชื่อบัญชี สถานะ และการเข้าสู่ระบบล่าสุด",
      icon: "users",
      tone: "purple",
      metaLabel: "บัญชีของคุณ",
      metaValue: user?.name || "ไม่พบชื่อผู้ใช้"
    },
    {
      key: "additional",
      title: "ความปลอดภัยเพิ่มเติม",
      description: "ตั้งค่าตัวเลือกเพื่อเพิ่มความปลอดภัยให้บัญชี",
      icon: "shield",
      tone: "green",
      metaLabel: "การตั้งค่าที่เปิดใช้งาน",
      metaValue: "2 รายการ"
    },
    {
      key: "devices",
      title: "อุปกรณ์และการเข้าสู่ระบบ",
      description: "จัดการอุปกรณ์ที่เคยเข้าสู่ระบบและออกจากระบบอื่น",
      icon: "monitor",
      tone: "blue",
      metaLabel: "อุปกรณ์ที่ใช้งานอยู่",
      metaValue: "1 อุปกรณ์"
    },
    {
      key: "notifications",
      title: "การแจ้งเตือนความปลอดภัย",
      description: "จัดการการแจ้งเตือนเกี่ยวกับความปลอดภัยของบัญชี",
      icon: "bell",
      tone: "orange",
      metaLabel: "การแจ้งเตือนที่เปิดใช้งาน",
      metaValue: "2 รายการ"
    }
  ];
}

function securityDetailRows(key, user) {
  const rows = {
    account: [
      ["ชื่อผู้ใช้", user?.username || "ไม่เปิดเผย"],
      ["บทบาท", userRoleLabel(user?.role || "Staff")],
      ["สถานะ", securityStatusText(user)],
      ["เข้าสู่ระบบล่าสุด", securityLastLoginText(user)]
    ],
    additional: [
      ["ออกจากระบบอัตโนมัติ", "เปิดใช้งานตามเซสชันของระบบ"],
      ["ป้องกันข้อมูลบัญชี", "ไม่แสดงหรือจัดเก็บรหัสผ่านแบบเปิดเผย"],
      ["การจัดการรหัสผ่าน", "อยู่ใน การจัดการสิทธิ์ / ผู้ใช้งาน"]
    ],
    devices: [
      ["อุปกรณ์ปัจจุบัน", "เบราว์เซอร์นี้"],
      ["สถานะเซสชัน", "กำลังใช้งาน"],
      ["ประวัติการเข้าสู่ระบบ", securityLastLoginText(user)]
    ],
    notifications: [
      ["แจ้งเตือนเข้าสู่ระบบจากอุปกรณ์ใหม่", "เปิดใช้งาน"],
      ["แจ้งเตือนเปลี่ยนรหัสผ่านหรือสิทธิ์", "เปิดใช้งาน"],
      ["ช่องทางแจ้งเตือน", "ในระบบ GrowupPilot"]
    ]
  };
  return rows[key] || rows.account;
}

function renderSecurityDetail(key, user, { mobile = false } = {}) {
  const cards = securityCenterCards(user);
  const detail = cards.find(item => item.key === key) || cards[0];
  const rows = securityDetailRows(detail.key, user);
  const logoutAll = detail.key === "devices"
    ? `<button class="button ghost security-logout-all" type="button" data-logout-all-devices>ออกจากระบบทุกอุปกรณ์</button>`
    : "";
  return `
    <section class="security-detail-panel ${mobile ? "mobile" : ""}">
      <div class="security-detail-head">
        <span class="security-detail-icon ${escapeHtml(detail.tone)}">${mobileBusinessIcon(detail.icon)}</span>
        <div>
          <h3>${escapeHtml(detail.title)}</h3>
          <p>${escapeHtml(detail.description)}</p>
        </div>
        <button class="security-detail-close" type="button" data-security-close aria-label="ปิดรายละเอียด">×</button>
      </div>
      ${logoutAll}
      <div class="mobile-business-info-list security-detail-list">
        ${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
      </div>
    </section>
  `;
}

function renderSecurityCenter({ mobile = false } = {}) {
  const user = app.data?.currentUser || app.currentUser || {};
  const cards = securityCenterCards(user);
  const selectedKey = app.securityDetailKey || "";
  return `
    <div class="security-center ${mobile ? "mobile" : ""}">
      <div class="security-card-grid">
        ${cards.map(item => `
          <button class="security-center-card ${escapeHtml(item.tone)} ${selectedKey === item.key ? "is-active" : ""}" type="button" data-security-card="${escapeHtml(item.key)}" aria-expanded="${selectedKey === item.key ? "true" : "false"}">
            <span class="security-card-icon">${mobileBusinessIcon(item.icon)}</span>
            <span class="security-card-copy">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.description)}</small>
              <em aria-hidden="true">›</em>
            </span>
            <span class="security-card-meta"><small>${escapeHtml(item.metaLabel)}</small><b>${escapeHtml(item.metaValue)}</b></span>
          </button>
        `).join("")}
      </div>
      ${selectedKey ? renderSecurityDetail(selectedKey, user, { mobile }) : ""}
    </div>
  `;
}

function mobileBusinessMenuRow(page, title, description, icon, tone) {
  return `
    <button class="mobile-business-menu-row ${escapeHtml(tone)}" type="button" data-business-page="${escapeHtml(page)}">
      ${mobileBusinessIcon(icon)}
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span>
      <span class="mobile-business-chevron" aria-hidden="true">${iconSvg("arrow")}</span>
    </button>
  `;
}

function mobileSetupWizardState() {
  const products = normalizeProductRecords();
  const productCosts = normalizeProductCostEntries(app.data.settings || {});
  const steps = [
    {
      title: "สร้างสินค้า",
      description: "เพิ่มสินค้าของคุณในระบบ เพื่อจัดการสต๊อกและยอดขาย",
      icon: "box",
      page: "products",
      action: "ไปที่จัดการสินค้า",
      complete: products.length > 0
    },
    {
      title: "ตั้งต้นทุนสินค้า",
      checklistTitle: "ตั้งต้นทุน",
      description: "กำหนดต้นทุนสินค้าเพื่อคำนวณกำไรได้แม่นยำ",
      icon: "chart",
      page: "finance",
      action: "ไปที่ต้นทุนและกำไร",
      complete: productCosts.some(item => item.enabled && Number(item.costPerJar) > 0)
    },
    {
      title: "สร้างแพ็กขาย",
      description: "สร้างแพ็กเกจและโปรโมชันสำหรับสินค้าของคุณ",
      icon: "briefcase",
      page: "products",
      action: "ไปที่แพ็กขาย",
      complete: products.some(product => product.salesPackages.length > 0)
    },
    {
      title: "เชื่อม LINE OA",
      description: "เตรียม LINE Official Account เพื่อรับออเดอร์อัตโนมัติ",
      icon: "chat",
      action: "การเชื่อมต่อจริง Coming Soon",
      guide: "วิดีโอแนะนำการตั้งค่า LINE OA",
      complete: false,
      comingSoon: true
    },
    {
      title: "เพิ่ม BOT เข้ากลุ่ม LINE",
      checklistTitle: "เพิ่ม BOT เข้ากลุ่ม",
      description: "เพิ่ม BOT เข้ากลุ่ม LINE ที่ใช้รับออเดอร์",
      icon: "users",
      action: "การเพิ่ม BOT จริง Coming Soon",
      guide: "วิดีโอแนะนำการเพิ่ม BOT เข้ากลุ่ม",
      complete: false,
      comingSoon: true
    },
    {
      title: "ทดสอบรับออเดอร์อัตโนมัติ",
      description: "ทดลองส่งข้อความออเดอร์ เพื่อเตรียมตรวจสอบการนำเข้า",
      icon: "send",
      action: "Coming Soon",
      guide: "ตัวอย่างข้อความออเดอร์",
      complete: false,
      comingSoon: true
    }
  ];
  const completeCount = steps.filter(step => step.complete).length;
  return {
    steps,
    completeCount,
    percent: Math.round((completeCount / steps.length) * 100)
  };
}

function mobileSetupStatusIcon(complete) {
  return complete
    ? '<span class="mobile-setup-status complete" aria-label="เสร็จแล้ว">✓</span>'
    : '<span class="mobile-setup-status pending" aria-label="รอตั้งค่า">○</span>';
}

function renderMobileSetupCard() {
  const setup = mobileSetupWizardState();
  return `
    <article class="mobile-setup-card">
      <div class="mobile-setup-card-glow" aria-hidden="true">${iconSvg("send")}</div>
      <div class="mobile-setup-card-heading">
        <span>เริ่มต้นใช้งาน</span>
        <h2>Growup Pilot</h2>
        <p>ตั้งค่าระบบให้พร้อมรับออเดอร์อัตโนมัติ</p>
      </div>
      <div class="mobile-setup-summary">
        <div class="mobile-setup-percent" style="--setup-progress: ${setup.percent * 3.6}deg">
          <strong>${setup.percent}%</strong>
          <small>พร้อมใช้งาน</small>
        </div>
        <div class="mobile-setup-progress-copy">
          <span>เสร็จแล้ว ${setup.completeCount} จาก ${setup.steps.length} ขั้นตอน</span>
          <div class="mobile-setup-progress-track" role="progressbar" aria-label="ความคืบหน้าการตั้งค่า" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${setup.percent}">
            <i style="width: ${setup.percent}%"></i>
          </div>
        </div>
      </div>
      <ol class="mobile-setup-checklist">
        ${setup.steps.map((step, index) => `
          <li>
            <span class="mobile-setup-number">${index + 1}</span>
            <span>${escapeHtml(step.checklistTitle || step.title)}</span>
            ${mobileSetupStatusIcon(step.complete)}
          </li>
        `).join("")}
      </ol>
      <button class="mobile-setup-primary" type="button" data-business-page="setupWizard">
        <span>เริ่มตั้งค่า</span><span aria-hidden="true">›</span>
      </button>
    </article>
  `;
}

function renderMobileBusinessMain() {
  const customers = app.data.customers || [];
  const orders = app.data.orders || [];
  const products = productRowsData();
  const startDate = mobileBusinessStartDate();
  const totalSales = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const todayPerformance = marketingPerformanceForPeriod({ date: todayISO() });
  const todayFinance = profitBreakdownForOrders(orders.filter(order => order.date === todayISO()));
  return `
    <section class="mobile-business-page">
      ${renderMobileSetupCard()}

      <section class="mobile-business-section">
        <h2>จัดการข้อมูล</h2>
        <div class="mobile-business-data-grid">
          <button class="mobile-business-data-card purple" type="button" data-business-page="customers">
            ${mobileBusinessIcon("users")}
            <span><strong>จัดการลูกค้า</strong><small>เพิ่ม แก้ไข และดูข้อมูลลูกค้า</small><b>${money(customers.length)} ราย</b></span>
          </button>
          <button class="mobile-business-data-card orange" type="button" data-business-page="products">
            ${mobileBusinessIcon("box")}
            <span><strong>จัดการสินค้า</strong><small>เพิ่ม แก้ไข และจัดการสินค้า</small><b>${money(products.length)} รายการ</b></span>
          </button>
          <button class="mobile-business-data-card green finance-feature-card" type="button" data-business-page="finance">
            ${mobileBusinessIcon("chart")}
            <span><strong>ต้นทุนและกำไร</strong><small>คำนวณต้นทุนและกำไรของสินค้า</small><b>กำไรวันนี้ ฿ ${money(todayFinance.profitBeforeAds)}</b></span>
          </button>
          <button class="mobile-business-data-card blue ad-feature-card" type="button" data-business-page="advertising">
            ${mobileBusinessIcon("megaphone")}
            <span><i class="mobile-business-new-badge">ใหม่</i><strong>ค่าโฆษณา</strong><small>จัดการค่าโฆษณาและวิเคราะห์ผลลัพธ์</small><b>ใช้ไปวันนี้ ฿ ${money(todayPerformance.adCost)}</b></span>
          </button>
          <button class="mobile-business-data-card pink ad-feature-card" type="button" data-business-page="marketingPerformance">
            ${mobileBusinessIcon("chart")}
            <span><i class="mobile-business-new-badge">ใหม่</i><strong>Dashboard Marketing Performance</strong><small>ดูภาพรวมประสิทธิภาพการตลาด</small><b>ROAS ${marketingNumber(todayPerformance.roas)}</b></span>
          </button>
        </div>
      </section>

      <section class="mobile-business-section">
        <h2>การตั้งค่า</h2>
        <div class="mobile-business-menu-list">
          ${mobileBusinessMenuRow("system", "ตั้งค่าระบบ", "ข้อมูลธุรกิจและการทำงานของระบบ", "settings", "blue")}
          ${mobileBusinessMenuRow("notifications", "การแจ้งเตือน", "ดูการแจ้งเตือนจากข้อมูลล่าสุด", "bell", "orange")}
          ${mobileBusinessMenuRow("security", "ความปลอดภัย", "ข้อมูลบัญชีและความปลอดภัย", "flag", "green")}
          ${mobileBusinessMenuRow("roles", "การจัดการสิทธิ์ / ผู้ใช้งาน", "จัดการผู้ใช้และสิทธิ์การเข้าถึงระบบ", "users", "cyan")}
        </div>
      </section>

      <section class="mobile-business-section">
        <h2>เครื่องมือธุรกิจ</h2>
        <div class="mobile-business-tools-grid">
          <button class="mobile-business-tool purple" type="button" data-business-page="goals">${mobileBusinessIcon("flag")}<strong>เป้าหมายยอดขาย</strong><small>ตั้งเป้าหมายและติดตามความสำเร็จ</small><b>ดูรายงาน</b></button>
          <button class="mobile-business-tool orange" type="button" data-business-page="analytics">${mobileBusinessIcon("chart")}<strong>วิเคราะห์ธุรกิจ</strong><small>วิเคราะห์ข้อมูลและแนวโน้มธุรกิจ</small><b>ดูรายงาน</b></button>
          <button class="mobile-business-tool blue" type="button" data-business-page="import">${mobileBusinessIcon("upload")}<strong>นำเข้าออเดอร์</strong><small>นำเข้าออเดอร์จากไฟล์ CSV หรือ Excel</small><b>นำเข้า</b></button>
          <button class="mobile-business-tool green" type="button" data-business-page="backup">${mobileBusinessIcon("clipboard")}<strong>สำรองข้อมูล</strong><small>สำรองและกู้คืนข้อมูลธุรกิจ</small><b>สำรองข้อมูล</b></button>
        </div>
      </section>

      <section class="mobile-business-section">
        <h2>ข้อมูลการใช้งาน</h2>
        <div class="mobile-business-usage-grid">
          <article class="purple">${mobileBusinessIcon("clipboard")}<span>วันที่เริ่มใช้งาน</span><strong>${startDate ? formatDate(startDate) : "ไม่มีข้อมูล"}</strong></article>
          <article class="blue">${mobileBusinessIcon("chart")}<span>ออเดอร์ทั้งหมด</span><strong>${money(orders.length)}</strong><small>ออเดอร์</small></article>
          <article class="green">${mobileBusinessIcon("users")}<span>ลูกค้าทั้งหมด</span><strong>${money(customers.length)}</strong><small>ราย</small></article>
          <article class="orange">${mobileBusinessIcon("box")}<span>สินค้าทั้งหมด</span><strong>${money(products.length)}</strong><small>รายการ</small></article>
          <article class="cyan">${mobileBusinessIcon("briefcase")}<span>ยอดขายรวม</span><strong>${money(totalSales)}</strong><small>บาท</small></article>
        </div>
      </section>
    </section>
  `;
}

function renderMobileSetupWizard() {
  const setup = mobileSetupWizardState();
  return `
    <section class="mobile-business-page mobile-business-subpage mobile-setup-wizard-page">
      <header class="mobile-setup-wizard-header">
        <button class="mobile-business-back" type="button" data-business-page="main" aria-label="กลับหน้าจัดการธุรกิจ">${iconSvg("arrow")}</button>
        <div>
          <span>Setup Wizard</span>
          <h2>เริ่มต้นใช้งาน</h2>
          <p>ตั้งค่าระบบให้พร้อมรับออเดอร์อัตโนมัติ</p>
        </div>
      </header>
      <section class="mobile-setup-overview">
        <div>
          <span>ความคืบหน้า</span>
          <strong>${setup.percent}%</strong>
        </div>
        <p>เสร็จแล้ว ${setup.completeCount} จาก ${setup.steps.length} ขั้นตอน</p>
        <div class="mobile-setup-progress-track" role="progressbar" aria-label="ความคืบหน้าการตั้งค่า" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${setup.percent}">
          <i style="width: ${setup.percent}%"></i>
        </div>
      </section>
      <ol class="mobile-setup-step-list">
        ${setup.steps.map((step, index) => `
          <li class="${step.complete ? "complete" : "pending"}">
            <span class="mobile-setup-step-number">${index + 1}</span>
            <article class="mobile-setup-step-card">
              <div class="mobile-setup-step-icon">${iconSvg(step.icon)}</div>
              <div class="mobile-setup-step-copy">
                <h3>${escapeHtml(step.title)}</h3>
                <p>${escapeHtml(step.description)}</p>
                <span class="mobile-setup-step-badge">${step.complete ? "เสร็จสิ้น" : step.comingSoon ? "Coming Soon" : "รอตั้งค่า"}</span>
              </div>
              ${step.page ? `
                <button type="button" data-business-page="${escapeHtml(step.page)}">${escapeHtml(step.action)}</button>
              ` : `
                <button type="button" disabled>${escapeHtml(step.action)}</button>
              `}
              ${step.guide ? `
                <div class="mobile-setup-guide-placeholder" aria-label="${escapeHtml(step.guide)}">
                  <span>${iconSvg(step.icon)}</span>
                  <span><strong>${escapeHtml(step.guide)}</strong><small>พื้นที่วิดีโอ / คู่มือ — Coming Soon</small></span>
                </div>
              ` : ""}
            </article>
          </li>
        `).join("")}
      </ol>
      <aside class="mobile-setup-coming-soon-note">
        ${iconSvg("stars")}
        <p><strong>ฟีเจอร์เชื่อมต่อและทดสอบจริงกำลังพัฒนา</strong><span>หน้านี้เป็น UI สำหรับแนะนำขั้นตอนเท่านั้น ยังไม่มีการเชื่อม LINE API</span></p>
      </aside>
    </section>
  `;
}

function renderMobileBusinessCustomers() {
  const customers = sortByPriority(app.data.customers || []);
  const newCount = customers.filter(customer => customer.status === "NEW").length;
  const repeatCount = customers.filter(customer => Number(customer.purchaseCount || 0) > 1).length;
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("จัดการลูกค้า", "เพิ่ม แก้ไข และดูข้อมูลลูกค้าทั้งหมด", "users")}
      <button class="button primary mobile-business-full-button" type="button" data-view-shortcut="orders">${iconSvg("users")} เพิ่มลูกค้าผ่านออเดอร์</button>
      <div class="mobile-business-kpis three">
        <article class="purple"><span>ลูกค้าทั้งหมด</span><strong>${money(customers.length)}</strong><small>ราย</small></article>
        <article class="blue"><span>ลูกค้าใหม่</span><strong>${money(newCount)}</strong><small>ราย</small></article>
        <article class="green"><span>ลูกค้าประจำ</span><strong>${money(repeatCount)}</strong><small>ราย</small></article>
      </div>
      <div class="mobile-business-record-list">
        ${customers.map(customer => `
          <button class="mobile-business-record" type="button" data-business-customer="${escapeHtml(customer.id)}">
            <span class="mobile-business-avatar">${escapeHtml(initials(customer.name))}</span>
            <span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone || "ไม่มีเบอร์โทร")}</small></span>
            ${vipBadge(customer.vipLevel)}
            <span class="mobile-business-record-date">${formatShortDate(customer.lastPurchaseDate)}</span>
          </button>
        `).join("") || mobileBusinessEmpty("ยังไม่มีข้อมูลลูกค้า", "เพิ่มลูกค้าจากออเดอร์จริงเพื่อให้แสดงในหน้านี้")}
      </div>
    </section>
  `;
}

function renderMobileBusinessCustomerDetail() {
  const customer = (app.data.customers || []).find(item => item.id === app.mobileBusinessCustomerId);
  if (!customer) return renderMobileBusinessCustomers();
  return `
    <section class="mobile-business-page mobile-business-subpage">
      <header class="mobile-business-subhead">
        <button class="mobile-business-back" type="button" data-business-page="customers" aria-label="กลับหน้าจัดการลูกค้า">${iconSvg("arrow")}</button>
        <span class="mobile-business-avatar large">${escapeHtml(initials(customer.name))}</span>
        <div><h2>รายละเอียดลูกค้า</h2><p>ข้อมูลจากประวัติออเดอร์และโปรไฟล์ลูกค้า</p></div>
      </header>
      <article class="mobile-business-detail-card">
        <div class="mobile-business-customer-name"><div><h3>${escapeHtml(customer.name)}</h3><p>${escapeHtml(customer.phone || "ไม่มีเบอร์โทร")}</p></div>${vipBadge(customer.vipLevel)}</div>
        <div class="mobile-business-info-list">
          <div><span>สถานะ</span><strong>${escapeHtml(customer.status || "ยังไม่ได้ระบุ")}</strong></div>
          <div><span>ที่อยู่</span><strong>${escapeHtml(customer.address || "ยังไม่มีข้อมูล")}</strong></div>
          <div><span>อาการ / แท็ก</span><strong>${escapeHtml((customer.tags || []).join(", ") || "ยังไม่มีข้อมูล")}</strong></div>
          <div><span>หมายเหตุ</span><strong>${escapeHtml(customer.note || "ยังไม่มีข้อมูล")}</strong></div>
          <div><span>ซื้อครั้งแรก</span><strong>${customer.firstPurchaseDate ? formatDate(customer.firstPurchaseDate) : "ยังไม่มีข้อมูล"}</strong></div>
          <div><span>ซื้อล่าสุด</span><strong>${customer.lastPurchaseDate ? formatDate(customer.lastPurchaseDate) : "ยังไม่มีข้อมูล"}</strong></div>
          <div><span>ยอดสะสม</span><strong>${money(customer.totalSpent)} บาท</strong></div>
          <div><span>ออเดอร์ทั้งหมด</span><strong>${money(customer.purchaseCount)} ครั้ง</strong></div>
        </div>
        <button class="button primary mobile-business-full-button" type="button" data-open-customer="${escapeHtml(customer.id)}">แก้ไขและบันทึกการติดตาม</button>
      </article>
    </section>
  `;
}

function renderMobileBusinessProducts() {
  const products = productRowsData();
  const ready = products.filter(product => product.computedStatus === "พร้อมขาย").length;
  const low = products.filter(product => ["ใกล้หมด", "เหลือน้อย"].includes(product.computedStatus)).length;
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("จัดการสินค้า", "เพิ่ม แก้ไข และจัดการสินค้า", "box")}
      <button class="button primary mobile-business-full-button" type="button" data-add-product>${iconSvg("box")} เพิ่มสินค้า</button>
      <div class="mobile-business-kpis three mobile-business-product-kpis">
        <article class="purple"><span>สินค้าทั้งหมด</span><strong>${money(products.length)}</strong><small>รายการ</small></article>
        <article class="blue"><span>พร้อมขาย</span><strong>${money(ready)}</strong><small>รายการ</small></article>
        <article class="orange"><span>สต๊อกต่ำ</span><strong>${money(low)}</strong><small>รายการ</small></article>
      </div>
      <div class="mobile-business-record-list">
        ${products.map(product => `
          <button class="mobile-business-product-record" type="button" data-business-product="${escapeHtml(product.id)}">
            <span class="mobile-business-product-thumb">${productImageMarkup(product.image, product.name, iconSvg("box"), product.id)}</span>
            <span><strong>${escapeHtml(product.name)}</strong><small>${money(product.salePrice)} บาท · คงเหลือ ${money(product.stockQuantity)} ชิ้น</small></span>
            <b>${escapeHtml(product.computedStatus)}</b>
          </button>
        `).join("") || mobileBusinessEmpty("ยังไม่มีข้อมูลสินค้า", "เพิ่มสินค้า หรือบันทึกออเดอร์จริงเพื่อให้แสดงในหน้านี้")}
      </div>
    </section>
  `;
}

function renderMobileBusinessProductDetail() {
  const product = productRowsData().find(item => item.id === app.mobileBusinessProductId);
  if (!product) return renderMobileBusinessProducts();
  const productCost = normalizeProductCostEntries(app.data.settings || {}).find(item => item.id === product.id || item.name === product.name);
  const relatedOrders = (app.data.orders || []).filter(order => normalizeProductName(order.items) === product.name);
  const units = relatedOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const unitCost = Number(productCost?.costPerJar ?? product.costPerItem ?? 0);
  const breakdown = profitBreakdownForOrders(relatedOrders, app.data.settings || {});
  return `
    <section class="mobile-business-page mobile-business-subpage">
      <header class="mobile-business-subhead">
        <button class="mobile-business-back" type="button" data-business-page="${escapeHtml(app.mobileBusinessProductReturnPage || "products")}" aria-label="กลับหน้าก่อนหน้า">${iconSvg("arrow")}</button>
        ${mobileBusinessIcon("box")}
        <div><h2>รายละเอียดต้นทุน / กำไร</h2><p>${escapeHtml(product.name)}</p></div>
      </header>
      <article class="mobile-business-detail-card">
        <div class="mobile-business-product-hero">
          <span class="mobile-business-product-thumb large">${productImageMarkup(product.image, product.name, iconSvg("box"), product.id)}</span>
          <div><h3>${escapeHtml(product.name)}</h3><p>อัปเดตล่าสุดจากข้อมูลสินค้าและออเดอร์</p></div>
        </div>
        <div class="mobile-business-finance-grid">
          <article class="purple"><span>ต้นทุนต่อชิ้น</span><strong>${productCostMoney(unitCost)} บาท</strong></article>
          <article class="blue"><span>ขายแล้ว</span><strong>${money(units)} ชิ้น</strong></article>
          <article class="orange"><span>ยอดขาย</span><strong>${money(breakdown.sales)} บาท</strong></article>
          <article class="${breakdown.profit >= 0 ? "green" : "red"}"><span>กำไรสุทธิประมาณการ</span><strong>${money(breakdown.profit)} บาท</strong></article>
        </div>
        <div class="mobile-business-info-list">
          <div><span>ราคาขาย</span><strong>${money(product.salePrice)} บาท</strong></div>
          <div><span>สต๊อกคงเหลือ</span><strong>${money(product.stockQuantity)} ชิ้น</strong></div>
          <div><span>สถานะ</span><strong>${escapeHtml(product.computedStatus)}</strong></div>
          <div><span>รายละเอียด</span><strong>${escapeHtml(product.description || "ยังไม่มีรายละเอียด")}</strong></div>
          <div><span>ต้นทุนสินค้า</span><strong>${money(breakdown.productCosts)} บาท</strong></div>
          <div><span>ค่าใช้จ่ายแพ็กเกจ</span><strong>${money(breakdown.packageExpenses)} บาท</strong></div>
          <div><span>ค่าใช้จ่ายส่วนกลางตามออเดอร์</span><strong>${money(breakdown.globalAdditionalCosts)} บาท</strong></div>
          <div><span>ค่าใช้จ่ายเพิ่มเติมรวม</span><strong>${money(breakdown.additionalCosts)} บาท</strong></div>
          <div><span>จำนวนออเดอร์</span><strong>${money(relatedOrders.length)} ออเดอร์</strong></div>
        </div>
        <button class="button primary mobile-business-full-button" type="button" data-edit-product="${escapeHtml(product.id)}">แก้ไขสินค้า</button>
      </article>
    </section>
  `;
}

function renderMobileBusinessSystem() {
  const settings = app.data.settings || {};
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("ตั้งค่าระบบ", "ตั้งค่าข้อมูลธุรกิจและการทำงานของระบบ", "settings")}
      <form class="mobile-business-form" id="settingsForm">
        <input name="daysPerUnit" type="hidden" value="${Math.max(1, Number(settings.followUpDaysPerUnit || 15))}">
        <label>ชื่อธุรกิจ<input name="businessName" value="${escapeHtml(settings.businessName || "Growup Pilot")}"></label>
        <label>ประเภทธุรกิจ<input value="${escapeHtml(settings.businessType || "")}" placeholder="ยังไม่ได้ระบุ" disabled></label>
        <label>ราคาต่อชิ้นเริ่มต้น (บาท)<input name="defaultJarPrice" type="number" min="0" value="${Number(settings.defaultJarPrice || 0)}"></label>
        <p class="mobile-business-form-note">ประเภทธุรกิจยังไม่มีแหล่งข้อมูลสำหรับบันทึก ระบบจึงแสดงสถานะว่างอย่างปลอดภัย</p>
        <button class="button primary mobile-business-full-button" type="submit">บันทึกการตั้งค่า</button>
      </form>
    </section>
  `;
}

function renderMobileBusinessNotifications() {
  const items = liveNotificationItems();
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("การแจ้งเตือน", "รายการแจ้งเตือนจากข้อมูลธุรกิจล่าสุด", "bell")}
      <div class="mobile-business-notification-list">
        ${items.map(item => `
          <article class="mobile-business-notification">
            ${mobileBusinessIcon(item.type === "stock alerts" ? "box" : item.type === "follow-up customers" ? "users" : "bell")}
            <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span>
            <b>${money(item.count)}</b>
          </article>
        `).join("") || mobileBusinessEmpty("ไม่มีการแจ้งเตือน", "ยังไม่มีรายการจากข้อมูลจริงที่ต้องดำเนินการ")}
      </div>
    </section>
  `;
}

function renderMobileBusinessFinance() {
  const settings = app.data.settings || {};
  const orders = app.data.orders || [];
  const breakdown = profitBreakdownForOrders(orders, settings);
  const advertising = marketingPerformanceForPeriod();
  const products = productRowsData();
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("การเงิน ต้นทุน/กำไร", "คำนวณจากสินค้า ออเดอร์ และค่าใช้จ่ายจริง", "chart")}
      <form class="mobile-finance-form" id="settingsForm">
        <input name="daysPerUnit" type="hidden" value="${Math.max(1, Number(settings.followUpDaysPerUnit || 15))}">
        <div class="mobile-business-finance-grid">
          <article class="blue"><span>ยอดขายรวม</span><strong>${money(breakdown.sales)} บาท</strong></article>
          <article class="purple"><span>ต้นทุนสินค้า</span><strong>${money(breakdown.productCosts)} บาท</strong></article>
          <article class="orange"><span>ค่าใช้จ่ายเพิ่มเติม</span><strong id="additionalCostsTotal">${money(breakdown.additionalCosts)} บาท</strong></article>
          <article class="${breakdown.profitBeforeAds >= 0 ? "green" : "red"}"><span>กำไรก่อนค่าโฆษณา</span><strong>${money(breakdown.profitBeforeAds)} บาท</strong></article>
          <article class="blue"><span>ค่าโฆษณา</span><strong>${money(advertising.adCost)} บาท</strong></article>
          <article class="${advertising.profitAfterAds >= 0 ? "green" : "red"}"><span>กำไรสุทธิหลังโฆษณา</span><strong>${money(advertising.profitAfterAds)} บาท</strong></article>
        </div>

        <div class="mobile-finance-section-head">
          <div><h3>ต้นทุนสินค้า</h3><p>กำหนดต้นทุนต่อหน่วยและดูผลจากยอดขายจริง</p></div>
        </div>
        <div class="mobile-finance-product-list">
          ${products.map(product => {
            const cost = normalizeProductCostEntries(settings).find(item => item.id === product.id || item.name === product.name);
            const productOrders = orders.filter(order => normalizeProductName(order.items) === product.name);
            const productBreakdown = profitBreakdownForOrders(productOrders, settings);
            const sold = productOrders.reduce((sum, order) => sum + Number(order.jars || 0), 0);
            return `
              <article class="mobile-finance-product" data-product-cost-row data-id="${escapeHtml(cost?.id || product.id)}">
                <span class="mobile-business-product-thumb">${productImageMarkup(product.image, product.name, iconSvg("box"))}</span>
                <div class="mobile-finance-product-name">
                  <strong>${escapeHtml(product.name)}</strong>
                  <input name="productCostName" type="hidden" value="${escapeHtml(product.name)}">
                  <span>${money(sold)} ชิ้น · ${money(productOrders.length)} ออเดอร์</span>
                </div>
                <label><span>ต้นทุน/หน่วย</span><input name="productCostAmount" type="number" min="0" step="0.01" value="${Number(cost?.costPerJar ?? product.costPerItem ?? 0)}"></label>
                <input name="productCostEnabled" type="checkbox" checked hidden>
                <div class="mobile-finance-product-metrics">
                  <span>ยอดขาย <strong>${money(productBreakdown.sales)} บาท</strong></span>
                  <span>กำไรขั้นต้น <strong>${money(productBreakdown.sales - productBreakdown.productCosts)} บาท</strong></span>
                </div>
                <button class="button ghost compact-action" type="button" data-business-product="${escapeHtml(product.id)}">ดูรายละเอียดกำไร</button>
              </article>
            `;
          }).join("") || mobileBusinessEmpty("ยังไม่มีสินค้า", "เพิ่มสินค้า หรือบันทึกออเดอร์จริงก่อนกำหนดต้นทุน")}
        </div>

        <div class="mobile-finance-section-head">
          <div><h3>ค่าใช้จ่ายเพิ่มเติม</h3><p>เลือกวิธีคิดต่อออเดอร์ ต่อชิ้น หรือเปอร์เซ็นต์ยอดขาย</p></div>
          <button class="button primary compact-action mobile-finance-add-expense" type="button" data-add-additional-cost>+ Add</button>
        </div>
        <div class="mobile-finance-helper-card">
          <strong>ค่าใช้จ่ายเพิ่มเติมใช้กับสินค้าทุกตัวที่เปิดใช้งาน</strong>
          <span>เช่น ค่าแพ็กสินค้า ค่าแรง ค่าอุปกรณ์ ค่าธรรมเนียม หรือค่าใช้จ่ายอื่น ๆ ที่เกี่ยวข้องกับสินค้า</span>
          <small>ตัวอย่าง: ตั้งค่า 2% → สินค้าที่ขาย 1,000 บาท จะเพิ่มค่าใช้จ่าย 20 บาท</small>
        </div>
        <div class="settings-cost-list mobile-finance-expense-list" id="additionalCostList">${settingsAdditionalCostRows(settings)}</div>
        <div class="mobile-finance-formula-note">กำไรก่อนโฆษณา = ยอดขาย - ต้นทุนสินค้า - ค่าใช้จ่ายเพิ่มเติม · กำไรหลังโฆษณา = กำไรก่อนโฆษณา - ค่าโฆษณา</div>
        <button class="button primary mobile-business-full-button settings-save-button" type="submit" data-settings-save>บันทึกต้นทุนและค่าใช้จ่าย</button>
      </form>
    </section>
  `;
}

function adProductOptions(selectedId = "", selectedName = "") {
  const products = productRowsData();
  const options = products.map(product => `
    <option value="${escapeHtml(product.id)}" ${product.id === selectedId || (!selectedId && product.name === selectedName) ? "selected" : ""}>
      ${escapeHtml(product.name)}
    </option>
  `);
  if (selectedName && !products.some(product => product.id === selectedId || product.name === selectedName)) {
    options.unshift(`<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedName)}</option>`);
  }
  return options.join("");
}

function adPlatformOptions(selectedId = "", selectedName = "") {
  const platforms = normalizeAdPlatforms();
  const options = platforms.filter(platform => platform.enabled || platform.id === selectedId).map(platform => `
    <option value="${escapeHtml(platform.id)}" ${platform.id === selectedId ? "selected" : ""}>
      ${escapeHtml(platform.name)}${platform.enabled ? "" : " (ปิดใช้งาน)"}
    </option>
  `);
  if (selectedName && !platforms.some(platform => platform.id === selectedId)) {
    options.unshift(`<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(selectedName)} (เดิม)</option>`);
  }
  return options.join("");
}

function renderMobileBusinessAdvertising() {
  const records = normalizeAdCostRecords()
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const platforms = normalizeAdPlatforms();
  const editing = records.find(record => record.id === app.editingAdCostId);
  const editingPlatform = platforms.find(platform => platform.id === app.editingAdPlatformId);
  const defaultProduct = productRowsData()[0] || {};
  const defaultPlatform = platforms.find(platform => platform.enabled) || platforms[0] || {};
  const formRecord = editing || {
    date: todayISO(),
    productId: defaultProduct.id || "",
    productName: defaultProduct.name || "",
    platformId: defaultPlatform.id || "",
    platformName: defaultPlatform.name || "",
    campaignName: "",
    costMode: "fixed_amount",
    value: 0,
    enabled: true,
    note: ""
  };
  const todayPerformance = marketingPerformanceForPeriod({ date: todayISO() });
  return `
    <section class="mobile-business-page mobile-business-subpage mobile-advertising-page">
      ${mobileBusinessHeader("ค่าโฆษณา", "จัดการค่าโฆษณาตามวันที่ สินค้า และแพลตฟอร์ม", "megaphone")}
      <div class="mobile-business-finance-grid mobile-ad-summary-grid">
        <article class="blue"><span>ใช้ไปวันนี้</span><strong>฿ ${money(todayPerformance.adCost)}</strong></article>
        <article class="purple"><span>ROAS วันนี้</span><strong>${marketingNumber(todayPerformance.roas)}</strong></article>
      </div>

      <form id="adCostForm" class="mobile-business-form mobile-ad-form">
        <div class="mobile-finance-section-head">
          <div><h3>${editing ? "แก้ไขรายการค่าโฆษณา" : "เพิ่มค่าโฆษณา"}</h3><p>เพิ่มได้ไม่จำกัด และคำนวณแยกตามวันที่</p></div>
          ${editing ? `<button class="button ghost compact-action" type="button" data-cancel-ad-cost>ยกเลิก</button>` : ""}
        </div>
        <input name="id" type="hidden" value="${escapeHtml(editing?.id || "")}">
        <div class="mobile-ad-form-grid">
          <label>วันที่<input name="date" type="date" required value="${escapeHtml(formRecord.date)}"></label>
          <label>สินค้า<select name="productId" required>${adProductOptions(formRecord.productId, formRecord.productName)}</select></label>
          <label>แพลตฟอร์ม<select name="platformId" required>${adPlatformOptions(formRecord.platformId, formRecord.platformName)}</select></label>
          <label>ชื่อแคมเปญ (ไม่บังคับ)<input name="campaignName" value="${escapeHtml(formRecord.campaignName)}" placeholder="เช่น Retargeting กรกฎาคม"></label>
          <label>วิธีคิด
            <select name="costMode">
              ${[
                ["fixed_amount", "จำนวนเงินคงที่"],
                ["percent_sales", "% ของยอดขาย"],
                ["cost_per_order", "ค่าใช้จ่ายต่อออเดอร์"]
              ].map(([value, label]) => `<option value="${value}" ${formRecord.costMode === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </label>
          <label>ค่าใช้จ่าย<input name="value" type="number" min="0" step="0.01" required value="${Number(formRecord.value || 0)}"></label>
          <label class="mobile-ad-note">หมายเหตุ (ไม่บังคับ)<textarea name="note" rows="2">${escapeHtml(formRecord.note)}</textarea></label>
          <label class="settings-switch mobile-ad-enabled"><span>เปิดใช้งาน</span><input name="enabled" type="checkbox" ${formRecord.enabled ? "checked" : ""}><span class="settings-switch-ui"></span></label>
        </div>
        <button class="button primary mobile-business-full-button" type="submit">${editing ? "บันทึกการแก้ไข" : "เพิ่มรายการค่าโฆษณา"}</button>
      </form>

      <section class="mobile-ad-record-section">
        <div class="mobile-finance-section-head"><div><h3>รายการค่าโฆษณา</h3><p>${money(records.length)} รายการ</p></div></div>
        <div class="mobile-ad-record-list">
          ${records.map(record => {
            const calculated = adCostForRecord(record);
            return `
              <article class="mobile-ad-record ${record.enabled ? "" : "is-disabled"}">
                <div class="mobile-ad-record-head">
                  <span class="mobile-ad-platform-icon">${iconSvg("megaphone")}</span>
                  <span><strong>${escapeHtml(record.platformName)}</strong><small>${formatDate(record.date)} · ${escapeHtml(record.productName)}</small></span>
                  <b>฿ ${money(calculated)}</b>
                </div>
                <div class="mobile-ad-record-meta">
                  <span>${escapeHtml(adCostModeLabel(record.costMode))}: ${marketingNumber(record.value)}</span>
                  ${record.campaignName ? `<span>แคมเปญ: ${escapeHtml(record.campaignName)}</span>` : ""}
                  ${record.note ? `<span>${escapeHtml(record.note)}</span>` : ""}
                </div>
                <div class="mobile-ad-record-actions">
                  <button class="button ghost compact-action" type="button" data-toggle-ad-cost="${escapeHtml(record.id)}">${record.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button>
                  <button class="button ghost compact-action" type="button" data-edit-ad-cost="${escapeHtml(record.id)}">แก้ไข</button>
                  <button class="button danger compact-action" type="button" data-delete-ad-cost="${escapeHtml(record.id)}">ลบ</button>
                </div>
              </article>
            `;
          }).join("") || mobileBusinessEmpty("ยังไม่มีค่าโฆษณา", "เพิ่มรายการแรกเพื่อเริ่มวิเคราะห์ Marketing Performance")}
        </div>
      </section>

      <section class="mobile-ad-platform-section">
        <div class="mobile-finance-section-head"><div><h3>จัดการแพลตฟอร์ม</h3><p>เพิ่ม แก้ไข ลบ เปิดหรือปิดใช้งานได้</p></div></div>
        <form id="adPlatformForm" class="mobile-ad-platform-form">
          <input name="id" type="hidden" value="${escapeHtml(editingPlatform?.id || "")}">
          <input name="name" required value="${escapeHtml(editingPlatform?.name || "")}" placeholder="ชื่อแพลตฟอร์ม">
          <label class="settings-switch compact"><input name="enabled" type="checkbox" ${editingPlatform?.enabled !== false ? "checked" : ""}><span class="settings-switch-ui"></span></label>
          <button class="button primary compact-action" type="submit">${editingPlatform ? "บันทึก" : "เพิ่ม"}</button>
          ${editingPlatform ? `<button class="button ghost compact-action" type="button" data-cancel-ad-platform>ยกเลิก</button>` : ""}
        </form>
        <div class="mobile-ad-platform-list">
          ${platforms.map(platform => `
            <div class="${platform.enabled ? "" : "is-disabled"}">
              <span><strong>${escapeHtml(platform.name)}</strong><small>${platform.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}</small></span>
              <button class="button ghost compact-action" type="button" data-toggle-ad-platform="${escapeHtml(platform.id)}">${platform.enabled ? "ปิด" : "เปิด"}</button>
              <button class="button ghost compact-action" type="button" data-edit-ad-platform="${escapeHtml(platform.id)}">แก้ไข</button>
              <button class="button danger compact-action" type="button" data-delete-ad-platform="${escapeHtml(platform.id)}">ลบ</button>
            </div>
          `).join("")}
        </div>
      </section>
    </section>
  `;
}

function marketingMetricCard(label, value, tone = "blue") {
  return `<article class="${escapeHtml(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function marketingPerformanceRows(rows, type) {
  const labelKey = type === "product" ? "productName" : "platformName";
  return rows.map(row => `
    <div class="mobile-marketing-table-row">
      <strong>${escapeHtml(row[labelKey])}</strong>
      <span><small>ยอดขาย</small>฿ ${money(row.sales)}</span>
      <span><small>ค่าโฆษณา</small>฿ ${money(row.adCost)}</span>
      <span><small>กำไรหลัง Ads</small>฿ ${money(row.profitAfterAds)}</span>
      <span><small>ROAS</small>${marketingNumber(row.roas)}</span>
    </div>
  `).join("") || `<div class="mobile-report-empty">ยังไม่มีข้อมูลในช่วงเวลานี้</div>`;
}

function renderMobileBusinessMarketingPerformance() {
  app.marketingDate = app.marketingDate || todayISO();
  app.marketingMonth = app.marketingMonth || app.marketingDate.slice(0, 7);
  const today = marketingPerformanceForPeriod({ date: app.marketingDate });
  const month = marketingPerformanceForPeriod({ month: app.marketingMonth });
  return `
    <section class="mobile-business-page mobile-business-subpage mobile-marketing-page">
      ${mobileBusinessHeader("Dashboard Marketing Performance", "ดูภาพรวมประสิทธิภาพการตลาดโดยไม่เปลี่ยนกำไรเดิม", "chart")}
      <div class="mobile-marketing-filters">
        <label>วันที่<input data-marketing-date type="date" value="${escapeHtml(app.marketingDate)}"></label>
        <label>เดือน<input data-marketing-month type="month" value="${escapeHtml(app.marketingMonth)}"></label>
      </div>
      <h3 class="mobile-business-inner-title">ภาพรวมวันที่เลือก</h3>
      <div class="mobile-business-finance-grid mobile-marketing-kpis">
        ${marketingMetricCard("ค่าโฆษณา", `฿ ${money(today.adCost)}`, "blue")}
        ${marketingMetricCard("ยอดขาย", `฿ ${money(today.sales)}`, "green")}
        ${marketingMetricCard("กำไรก่อนโฆษณา", `฿ ${money(today.profitBeforeAds)}`, "purple")}
        ${marketingMetricCard("กำไรหลังโฆษณา", `฿ ${money(today.profitAfterAds)}`, today.profitAfterAds >= 0 ? "green" : "red")}
        ${marketingMetricCard("ROAS", marketingNumber(today.roas), "purple")}
        ${marketingMetricCard("ค่าโฆษณา / ยอดขาย", `${marketingNumber(today.adCostPercent)}%`, "orange")}
        ${marketingMetricCard("ค่าโฆษณา / ออเดอร์", `฿ ${money(today.costPerOrder)}`, "blue")}
        ${marketingMetricCard("จำนวนออเดอร์", money(today.orderCount), "orange")}
      </div>
      <h3 class="mobile-business-inner-title">ภาพรวมเดือนที่เลือก</h3>
      <div class="mobile-business-finance-grid mobile-marketing-kpis">
        ${marketingMetricCard("ค่าโฆษณาเดือนนี้", `฿ ${money(month.adCost)}`, "blue")}
        ${marketingMetricCard("ยอดขายเดือนนี้", `฿ ${money(month.sales)}`, "green")}
        ${marketingMetricCard("กำไรก่อนโฆษณา", `฿ ${money(month.profitBeforeAds)}`, "purple")}
        ${marketingMetricCard("กำไรหลังโฆษณา", `฿ ${money(month.profitAfterAds)}`, month.profitAfterAds >= 0 ? "green" : "red")}
        ${marketingMetricCard("ROAS เดือน", marketingNumber(month.roas), "purple")}
        ${marketingMetricCard("ค่าโฆษณา %", `${marketingNumber(month.adCostPercent)}%`, "orange")}
        ${marketingMetricCard("ค่าใช้จ่ายต่อออเดอร์", `฿ ${money(month.costPerOrder)}`, "blue")}
      </div>
      <section class="mobile-marketing-table">
        <div class="mobile-finance-section-head"><div><h3>ประสิทธิภาพรายสินค้า</h3><p>ยอดขาย กำไร และค่าโฆษณาแยกตามสินค้า</p></div></div>
        ${marketingPerformanceRows(month.productPerformance, "product")}
      </section>
      <section class="mobile-marketing-table">
        <div class="mobile-finance-section-head"><div><h3>ประสิทธิภาพรายแพลตฟอร์ม</h3><p>กระจายยอดขายตามสัดส่วนค่าโฆษณาของสินค้าและวันเดียวกัน</p></div></div>
        ${marketingPerformanceRows(month.platformPerformance, "platform")}
      </section>
    </section>
  `;
}

function renderMobileBusinessSecurity() {
  const mobile = isMobileViewport();
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("ความปลอดภัย", "จัดการความปลอดภัยของบัญชีและการเข้าสู่ระบบ", "flag")}
      ${renderSecurityCenter({ mobile })}
    </section>
  `;
}

function renderMobileBusinessRoles() {
  const users = app.data.users || [];
  const editingUser = app.editingUserId && app.editingUserId !== "__new"
    ? users.find(user => user.id === app.editingUserId)
    : null;
  if (app.mobileBusinessPage === "userEditor") {
    return `
      <section class="mobile-business-page mobile-business-subpage">
        <header class="mobile-business-subhead mobile-user-editor-subhead">
          <button class="mobile-business-back" type="button" data-user-editor-back aria-label="กลับรายชื่อผู้ใช้งาน">${iconSvg("arrow")}</button>
          <div><h2>${app.editingUserId === "__new" ? "เพิ่มผู้ใช้งาน" : "แก้ไขผู้ใช้งาน"}</h2><p>ข้อมูลสำหรับเข้าใช้ระบบ</p></div>
        </header>
        ${userEditorMarkup(editingUser, { mobile: true })}
      </section>
    `;
  }
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("การจัดการสิทธิ์ / ผู้ใช้งาน", "ผู้ใช้งานและสิทธิ์ที่มีอยู่ในระบบ", "users")}
      <button class="button primary mobile-business-full-button" type="button" data-add-user>${iconSvg("users")} เพิ่มผู้ใช้งาน</button>
      <div class="mobile-business-user-list">
        ${users.map(user => `
          <button class="mobile-business-user" type="button" data-mobile-edit-user="${escapeHtml(user.id)}">
            <span class="mobile-business-avatar">${escapeHtml(initials(user.name))}</span>
            <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.username || "ไม่มีชื่อเข้าใช้งาน")}</small><em>${escapeHtml(userRoleLabel(user.role))}</em></span>
            <b>${userStatusLabel(user)}</b>
          </button>
        `).join("") || mobileBusinessEmpty("ยังไม่มีผู้ใช้งาน", "ไม่พบข้อมูลผู้ใช้จากระบบ")}
      </div>
    </section>
  `;
}

function renderMobileBusinessGoals() {
  const selectedMonth = String(app.data.summary?.selectedDate || todayISO()).slice(0, 7);
  const monthSales = (app.data.orders || []).filter(order => String(order.date || "").startsWith(selectedMonth)).reduce((sum, order) => sum + Number(order.amount || 0), 0);
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("เป้าหมายยอดขาย", "ติดตามยอดขายจากออเดอร์จริงในเดือนปัจจุบัน", "flag")}
      <article class="mobile-business-goal-current"><span>ยอดขายเดือนนี้</span><strong>${money(monthSales)} บาท</strong></article>
      ${mobileBusinessEmpty("ยังไม่ได้ตั้งเป้าหมายยอดขาย", "ระบบยังไม่มีแหล่งข้อมูลเป้าหมาย จึงไม่สร้างตัวเลขเป้าหมายจำลอง")}
    </section>
  `;
}

function renderMobileBusinessAnalytics() {
  const orders = app.data.orders || [];
  const customers = app.data.customers || [];
  const sales = orders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const topProducts = groupedProducts().slice(0, 5);
  const averageOrder = orders.length ? sales / orders.length : 0;
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("วิเคราะห์ธุรกิจ", "ภาพรวมจากออเดอร์ ลูกค้า และสินค้าจริง", "chart")}
      <div class="mobile-business-kpis three">
        <article class="purple"><span>ยอดขายรวม</span><strong>${money(sales)}</strong><small>บาท</small></article>
        <article class="blue"><span>ยอดเฉลี่ยต่อออเดอร์</span><strong>${money(averageOrder)}</strong><small>บาท</small></article>
        <article class="green"><span>ลูกค้าซื้อซ้ำ</span><strong>${money(customers.filter(customer => Number(customer.purchaseCount || 0) > 1).length)}</strong><small>ราย</small></article>
      </div>
      <h3 class="mobile-business-inner-title">สินค้าขายดี</h3>
      <div class="mobile-business-ranking">
        ${topProducts.map((product, index) => `<div><b>${index + 1}</b><span><strong>${escapeHtml(product.name)}</strong><small>${money(product.soldCount)} ชิ้น</small></span><em>${money(product.revenue)} บาท</em></div>`).join("") || mobileBusinessEmpty("ยังไม่มีข้อมูลวิเคราะห์", "บันทึกออเดอร์ก่อนเพื่อดูสินค้าขายดี")}
      </div>
    </section>
  `;
}

function renderMobileBusinessImport() {
  return `
    <section class="mobile-business-page mobile-business-subpage mobile-business-import-page">
      ${mobileBusinessHeader("Import Orders", "นำเข้าออเดอร์จากไฟล์ CSV หรือ Excel", "upload")}
      ${renderImportCenter({ embedded: true })}
    </section>
  `;
}

function renderMobileBusinessBackup() {
  return `
    <section class="mobile-business-page mobile-business-subpage">
      ${mobileBusinessHeader("สำรองข้อมูล", "ดาวน์โหลดข้อมูลธุรกิจล่าสุดจากระบบ", "clipboard")}
      <article class="mobile-business-action-card">
        ${mobileBusinessIcon("clipboard")}
        <h3>ข้อมูลพร้อมสำรอง</h3>
        <div class="mobile-business-info-list">
          <div><span>ออเดอร์</span><strong>${money((app.data.orders || []).length)} รายการ</strong></div>
          <div><span>ลูกค้า</span><strong>${money((app.data.customers || []).length)} ราย</strong></div>
          <div><span>สินค้า</span><strong>${money(productRowsData().length)} รายการ</strong></div>
          <div><span>ผู้ใช้งาน</span><strong>${money((app.data.users || []).length)} ราย</strong></div>
        </div>
        <a class="button primary mobile-business-full-button" href="/api/backup" target="_blank" rel="noreferrer">ดาวน์โหลดข้อมูลสำรอง</a>
      </article>
      ${mobileBusinessEmpty("ยังไม่มีประวัติการสำรองข้อมูล", "ระบบปัจจุบันมีเฉพาะการดาวน์โหลดข้อมูลล่าสุด")}
    </section>
  `;
}

function renderMobileBusinessManagement() {
  const renderers = {
    main: renderMobileBusinessMain,
    setupWizard: renderMobileSetupWizard,
    customers: renderMobileBusinessCustomers,
    customerDetail: renderMobileBusinessCustomerDetail,
    products: renderMobileBusinessProducts,
    productDetail: renderMobileBusinessProductDetail,
    system: renderMobileBusinessSystem,
    notifications: renderMobileBusinessNotifications,
    finance: renderMobileBusinessFinance,
    advertising: renderMobileBusinessAdvertising,
    marketingPerformance: renderMobileBusinessMarketingPerformance,
    security: renderMobileBusinessSecurity,
    users: renderMobileBusinessRoles,
    roles: renderMobileBusinessRoles,
    userEditor: renderMobileBusinessRoles,
    goals: renderMobileBusinessGoals,
    analytics: renderMobileBusinessAnalytics,
    import: renderMobileBusinessImport,
    backup: renderMobileBusinessBackup
  };
  els.content.innerHTML = (renderers[app.mobileBusinessPage] || renderers.main)();
}

function renderSettings() {
  renderMobileBusinessManagement();
}

function setBusinessManagementPage(page, options = {}) {
  const nextPage = page || "main";
  const previousPage = app.mobileBusinessPage || "main";
  if (previousPage === "main" && nextPage !== "main") saveBusinessManagementScrollPosition();
  const shouldRestoreScroll = previousPage !== "main" && nextPage === "main";
  app.mobileBusinessPage = nextPage;
  if (nextPage !== "security") app.securityDetailKey = "";
  renderSettings();
  if (!options.fromHistory) pushBusinessManagementHistory(nextPage, Boolean(options.replaceHistory));
  if (nextPage === "import" && !app.importWorker) {
    refreshImportJob().catch(error => showToast(error.message));
  }
  if (shouldRestoreScroll) restoreBusinessManagementScrollWhenReady();
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

function mobileOrderNumber(order) {
  const value = String(order?.orderNumber || order?.id || "-").replace(/^#/, "");
  return `#${value}`;
}

function mobileOrderDate(dateValue) {
  if (!dateValue) return "-";
  const [year, month, day] = String(dateValue).split("-");
  return `${String(day || "").padStart(2, "0")}/${String(month || "").padStart(2, "0")}/${String(year || "").slice(-2)}`;
}

function mobileOrderMoney(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function mobileOrderProductParts(order) {
  const values = [];
  const pushValue = value => {
    if (Array.isArray(value)) {
      value.forEach(pushValue);
      return;
    }
    if (value && typeof value === "object") {
      pushValue(value.productName || value.name || value.product || value.item || value.items || value.title);
      return;
    }
    const text = String(value || "").trim();
    if (!text) return;
    text
      .split(/[,،\n]+/)
      .map(part => part.trim())
      .filter(Boolean)
      .forEach(part => values.push(part));
  };
  pushValue(order?.items);
  if (!values.length) {
    [
      order?.product,
      order?.productName,
      order?.item,
      order?.name,
      order?.productTitle,
      order?.itemName
    ].forEach(pushValue);
  }
  const seen = new Set();
  const unique = values.filter(name => {
    const key = normalizeProductName(name).toLocaleLowerCase("th-TH");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length ? unique : ["Unknown Product"];
}

function mobileOrderProductSummary(order) {
  const products = normalizeProductRecords();
  const productByName = new Map(products.map(product => [
    normalizeProductName(product.name).toLocaleLowerCase("th-TH"),
    product
  ]));
  const names = mobileOrderProductParts(order);
  return `
    <span class="mobile-order-products" title="${escapeHtml(names.join(", "))}">
      ${names.map(name => {
        const product = productByName.get(normalizeProductName(name).toLocaleLowerCase("th-TH"));
        const image = normalizeProductImageSource(product?.image || "");
        return `
          <span class="mobile-order-product-chip">
            ${image ? `<span class="mobile-order-product-thumb" aria-hidden="true">${productImageMarkup(image, name, "", product?.id || "")}</span>` : ""}
            <span class="mobile-order-product-name">${escapeHtml(name)}</span>
          </span>
        `;
      }).join("")}
    </span>
  `;
}

function mobileOrderRows(selectedDate) {
  const q = app.ordersFilterQ.trim().toLowerCase();
  const rows = app.data.orders.filter(order => {
    const dateMatch = Boolean(q) || !app.mobileOrdersDateOnly || order.date === selectedDate;
    const textMatch = !q || [
      order.orderNumber,
      order.items,
      order.product,
      order.productName,
      order.item,
      order.productTitle,
      order.itemName,
      order.id,
      order.customerName,
      order.phone,
      order.alternatePhone,
      order.socialName,
      order.tags,
      order.note
    ].join(" ").toLowerCase().includes(q);
    return dateMatch && textMatch;
  });
  rows.sort((a, b) => {
    const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCompare !== 0) return app.mobileOrdersDescending ? -dateCompare : dateCompare;
    const numberCompare = compareOrderNumberAscending(a, b);
    return app.mobileOrdersDescending ? -numberCompare : numberCompare;
  });
  return rows;
}

function mobileOrderActionMenu(order) {
  if (app.mobileOrderMenuId !== order.id) return "";
  return `
    <div class="mobile-order-action-menu" data-mobile-order-menu>
      <button type="button" data-edit-order="${escapeHtml(order.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-.8 4 4-.8L19 7.4 16.6 5 4 16Z"/><path d="m14.8 6.8 2.4 2.4"/></svg>
        <span>แก้ไข</span>
      </button>
      <span class="mobile-order-menu-divider"></span>
      <button class="delete" type="button" data-delete-order="${escapeHtml(order.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        <span>ลบ</span>
      </button>
    </div>
  `;
}

function mobileOrdersScrollElement() {
  return document.querySelector(".mobile-orders-list");
}

function rememberMobileOrdersScrollPosition() {
  if (app.view !== "orders" || !isMobileViewport()) return;
  const list = mobileOrdersScrollElement();
  if (list) app.mobileOrdersScrollTop = list.scrollTop;
}

function restoreMobileOrdersScrollPosition() {
  if (app.view !== "orders" || !isMobileViewport()) return;
  const scrollTop = Number(app.mobileOrdersScrollTop || 0);
  const restore = () => {
    const list = mobileOrdersScrollElement();
    if (list) list.scrollTop = scrollTop;
  };
  restore();
  requestAnimationFrame(restore);
}

function closeMobileOrderActionMenu() {
  const menu = document.querySelector("[data-mobile-order-menu]");
  menu?.closest(".mobile-order-row")?.classList.remove("menu-open");
  menu?.remove();
  app.mobileOrderMenuId = "";
}

function toggleMobileOrderActionMenu(orderId, button) {
  rememberMobileOrdersScrollPosition();
  const shouldOpen = app.mobileOrderMenuId !== orderId;
  closeMobileOrderActionMenu();
  if (!shouldOpen) return;
  const order = app.data.orders.find(item => item.id === orderId);
  const row = button.closest(".mobile-order-row");
  if (!order || !row) return;
  app.mobileOrderMenuId = orderId;
  row.classList.add("menu-open");
  row.insertAdjacentHTML("beforeend", mobileOrderActionMenu(order));
  restoreMobileOrdersScrollPosition();
}

function renderMobileOrders(selectedDate) {
  const orders = mobileOrderRows(selectedDate);
  els.content.innerHTML = `
    <section class="mobile-orders-page">
      <div class="mobile-orders-toolbar">
        <label class="mobile-orders-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input data-order-filter="q" value="${escapeHtml(app.ordersFilterDraft)}" placeholder="ค้นหาออเดอร์, สินค้า, ลูกค้า, เบอร์โทร">
        </label>
        <button class="mobile-orders-filter" type="button" data-mobile-orders-filter>
          <span>ค้นหา</span>
        </button>
        <button class="mobile-orders-sort" type="button" data-mobile-orders-sort aria-label="${app.mobileOrdersDescending ? "เรียงจากเก่าไปใหม่" : "เรียงจากใหม่ไปเก่า"}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4v16"/><path d="m4 8 4-4 4 4"/><path d="M16 20V4"/><path d="m12 16 4 4 4-4"/></svg>
        </button>
      </div>

      <div class="mobile-orders-list-head" aria-hidden="true">
        <span>ลำดับ</span>
        <span>เลขออเดอร์</span>
        <span>ลูกค้า</span>
        <span>วันที่</span>
        <span>ยอดรวม</span>
        <span></span>
      </div>

      <div class="mobile-orders-list">
        ${orders.map((order, index) => {
          const customer = app.data.customers.find(item => item.id === order.customerId);
          const customerName = order.customerName || customer?.name || "ไม่ระบุชื่อลูกค้า";
          const phone = order.phone || customer?.phone || "-";
          return `
            <article class="mobile-order-row ${app.mobileOrderMenuId === order.id ? "menu-open" : ""}">
              <span class="mobile-order-sequence">${index + 1}</span>
              <strong class="mobile-order-number">${escapeHtml(mobileOrderNumber(order))}</strong>
              <span class="mobile-order-customer">
                <strong>${escapeHtml(customerName)}</strong>
                <small>${escapeHtml(phone)}</small>
                ${mobileOrderProductSummary(order)}
              </span>
              <span class="mobile-order-date">
                <strong>${escapeHtml(mobileOrderDate(order.date))}</strong>
                <small>${escapeHtml(String(order.time || "09:00").slice(0, 5))}</small>
              </span>
              <strong class="mobile-order-total">฿ ${escapeHtml(mobileOrderMoney(order.amount))}</strong>
              <button class="mobile-order-chevron" type="button" data-mobile-order-actions="${escapeHtml(order.id)}" aria-label="จัดการ ${escapeHtml(mobileOrderNumber(order))}">›</button>
              ${mobileOrderActionMenu(order)}
            </article>
          `;
        }).join("") || `<div class="mobile-orders-empty">ไม่พบออเดอร์ที่ค้นหา 🔍</div>`}
      </div>

      <button class="mobile-add-order" type="button" data-open-order aria-label="เพิ่มออเดอร์">
        <span>+</span>
        <small>เพิ่มออเดอร์</small>
      </button>
    </section>
  `;
}

function renderOrders() {
  const selectedDate = app.data.summary?.selectedDate || els.workDate.value || todayISO();
  if (isMobileViewport()) {
    renderMobileOrders(els.workDate.value || selectedDate);
    return;
  }
  const q = app.ordersFilterQ.trim().toLowerCase();
  if (app.ordersFilterDraft === "") app.ordersFilterDraft = app.ordersFilterQ;
  const orders = app.data.orders.filter(order => {
    const dateMatch = app.ordersShowAll || order.date === selectedDate;
    const textMatch = !q || [
      order.orderNumber,
      order.items,
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
  const totalUnits = orders.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const averageOrderValue = orders.length ? totalSales / orders.length : 0;
  els.content.innerHTML = `
    <section class="section saas-page orders-page">
      <div class="page-identity workspace-hero orders-hero">
        <div class="page-identity-copy">
          <span class="page-kicker">Order Management Workspace</span>
          <h2>${app.ordersShowAll ? "ออเดอร์ทั้งหมด" : `ออเดอร์วันที่ ${formatDate(selectedDate)}`}</h2>
          <p id="ordersCountText">${app.ordersShowAll ? `แสดง ${money(orders.length)} ออเดอร์จากทุกวัน` : `แสดง ${money(orders.length)} ออเดอร์จากวันที่เลือก`} พร้อมค้นหาและจัดการรายการในหน้าเดียว</p>
        </div>
        <div class="orders-header-actions">
          <label class="orders-show-all">
            <input type="checkbox" data-orders-show-all ${app.ordersShowAll ? "checked" : ""}>
            <span>แสดงทั้งหมด</span>
          </label>
          <button class="button primary" data-open-order>+ เพิ่มออเดอร์</button>
        </div>
      </div>
      <div class="workspace-stat-grid">
        ${metric("ยอดขายในมุมมองนี้", `${money(totalSales)} บาท`, "accent")}
        ${metric("จำนวนออเดอร์", `${money(orders.length)} รายการ`)}
        ${metric("จำนวนที่ขาย", `${money(totalUnits)} กระปุก`, "purple")}
        ${metric("ยอดเฉลี่ยต่อออเดอร์", `${money(averageOrderValue)} บาท`, "green")}
        ${metric("ช่องทางเด่น", topChannel, "green")}
      </div>
      <div class="panel stack panel-premium">
        <div class="section-title">
          <h2>ค้นหาและกรองออเดอร์</h2>
          <p>โฟกัสเฉพาะการค้นหา เพิ่ม และจัดการออเดอร์ในมุมมองนี้</p>
        </div>
        <div class="filters">
          <div class="orders-search-row">
            <input class="orders-search-input" data-order-filter="q" placeholder="ค้นหาเลขออเดอร์ สินค้า ชื่อ หรือเบอร์โทร" value="${escapeHtml(app.ordersFilterDraft)}">
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
        order.items,
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

function mobileOpportunityData() {
  const selectedDate = app.data.summary?.selectedDate || todayISO();
  const ordersToday = app.data.orders.filter(order => order.date === selectedDate);
  const closedCustomerIds = new Set(ordersToday.map(order => order.customerId));
  const rows = app.data.customers
    .filter(customer => customer.followUpDate)
    .map(customer => {
      const customerOrders = Array.isArray(customer.orders)
        ? customer.orders
        : app.data.orders.filter(order => order.customerId === customer.id);
      const lastOrder = customerOrders[customerOrders.length - 1] || null;
      const socialName = [...customerOrders].reverse().find(order => order.socialName)?.socialName || customer.socialName || "";
      return {
        customer,
        lastOrder,
        socialName,
        days: diffDaysISO(selectedDate, customer.followUpDate),
        value: Number(lastOrder?.amount || 0),
        closedToday: closedCustomerIds.has(customer.id)
      };
    });
  const dueRows = rows.filter(row => row.days <= 0);
  return {
    selectedDate,
    rows,
    dueRows,
    closedRevenue: ordersToday.reduce((sum, order) => sum + Number(order.amount || 0), 0),
    counts: {
      today: rows.filter(row => row.days === 0).length,
      overdue: rows.filter(row => row.days < 0).length,
      vip: rows.filter(row => row.customer.vipLevel && row.customer.vipLevel !== "NORMAL").length,
      closed: rows.filter(row => row.closedToday).length
    }
  };
}

function mobileOpportunityRows(model) {
  const query = app.mobileOpportunitySearch.trim().toLocaleLowerCase("th");
  const filtered = model.rows.filter(row => {
    const filterMatches = {
      today: row.days === 0,
      overdue: row.days < 0,
      vip: row.customer.vipLevel && row.customer.vipLevel !== "NORMAL",
      closed: row.closedToday
    }[app.mobileOpportunityFilter];
    if (!filterMatches) return false;
    if (!query) return true;
    const searchable = [
      row.customer.name,
      row.customer.phone,
      row.socialName,
      row.lastOrder?.orderNumber,
      row.lastOrder?.id,
      row.lastOrder?.items
    ].filter(Boolean).join(" ").toLocaleLowerCase("th");
    return searchable.includes(query);
  });
  return filtered.sort((a, b) => {
    if (app.mobileOpportunitySort === "value") {
      return b.value - a.value || a.days - b.days || a.customer.name.localeCompare(b.customer.name, "th");
    }
    return a.days - b.days || b.value - a.value || a.customer.name.localeCompare(b.customer.name, "th");
  });
}

function mobileOpportunityStatus(row) {
  if (row.days < 0) {
    return `<span class="mobile-opportunity-due-label overdue">เลยกำหนดแล้ว</span><strong class="overdue">${money(Math.abs(row.days))} วัน</strong>`;
  }
  if (row.days === 0) {
    return `<span class="mobile-opportunity-due-label today">ครบกำหนดวันนี้</span><strong>${money(row.days)} วัน</strong>`;
  }
  return `<span class="mobile-opportunity-due-label">ใกล้หมดในอีก</span><strong>${money(row.days)} วัน</strong>`;
}

function mobileOpportunityCustomerCard(row) {
  const { customer, lastOrder } = row;
  const orderNumber = lastOrder?.orderNumber || lastOrder?.id || "-";
  const lastPurchase = lastOrder
    ? `${lastOrder.items || "สินค้า"} ${money(lastOrder.jars || 0)} กระปุก (${formatShortDate(lastOrder.date)})`
    : "ยังไม่มีข้อมูลการซื้อ";
  return `
    <article class="mobile-opportunity-customer-card">
      <div class="mobile-opportunity-customer-main">
        <span class="mobile-opportunity-avatar" aria-hidden="true">${escapeHtml(initials(customer.name))}</span>
        <div class="mobile-opportunity-identity">
          <strong>${escapeHtml(customer.name || "-")}</strong>
          <span>${escapeHtml(customer.phone || "-")}${row.socialName ? ` · ${escapeHtml(row.socialName)}` : ""}</span>
          <small><b>#${escapeHtml(orderNumber)}</b> ${escapeHtml(lastPurchase)}</small>
        </div>
        <div class="mobile-opportunity-due">
          ${mobileOpportunityStatus(row)}
          <small>กำหนด ${formatShortDate(customer.followUpDate)}</small>
        </div>
        <div class="mobile-opportunity-value">
          <span>โอกาสปิดยอด</span>
          <strong>฿ ${money(row.value)}</strong>
        </div>
        <button class="mobile-opportunity-chevron" type="button" data-open-customer="${escapeHtml(customer.id)}" aria-label="ดูรายละเอียด ${escapeHtml(customer.name)}">${dashboardCardIcon("chevron")}</button>
      </div>
      <div class="mobile-opportunity-actions">
        ${customer.phone
          ? `<a class="call" href="tel:${escapeHtml(customer.phone)}">${iconSvg("chat")} โทร</a>`
          : `<button class="call" type="button" disabled>โทร</button>`}
        <button class="save" type="button" data-open-customer="${escapeHtml(customer.id)}">${iconSvg("clipboard")} บันทึกผล</button>
        <button class="reschedule" type="button" data-open-customer="${escapeHtml(customer.id)}">${dashboardCardIcon("calendar")} เลื่อนติดตาม</button>
      </div>
    </article>
  `;
}

function renderMobileOpportunities() {
  const model = mobileOpportunityData();
  if (!app.mobileOpportunityFilter) {
    app.mobileOpportunityFilter = model.counts.today > 0 ? "today" : "overdue";
  }
  const rows = mobileOpportunityRows(model);
  const totalOpportunity = model.dueRows.reduce((sum, row) => sum + row.value, 0);
  const filters = [
    ["today", "ควรโทรวันนี้", model.counts.today],
    ["overdue", "เลยกำหนดแล้ว", model.counts.overdue],
    ["vip", "ลูกค้า VIP", model.counts.vip],
    ["closed", "ปิดการขายแล้ว", model.counts.closed]
  ];
  return `
    <section class="mobile-opportunities-page" aria-label="โอกาสทำเงิน">
      <div class="mobile-opportunity-summary">
        <div class="purple">
          <span class="mobile-opportunity-summary-icon" aria-hidden="true">${iconSvg("users")}</span>
          <span>ลูกค้าที่ควรติดตาม</span>
          <strong>${money(model.dueRows.length)} <small>ราย</small></strong>
        </div>
        <div class="orange">
          <span class="mobile-opportunity-summary-icon" aria-hidden="true">${dashboardCardIcon("target")}</span>
          <span>โอกาสปิดยอดรวม</span>
          <strong>฿ ${money(totalOpportunity)}</strong>
        </div>
        <div class="green">
          <span class="mobile-opportunity-summary-icon" aria-hidden="true">${dashboardCardIcon("profit")}</span>
          <span>ยอดปิดได้แล้ววันนี้</span>
          <strong>฿ ${money(model.closedRevenue)}</strong>
        </div>
      </div>

      <div class="mobile-opportunity-status-grid">
        ${filters.map(([id, label, count], index) => `
          <button class="tone-${index + 1}" type="button" data-mobile-opportunity-filter="${id}">
            <span class="mobile-opportunity-status-icon" aria-hidden="true">${[
              iconSvg("chat"),
              dashboardCardIcon("calendar"),
              iconSvg("stars"),
              dashboardCardIcon("bag")
            ][index]}</span>
            <span>${label}</span>
            <strong>${money(count)} <small>ราย</small></strong>
          </button>
        `).join("")}
      </div>

      <form class="mobile-opportunity-search-row" data-mobile-opportunity-search>
        <label>
          <span aria-hidden="true">${dashboardCardIcon("search")}</span>
          <input name="q" value="${escapeHtml(app.mobileOpportunitySearchDraft)}" placeholder="ค้นหาออเดอร์, ลูกค้า, เบอร์โทร" autocomplete="off">
        </label>
        <button class="mobile-opportunity-search-button" type="submit">ค้นหา</button>
        <button class="mobile-opportunity-sort-button ${app.mobileOpportunitySort === "value" ? "value" : ""}" type="button" data-mobile-opportunity-sort aria-label="เรียงตาม${app.mobileOpportunitySort === "urgency" ? "มูลค่า" : "ความเร่งด่วน"}" title="ตอนนี้เรียงตาม${app.mobileOpportunitySort === "urgency" ? "ความเร่งด่วน" : "มูลค่า"}">${dashboardCardIcon("sort")}</button>
      </form>

      <div class="mobile-opportunity-filter-row" role="tablist" aria-label="ตัวกรองโอกาสทำเงิน">
        ${filters.map(([id, label, count]) => `
          <button class="${app.mobileOpportunityFilter === id ? "active" : ""}" type="button" role="tab" aria-selected="${app.mobileOpportunityFilter === id}" data-mobile-opportunity-filter="${id}">
            ${label} (${money(count)})
          </button>
        `).join("")}
      </div>

      <div class="mobile-opportunity-list-heading">
        <strong><span aria-hidden="true">${iconSvg("chat")}</span> ${escapeHtml(filters.find(([id]) => id === app.mobileOpportunityFilter)?.[1] || "ลูกค้าที่ควรติดตาม")}</strong>
        <span>${money(rows.length)} ราย</span>
      </div>
      <div class="mobile-opportunity-customer-list">
        ${rows.length
          ? rows.map(mobileOpportunityCustomerCard).join("")
          : `<div class="mobile-opportunity-empty">ไม่พบลูกค้าจากข้อมูลจริงตามตัวกรองนี้</div>`}
      </div>
    </section>
  `;
}

function renderOpportunities() {
  els.content.innerHTML = renderMobileOpportunities();
  if (isMobileViewport()) return;
  const cards = opportunityCardsData();
  const list = els.content.querySelector(".mobile-opportunity-customer-list");
  if (!list) return;
  list.insertAdjacentHTML("afterend", `
    <section class="desktop-opportunity-shortcuts" aria-label="ทางลัดโอกาสทำเงิน">
      ${cards.map(card => `
        <button class="desktop-opportunity-shortcut" type="button" data-view-shortcut="${escapeHtml(card.targetView)}">
          <span class="tag">${money(card.count)} รายการ</span>
          <strong>${escapeHtml(card.title)}</strong>
          <small>${escapeHtml(card.description)}</small>
          <b>${money(card.revenue)} บาท</b>
        </button>
      `).join("")}
    </section>
  `);
}

function renderProducts() {
  const products = productRowsData();
  const totalRevenue = products.reduce((sum, product) => sum + Number(product.revenue || 0), 0);
  const totalSold = products.reduce((sum, product) => sum + Number(product.soldCount || 0), 0);
  const totalOrders = products.reduce((sum, product) => sum + Number(product.orderCount || 0), 0);
  const totalStock = products.reduce((sum, product) => sum + Number(product.stockQuantity || 0), 0);
  els.content.innerHTML = `
    <section class="section saas-page products-page">
      <div class="page-identity workspace-hero products-hero products-hero-compact">
        <div class="products-hero-copy">
          <span class="page-kicker">ภาพรวมสินค้า</span>
          <h2>สินค้า</h2>
          <p>จัดการสินค้าและติดตามสต๊อกทั้งหมด</p>
        </div>
        <div class="products-hero-stats">
          ${metric("ยอดขายรวม", `${money(totalRevenue)} บาท`)}
          ${metric("ขายแล้ว", money(totalSold))}
          ${metric("ออเดอร์", money(totalOrders))}
          ${metric("สต๊อกรวม", money(totalStock))}
          <button class="button primary products-add-button" type="button" data-add-product>+ เพิ่มสินค้า</button>
        </div>
      </div>
      <div class="panel stack panel-premium products-workspace">
        <div class="products-toolbar">
          <div class="products-toolbar-left">
            <input class="orders-search-input" data-products-filter="q" placeholder="ค้นหาสินค้า..." value="${escapeHtml(app.productsFilterQ)}">
            <select data-products-filter="status">
              <option value="">ทั้งหมด</option>
              ${["พร้อมขาย", "ใกล้หมด", "เหลือน้อย", "ปิดการขาย"].map(status => `<option value="${escapeHtml(status)}" ${app.productsFilterStatus === status ? "selected" : ""}>${escapeHtml(status)}</option>`).join("")}
            </select>
          </div>
          <button class="button ghost" type="button" data-products-filter-reset>ล้างตัวกรอง</button>
        </div>
        <div class="workspace-table-wrap mobile-stack-wrap">
          <table class="workspace-table mobile-stack-table products-table">
            <thead>
              <tr>
                <th>สินค้า</th>
                <th>ยอดขาย</th>
                <th>ขายแล้ว</th>
                <th>ออเดอร์</th>
                <th>สต๊อก</th>
                <th>ติดตามลูกค้า</th>
                <th>สถานะ</th>
                <th>จัดการ</th>
              </tr>
            </thead>
            <tbody>
              ${products.map(product => `
                <tr data-product-id="${escapeHtml(product.id)}">
                  <td data-label="สินค้า">
                    <div class="table-identity product-identity">
                      <span class="product-thumb">${productImageMarkup(product.image, product.name, escapeHtml(initials(product.name)))}</span>
                      <span>
                        <strong>${escapeHtml(product.name)}</strong>
                        <small>${escapeHtml(product.sku || "ยังไม่มี SKU")} · ${money(product.salePrice)} บาท</small>
                      </span>
                    </div>
                  </td>
                  <td data-label="ยอดขาย"><strong>${money(product.revenue)} บาท</strong></td>
                  <td data-label="ขายแล้ว">${money(product.soldCount)} ชิ้น</td>
                  <td data-label="ออเดอร์">${money(product.orderCount)}</td>
                  <td data-label="สต๊อก"><strong>${money(product.stockQuantity)} ชิ้น</strong></td>
                  <td data-label="ติดตามลูกค้า">
                    <div class="product-followup-cell">
                      <span class="tag">${product.followUpEnabled ? `${money(product.followUpDays)} วัน` : "ปิด"}</span>
                      <small>${escapeHtml(product.followUpRule || "1 ชิ้น = 15 วัน")}</small>
                    </div>
                  </td>
                  <td data-label="สถานะ"><span class="badge ${product.computedStatus === "พร้อมขาย" ? "vip" : product.computedStatus === "ใกล้หมด" ? "risk" : product.computedStatus === "เหลือน้อย" ? "lost" : "normal"}">${escapeHtml(product.computedStatus)}</span></td>
                  <td data-label="จัดการ">
                    <div class="table-actions">
                      <button class="button ghost compact-action" type="button" data-edit-product="${escapeHtml(product.id)}">✎</button>
                      <button class="button ghost compact-action" type="button" data-product-details="${escapeHtml(product.id)}">⋯</button>
                      <button class="button danger compact-action" type="button" data-archive-product="${escapeHtml(product.id)}">🗑</button>
                    </div>
                  </td>
                </tr>
              `).join("") || `<tr><td colspan="8"><div class="empty-state">ยังไม่มีข้อมูลสินค้า</div></td></tr>`}
            </tbody>
          </table>
        </div>
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

function mobileAnalyticsIndex() {
  const orders = app.data?.orders || [];
  const customers = app.data?.customers || [];
  const cached = app.mobileAnalyticsIndex;
  if (cached?.orders === orders && cached?.customers === customers) return cached;
  const ordersByDate = new Map();
  const ordersByMonth = new Map();
  for (const order of orders) {
    const date = String(order.date || "");
    const month = monthKey(date);
    if (!ordersByDate.has(date)) ordersByDate.set(date, []);
    if (!ordersByMonth.has(month)) ordersByMonth.set(month, []);
    ordersByDate.get(date).push(order);
    ordersByMonth.get(month).push(order);
  }
  app.mobileAnalyticsIndex = { orders, customers, ordersByDate, ordersByMonth };
  return app.mobileAnalyticsIndex;
}

function desktopAnalyticsIndex() {
  const orders = app.data?.orders || [];
  const customers = app.data?.customers || [];
  const cached = app.desktopAnalyticsIndex;
  if (cached?.orders === orders && cached?.customers === customers) return cached;
  const ordersByDate = new Map();
  const ordersByMonth = new Map();
  for (const order of orders) {
    const date = String(order.date || "");
    const month = monthKey(date);
    if (!ordersByDate.has(date)) ordersByDate.set(date, []);
    if (!ordersByMonth.has(month)) ordersByMonth.set(month, []);
    ordersByDate.get(date).push(order);
    ordersByMonth.get(month).push(order);
  }
  const customerCounts = {
    newCustomers: 0,
    vip: 0,
    vvip: 0,
    superVip: 0,
    atRisk: 0,
    lost: 0
  };
  for (const customer of customers) {
    if (customer.status === "NEW") customerCounts.newCustomers += 1;
    if (customer.vipLevel === "VIP") customerCounts.vip += 1;
    if (customer.vipLevel === "VVIP") customerCounts.vvip += 1;
    if (customer.vipLevel === "SUPER VIP") customerCounts.superVip += 1;
    if (customer.status === "AT RISK") customerCounts.atRisk += 1;
    if (customer.status === "LOST") customerCounts.lost += 1;
  }
  app.desktopAnalyticsIndex = { orders, customers, ordersByDate, ordersByMonth, customerCounts };
  return app.desktopAnalyticsIndex;
}

function refreshDesktopDateSensitiveCustomers(selectedDate) {
  if (!app.data?.customers) return;
  for (const customer of app.data.customers) {
    const overdueDays = customer.followUpDate ? diffDaysISO(customer.followUpDate, selectedDate) : 0;
    let status = Number(customer.purchaseCount || 0) <= 1 ? "NEW" : "NORMAL";
    if (customer.vipLevel && customer.vipLevel !== "NORMAL") status = customer.vipLevel;
    if (overdueDays > 90) status = "LOST";
    else if (overdueDays > 30) status = "AT RISK";
    customer.overdueDays = overdueDays;
    customer.status = status;
  }
  app.desktopAnalyticsIndex = null;
}

function buildLocalSummary(selectedDate = els.workDate.value || todayISO()) {
  const summaryDate = selectedDate || todayISO();
  const index = isMobileViewport() ? mobileAnalyticsIndex() : desktopAnalyticsIndex();
  const customerCounts = index?.customerCounts || {};
  const todayOrders = index?.ordersByDate.get(summaryDate) || app.data.orders.filter(order => order.date === summaryDate);
  const monthOrders = index?.ordersByMonth.get(monthKey(summaryDate)) || app.data.orders.filter(order => monthKey(order.date) === monthKey(summaryDate));
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
    newCustomers: customerCounts.newCustomers ?? app.data.customers.filter(customer => customer.status === "NEW").length,
    vip: customerCounts.vip ?? app.data.customers.filter(customer => customer.vipLevel === "VIP").length,
    vvip: customerCounts.vvip ?? app.data.customers.filter(customer => customer.vipLevel === "VVIP").length,
    superVip: customerCounts.superVip ?? app.data.customers.filter(customer => customer.vipLevel === "SUPER VIP").length,
    atRisk: customerCounts.atRisk ?? app.data.customers.filter(customer => customer.status === "AT RISK").length,
    lost: customerCounts.lost ?? app.data.customers.filter(customer => customer.status === "LOST").length,
    dueToday: dueCustomers.length,
    dueByPriority: {
      "SUPER VIP": dueCustomers.filter(customer => customer.vipLevel === "SUPER VIP").length,
      VVIP: dueCustomers.filter(customer => customer.vipLevel === "VVIP").length,
      VIP: dueCustomers.filter(customer => customer.vipLevel === "VIP").length,
      NORMAL: dueCustomers.filter(customer => customer.vipLevel === "NORMAL").length
    }
  };
}

function syncDomTree(current, next) {
  if (!current || !next) return;
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
    current.replaceWith(next.cloneNode(true));
    return;
  }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  const currentAttributes = new Set([...current.attributes].map(attribute => attribute.name));
  for (const attribute of next.attributes) {
    currentAttributes.delete(attribute.name);
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  for (const name of currentAttributes) current.removeAttribute(name);
  const currentChildren = [...current.childNodes];
  const nextChildren = [...next.childNodes];
  const commonLength = Math.min(currentChildren.length, nextChildren.length);
  for (let index = 0; index < commonLength; index += 1) {
    syncDomTree(currentChildren[index], nextChildren[index]);
  }
  for (let index = currentChildren.length - 1; index >= nextChildren.length; index -= 1) {
    currentChildren[index].remove();
  }
  for (let index = currentChildren.length; index < nextChildren.length; index += 1) {
    current.append(nextChildren[index].cloneNode(true));
  }
}

function patchMobileDateView() {
  const liveContent = els.content;
  const detachedContent = document.createElement("div");
  els.content = detachedContent;
  try {
    const renderer = {
      dashboard: renderDashboard,
      reports: renderReports,
      opportunities: renderOpportunities,
      settings: renderSettings
    }[app.view];
    if (renderer) renderer();
  } finally {
    els.content = liveContent;
  }
  if (!detachedContent.firstElementChild || !liveContent.firstElementChild) return;
  syncDomTree(liveContent.firstElementChild, detachedContent.firstElementChild);
}

function renderDesktopDateView() {
  const renderer = {
    dashboard: renderDashboard,
    reports: renderReports,
    orders: renderOrders,
    customers: renderSearch,
    opportunities: renderOpportunities,
    notifications: renderNotifications,
    vip: renderVip,
    risk: renderRisk,
    settingsFinance: renderSettingsFinance
  }[app.view];
  if (renderer) renderer();
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
  app.mobileAnalyticsIndex = null;
  app.desktopAnalyticsIndex = null;
  if (mutation.settings) app.data.settings = mutation.settings;
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
      order.items,
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
  const preserveMobileScroll = isMobileViewport();
  if (preserveMobileScroll) rememberMobileOrdersScrollPosition();
  const countText = document.querySelector("#ordersCountText");
  const orders = filteredOrdersForCurrentView();
  if (countText) {
    countText.textContent = app.ordersShowAll
      ? `แสดง ${money(orders.length)} ออเดอร์จากทุกวัน`
      : `แสดง ${money(orders.length)} ออเดอร์จากวันที่เลือก`;
  }
  renderOrders();
  if (preserveMobileScroll) restoreMobileOrdersScrollPosition();
}

function cloneUiState() {
  return JSON.parse(JSON.stringify({
    orders: app.data.orders,
    customers: app.data.customers,
    summary: app.data.summary,
    tags: app.data.tags,
    settings: app.data.settings
  }));
}

function restoreUiState(snapshot) {
  app.data.orders = snapshot.orders || [];
  app.data.customers = snapshot.customers || [];
  app.data.summary = snapshot.summary || app.data.summary;
  app.data.tags = snapshot.tags || [];
  app.data.settings = snapshot.settings || app.data.settings;
  render();
}

function optimisticOrderFromForm(data, orderId, clientMutationId) {
  const existing = orderId ? app.data.orders.find(order => order.id === orderId) : null;
  return {
    ...(existing || {}),
    id: orderId || clientMutationId,
    customerId: existing?.customerId || `temp_customer_${clientMutationId}`,
    orderNumber: data.orderNumber ?? existing?.orderNumber ?? "",
    items: data.items ?? existing?.items ?? "Growup",
    customerName: data.name ?? existing?.customerName ?? "",
    phone: data.phone ?? existing?.phone ?? "",
    alternatePhone: data.alternatePhone ?? existing?.alternatePhone ?? "",
    address: data.address ?? existing?.address ?? "",
    date: data.date || existing?.date || todayISO(),
    time: data.time || existing?.time || "",
    jars: Number(data.jars ?? existing?.jars ?? 1),
    amount: Number(data.amount ?? existing?.amount ?? 0),
    source: data.sourceChannel ?? existing?.source ?? "",
    sourceChannel: data.sourceChannel ?? existing?.sourceChannel ?? "",
    socialName: data.socialName ?? existing?.socialName ?? "",
    originSource: data.originSource ?? existing?.originSource ?? "",
    freeGift: data.freeGift ?? existing?.freeGift ?? "",
    productId: data.productId ?? existing?.productId ?? "",
    packageId: data.packageId ?? existing?.packageId ?? "",
    packageName: data.packageName ?? existing?.packageName ?? "",
    paidQuantity: Number(data.paidQuantity ?? existing?.paidQuantity ?? 0),
    freeQuantity: Number(data.freeQuantity ?? existing?.freeQuantity ?? 0),
    totalQuantityShipped: Number(data.totalQuantityShipped ?? existing?.totalQuantityShipped ?? 0),
    packageExpenses: Array.isArray(data.packageExpenses) ? data.packageExpenses : (existing?.packageExpenses || []),
    revenueSnapshot: undefined,
    productCostSnapshot: undefined,
    packageExpenseSnapshot: undefined,
    globalExpenseSnapshot: undefined,
    profitBeforeAdsSnapshot: undefined,
    profitAfterAdsSnapshot: undefined,
    profitSnapshotVersion: 0,
    profitSnapshotCreatedAt: "",
    profitSnapshotUpdatedAt: "",
    profitSnapshotSource: "",
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

function createAdditionalCostRow(item = {}) {
  const id = String(item.id || `ac_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`);
  const draft = {
    name: item.name || "ค่าใช้จ่ายเพิ่มเติม",
    amount: Number(item.amount || 0),
    type: item.type || "fixed_per_order",
    enabled: item.enabled === false ? false : true
  };
  return `
    <div class="settings-cost-row is-editing" data-additional-cost-row data-id="${escapeHtml(id)}">
      <div class="settings-cost-grip" aria-hidden="true">⋮⋮</div>
      <div class="settings-cost-summary">
        <strong>${escapeHtml(draft.name)}</strong>
        <span>${escapeHtml(additionalCostMethodSummary(draft))}</span>
      </div>
      <div class="settings-cost-fields">
        <label class="settings-cost-field">
          <span>ชื่อรายการ</span>
          <input name="additionalCostName" value="${escapeHtml(item.name || "")}" placeholder="เช่น ค่าบรรจุภัณฑ์">
        </label>
        <label class="settings-cost-field">
          <span>จำนวนเงิน (บาท)</span>
          <input name="additionalCostAmount" type="number" min="0" step="0.01" value="${Number(item.amount || 0)}">
        </label>
        <label class="settings-cost-field">
          <span>วิธีคิด</span>
          <select name="additionalCostType">
            ${[
              ["fixed_per_order", "คงที่ต่อออเดอร์"],
              ["per_item", "ต่อชิ้น"],
              ["percent_sales", "% ของยอดขาย"]
            ].map(([value, label]) => `<option value="${value}" ${draft.type === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="settings-switch compact">
        <span>เปิดใช้งาน</span>
        <input name="additionalCostEnabled" type="checkbox" ${draft.enabled ? "checked" : ""}>
        <span class="settings-switch-ui"></span>
      </label>
      <div class="settings-cost-actions">
        <button class="button ghost compact-action" type="button" data-edit-additional-cost>บันทึก</button>
        <button class="button danger compact-action" type="button" data-delete-additional-cost>ลบ</button>
      </div>
    </div>
  `;
}

function toggleCostRowEditing(row, editable) {
  if (!row) return;
  row.classList.toggle("is-editing", editable);
  row.querySelectorAll("input[name$='Name'], input[name$='Amount'], select[name='additionalCostType']").forEach(input => {
    input.readOnly = !editable;
    if (input.tagName === "SELECT") input.disabled = !editable;
  });
  row.querySelectorAll("input[type='checkbox']").forEach(input => {
    input.disabled = !editable;
  });
  const editButton = row.querySelector("[data-edit-additional-cost], [data-edit-product-cost]");
  if (editButton) editButton.textContent = editable ? "บันทึก" : "แก้ไข";
  if (!editable && row.matches("[data-additional-cost-row]")) updateAdditionalCostRowSummary(row);
}

function updateAdditionalCostRowSummary(row) {
  const summary = row?.querySelector(".settings-cost-summary");
  if (!summary) return;
  const item = {
    name: row.querySelector("[name='additionalCostName']")?.value.trim() || "ค่าใช้จ่ายเพิ่มเติม",
    amount: Number(row.querySelector("[name='additionalCostAmount']")?.value || 0),
    type: row.querySelector("[name='additionalCostType']")?.value || "fixed_per_order"
  };
  summary.querySelector("strong").textContent = item.name;
  summary.querySelector("span").textContent = additionalCostMethodSummary(item);
}

function setSettingsSaveState(state = "idle", button = document.querySelector("[data-settings-save]")) {
  if (!button) return;
  button.classList.toggle("is-saving", state === "saving");
  button.classList.toggle("is-saved", state === "saved");
  button.disabled = state === "saving";
  if (state === "saving") {
    button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span>Saving...`;
  } else if (state === "saved") {
    button.textContent = "✓ Saved";
  } else {
    button.textContent = "บันทึกต้นทุนและค่าใช้จ่าย";
  }
}

function refreshAdditionalCostsSummary() {
  const rows = Array.from(document.querySelectorAll("[data-additional-cost-row]"));
  const additionalCosts = rows.map(row => ({
    id: row.dataset.id,
    name: row.querySelector("[name='additionalCostName']")?.value.trim(),
    amount: Number(row.querySelector("[name='additionalCostAmount']")?.value || 0),
    type: row.querySelector("[name='additionalCostType']")?.value || "fixed_per_order",
    enabled: row.querySelector("[name='additionalCostEnabled']")?.checked
  })).filter(item => item.name);
  const selectedDate = app.data?.summary?.selectedDate || todayISO();
  const scopeOrders = document.querySelector(".mobile-finance-form")
    ? (app.data?.orders || [])
    : (app.data?.orders || []).filter(order => order.date === selectedDate);
  const total = additionalCostTotalForOrders(scopeOrders, {
    ...(app.data?.settings || {}),
    additionalCosts
  });
  const target = document.querySelector("#additionalCostsTotal");
  if (target) target.textContent = `${money(total)} บาท`;
}

function readFinanceSettingsForm(form) {
  return {
    productCosts: Array.from(form.querySelectorAll("[data-product-cost-row]")).map(row => ({
      id: row.dataset.id,
      name: row.querySelector("[name='productCostName']")?.value.trim(),
      costPerJar: Number(row.querySelector("[name='productCostAmount']")?.value || 0),
      enabled: row.querySelector("[name='productCostEnabled']")?.checked
    })).filter(item => item.name),
    additionalCosts: Array.from(form.querySelectorAll("[data-additional-cost-row]")).map(row => ({
      id: row.dataset.id,
      name: row.querySelector("[name='additionalCostName']")?.value.trim(),
      amount: Number(row.querySelector("[name='additionalCostAmount']")?.value || 0),
      type: row.querySelector("[name='additionalCostType']")?.value || "fixed_per_order",
      enabled: row.querySelector("[name='additionalCostEnabled']")?.checked
    })).filter(item => item.name)
  };
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
    ["import", "Import Orders", "นำเข้าออเดอร์จาก CSV หรือ Excel", "นำเข้า"],
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
  els.content.innerHTML = renderImportCenter({ embedded: false });
}

function isImportCenterActive() {
  return app.view === "import" || (app.view === "settings" && app.mobileBusinessPage === "import");
}

function renderCurrentImportSurface() {
  if (app.view === "settings") renderSettings();
  else renderImport();
}

function importStatusLabels() {
  return {
    queued: "รอเริ่ม",
    running: "กำลังนำเข้า",
    paused: "หยุดชั่วคราว",
    completed: "เสร็จสมบูรณ์",
    cancelled: "ยกเลิกแล้ว",
    failed: "ไม่สำเร็จ"
  };
}

function importSummaryCards(job, inspection) {
  const total = Number(job?.total ?? inspection?.totalRows ?? 0);
  const success = Number(job?.imported ?? inspection?.readyRows ?? 0);
  const failed = Number(job?.failed ?? inspection?.invalidRows ?? 0);
  const duration = job ? formatImportDuration(job.durationSeconds || 0) : app.importPreparing ? "กำลังอ่านไฟล์" : "0 วินาที";
  const items = [
    ["ทั้งหมด", money(total), "รายการ", "file"],
    ["ผ่าน", money(success), "รายการ", "check"],
    ["ผิดพลาด", money(failed), "รายการ", "alert"],
    ["ใช้เวลา", duration, "", "clock"]
  ];
  return items.map(([label, value, suffix, icon], index) => `
    <article class="import-summary-card ${index === 1 ? "success" : index === 2 ? "danger" : index === 3 ? "info" : ""}">
      <span class="import-summary-icon">${iconSvg(icon)}</span>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${suffix ? `<small>${escapeHtml(suffix)}</small>` : ""}
    </article>
  `).join("");
}

function renderImportHistory(job, cleanup) {
  const historyJob = job || cleanup?.job || null;
  const labels = importStatusLabels();
  if (!historyJob) {
    return `
      <article class="import-history-card empty">
        <div class="import-history-title">
          <h3>Recent Import History</h3>
          <span>ล่าสุด</span>
        </div>
        <div class="import-history-empty">
          ${iconSvg("file")}
          <strong>ยังไม่มีประวัติการนำเข้า</strong>
          <small>เมื่อนำเข้าออเดอร์แล้ว สรุปล่าสุดจะแสดงที่นี่</small>
        </div>
      </article>
    `;
  }
  const status = labels[historyJob.status] || historyJob.status || "-";
  const imported = Number(historyJob.imported || 0);
  const failed = Number(historyJob.failed || 0);
  const dateLabel = historyJob.completedAt || historyJob.startedAt || historyJob.createdAt || "";
  return `
    <article class="import-history-card">
      <div class="import-history-title">
        <h3>Recent Import History</h3>
        <span>ล่าสุด</span>
      </div>
      <div class="import-history-row">
        <span class="import-file-badge">${iconSvg("file")}<b>${String(historyJob.fileName || "CSV").split(".").pop().slice(0, 4).toUpperCase()}</b></span>
        <div>
          <strong>${escapeHtml(historyJob.fileName || "orders.csv")}</strong>
          <small>${escapeHtml(dateLabel ? formatDateTime(dateLabel) : "-")}</small>
          <em>ผ่าน ${money(imported)} | ผิดพลาด ${money(failed)}</em>
        </div>
        <span class="import-status ${escapeHtml(historyJob.status || "")}">${escapeHtml(status)}</span>
      </div>
    </article>
  `;
}

function renderImportCenter({ embedded = false } = {}) {
  const job = app.importJob;
  const cleanup = app.importCleanup;
  const inspection = app.importInspection;
  const busy = job && ["queued", "running"].includes(job.status);
  const statusLabels = importStatusLabels();
  const uploadLabel = app.importPreparing ? "กำลังอ่านไฟล์..." : busy ? "มีงานกำลังทำงานอยู่" : job?.status === "paused" ? "เลือกไฟล์เดิมเพื่อทำต่อ" : "ลากไฟล์มาวางที่นี่";
  return `
    <section class="section import-center ${embedded ? "embedded" : ""}">
      <div class="import-center-hero">
        <span class="import-hero-icon">${iconSvg("upload")}</span>
        <div>
          <h2>Import Orders</h2>
          <p>นำเข้าออเดอร์จากไฟล์ CSV หรือ Excel เข้าสู่ระบบอย่างง่ายและรวดเร็ว</p>
        </div>
      </div>
      <div class="import-center-grid">
        <div class="import-center-main">
          <label class="import-upload-card">
            <span class="import-upload-cloud">${iconSvg("upload")}</span>
            <strong>${uploadLabel}</strong>
            <small>หรือคลิกเพื่อเลือกไฟล์</small>
            <em>รองรับไฟล์ CSV, XLSX, XLS (ไม่เกิน 20 MB)</em>
            <span class="button primary import-select-button">เลือกไฟล์</span>
            <input class="file-input" id="csvFile" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${app.importPreparing || busy ? "disabled" : ""}>
          </label>

          <article class="import-template-card">
            <div>
              <h3>Template Download</h3>
              <p>ดาวน์โหลดไฟล์ตัวอย่างเพื่อเตรียมข้อมูล</p>
            </div>
            <div class="import-template-actions">
              <a class="import-template-button csv" href="/templates/order-import-template.csv" download>${iconSvg("file")}<span>CSV template</span></a>
              <a class="import-template-button excel" href="/templates/order-import-template.xlsx" download>${iconSvg("file")}<span>Excel template</span></a>
            </div>
          </article>

          <article class="import-validation-card">
            <div class="import-validation-head">
              <div>
                <h3>Import Validation Summary</h3>
                <p>ตรวจสอบก่อนนำเข้าออเดอร์</p>
              </div>
              ${job?.canExportFailures ? `<a class="button secondary" href="/api/import-jobs/${encodeURIComponent(job.id)}/failed.csv">ดาวน์โหลดแถวที่ผิดพลาด</a>` : `<button class="button secondary" type="button" disabled>ดาวน์โหลดแถวที่ผิดพลาด</button>`}
            </div>
            <div class="import-summary-grid">
              ${importSummaryCards(job, inspection)}
            </div>
            <div class="import-center-actions">
              ${inspection ? `<button class="button primary" type="button" data-start-import ${inspection.canImport && !busy ? "" : "disabled"}>นำเข้าออเดอร์</button>` : ""}
              ${["queued", "running", "paused"].includes(job?.status) ? `<button class="button danger" data-cancel-import type="button">ยกเลิก</button>` : ""}
            </div>
          </article>

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
            </div>
          ` : ""}
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
          ${job?.lastError ? `<p class="form-error">${escapeHtml(job.lastError)}</p>` : ""}
          <div class="import-column-note">
            คอลัมน์หลักที่รองรับ: เลขออเดอร์, วันที่ซื้อ, ช่องทางการสั่งซื้อ, Facebook / LINE ลูกค้า, ชื่อลูกค้า, เบอร์โทร, เบอร์โทรสำรอง, ที่อยู่จัดส่ง, จำนวน, ยอดซื้อ, ของแถมที่ลูกค้าได้, สถานะบัตร VIP, อาการลูกค้า, ลูกค้ามาจาก และหมายเหตุ
          </div>
        </div>
        <aside class="import-center-side">
          ${renderImportHistory(job, cleanup)}
          <div class="import-capabilities">
            <span>แบ่งชุดอัตโนมัติ</span>
            <span>ทำต่อได้เมื่อสะดุด</span>
            <span>ป้องกันข้อมูลซ้ำ</span>
            <span>ดาวน์โหลดแถวที่ผิดพลาดได้</span>
            <span>เลือกชีตได้</span>
            <span>รองรับหัวตารางไทยและอังกฤษ</span>
          </div>
        </aside>
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
  if (isImportCenterActive()) renderCurrentImportSurface();
  if (!app.importWorker && isImportCenterActive() && app.importJob && ["queued", "running"].includes(app.importJob.status)) {
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
  renderCurrentImportSurface();
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
    if (isImportCenterActive()) renderCurrentImportSurface();
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
  renderCurrentImportSurface();
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

function reportPreviousMonth(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return "";
  const date = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function reportMonthLabel(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return String(month || "");
  return new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function reportMonthRange(month) {
  const [year, monthNumber] = String(month || "").split("-").map(Number);
  if (!year || !monthNumber) return "";
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const shortMonth = new Intl.DateTimeFormat("th-TH", { month: "short" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
  return `1 - ${days} ${shortMonth} ${year + 543}`;
}

function reportDelta(currentValue, previousValue) {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);
  if (current === 0 && previous === 0) return { text: "0%", tone: "flat" };
  if (previous <= 0) return { text: "↑ 100%", tone: "up" };
  const percent = ((current - previous) / previous) * 100;
  const rounded = Math.abs(percent) >= 10 ? Math.round(Math.abs(percent)) : Math.abs(percent).toFixed(1);
  if (percent > 0) return { text: `↑ ${rounded}%`, tone: "up" };
  if (percent < 0) return { text: `↓ ${rounded}%`, tone: "down" };
  return { text: "0%", tone: "flat" };
}

function reportChannelName(order = {}) {
  const raw = displayOrderChannel(order);
  const normalized = String(raw || "").toLowerCase();
  if (!raw || raw === MISSING_CHANNEL_LABEL) return "ไม่ระบุช่องทาง";
  if (
    normalized.includes("facebook") ||
    normalized.includes("fb") ||
    raw.includes("เฟส") ||
    raw.includes("เพจ") ||
    raw.includes("ไลฟ์") ||
    normalized.includes("inbox")
  ) return "Facebook";
  if (normalized.includes("line") || raw.includes("ไลน์")) return "LINE OA";
  if (raw.includes("โทร") || normalized.includes("phone") || normalized.includes("call") || normalized.includes("tel")) return "โทรสั่ง";
  return raw;
}

function reportChannelIcon(channel) {
  if (channel === "Facebook") return "f";
  if (channel === "LINE OA") return "LINE";
  if (channel === "โทรสั่ง") return "☎";
  return "●";
}

function mobileReportKpiCard({ label, value, suffix = "", comparison, tone, icon }) {
  return `
    <article class="mobile-report-kpi tone-${escapeHtml(tone)}">
      <div class="mobile-report-kpi-head">
        <span class="mobile-report-kpi-icon" aria-hidden="true">${dashboardCardIcon(icon)}</span>
        <span>${escapeHtml(label)}</span>
      </div>
      <strong>${escapeHtml(value)}${suffix ? `<small>${escapeHtml(suffix)}</small>` : ""}</strong>
      <div class="mobile-report-kpi-foot">
        <span class="report-trend ${escapeHtml(comparison.tone)}">${escapeHtml(comparison.text)}</span>
        <small>${escapeHtml(comparison.hint)}</small>
      </div>
    </article>
  `;
}

function renderMobileReports(selectedDate, selectedMonth) {
  const orders = app.data.orders || [];
  const customers = app.data.customers || [];
  const todayOrders = orders.filter(order => order.date === selectedDate);
  const monthOrders = orders.filter(order => monthKey(order.date) === selectedMonth);
  const yesterdayOrders = orders.filter(order => order.date === addDaysISO(selectedDate, -1));
  const previousMonth = reportPreviousMonth(selectedMonth);
  const previousMonthOrders = orders.filter(order => monthKey(order.date) === previousMonth);
  const sales = rows => rows.reduce((sum, order) => sum + Number(order.amount || 0), 0);
  const units = rows => rows.reduce((sum, order) => sum + Number(order.jars || 0), 0);
  const profit = rows => profitBreakdownForOrders(rows).profit;
  const todaySales = sales(todayOrders);
  const monthSales = sales(monthOrders);
  const todayProfit = profit(todayOrders);
  const monthProfit = profit(monthOrders);
  const todayMarketing = marketingPerformanceForPeriod({ date: selectedDate });
  const yesterdayMarketing = marketingPerformanceForPeriod({ date: addDaysISO(selectedDate, -1) });
  const monthMarketing = marketingPerformanceForPeriod({ month: selectedMonth });
  const previousMonthMarketing = marketingPerformanceForPeriod({ month: previousMonth });

  const channelMap = new Map();
  for (const order of monthOrders) {
    const name = reportChannelName(order);
    if (!channelMap.has(name)) channelMap.set(name, { name, revenue: 0, count: 0 });
    const row = channelMap.get(name);
    row.revenue += Number(order.amount || 0);
    row.count += 1;
  }
  const channelColors = ["#1769e8", "#10c86f", "#ff9f0a", "#8f45f7", "#ff337d", "#aab4c4"];
  const channelRows = [...channelMap.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .map((row, index) => ({
      ...row,
      color: channelColors[index % channelColors.length],
      percent: monthSales ? (row.revenue / monthSales) * 100 : 0
    }));
  let gradientOffset = 0;
  const donutGradient = channelRows.length && monthSales
    ? channelRows.map(row => {
      const start = gradientOffset;
      gradientOffset += row.percent;
      return `${row.color} ${start.toFixed(2)}% ${gradientOffset.toFixed(2)}%`;
    }).join(", ")
    : "#253345 0% 100%";

  const customerIds = new Set(monthOrders.map(order => order.customerId).filter(Boolean));
  const monthCustomers = customers.filter(customer => customerIds.has(customer.id));
  const newCustomerCount = customers.filter(customer => monthKey(customer.firstPurchaseDate) === selectedMonth).length;
  const monthOrderCounts = monthOrders.reduce((map, order) => {
    if (order.customerId) map.set(order.customerId, (map.get(order.customerId) || 0) + 1);
    return map;
  }, new Map());
  const repeatCustomerCount = [...monthOrderCounts.values()].filter(count => count > 1).length;
  const previousNewCustomers = customers.filter(customer => monthKey(customer.firstPurchaseDate) === previousMonth).length;
  const previousOrderCounts = previousMonthOrders.reduce((map, order) => {
    if (order.customerId) map.set(order.customerId, (map.get(order.customerId) || 0) + 1);
    return map;
  }, new Map());
  const previousRepeatCustomers = [...previousOrderCounts.values()].filter(count => count > 1).length;
  const vipCounts = {
    VIP: monthCustomers.filter(customer => customer.vipLevel === "VIP").length,
    VVIP: monthCustomers.filter(customer => customer.vipLevel === "VVIP").length,
    "SUPER VIP": monthCustomers.filter(customer => customer.vipLevel === "SUPER VIP").length
  };

  const productMap = new Map();
  for (const order of monthOrders) {
    const name = normalizeProductName(order.items || "ไม่ระบุสินค้า") || "ไม่ระบุสินค้า";
    if (!productMap.has(name)) productMap.set(name, { name, revenue: 0, units: 0, orders: 0 });
    const row = productMap.get(name);
    row.revenue += Number(order.amount || 0);
    row.units += Number(order.jars || 0);
    row.orders += 1;
  }
  const configuredProducts = normalizeProductRecords();
  const productRows = [...productMap.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map(row => ({
      ...row,
      image: configuredProducts.find(product => normalizeProductName(product.name) === row.name)?.image || ""
    }));

  const todayCards = [
    { label: "ยอดขายวันนี้", value: `฿${money(todaySales)}`, comparison: { ...reportDelta(todaySales, sales(yesterdayOrders)), hint: "เทียบกับเมื่อวาน" }, tone: "green", icon: "wallet" },
    { label: "ออเดอร์วันนี้", value: money(todayOrders.length), suffix: "ออเดอร์", comparison: { ...reportDelta(todayOrders.length, yesterdayOrders.length), hint: "เทียบกับเมื่อวาน" }, tone: "amber", icon: "orders" },
    { label: "กำไรวันนี้ (ก่อน Ads)", value: `฿${money(todayProfit)}`, comparison: { ...reportDelta(todayProfit, profit(yesterdayOrders)), hint: "ตัวเลขกำไรเดิม" }, tone: "violet", icon: "database" },
    { label: "ขายได้วันนี้", value: money(units(todayOrders)), suffix: "ชิ้น", comparison: { ...reportDelta(units(todayOrders), units(yesterdayOrders)), hint: "เทียบกับเมื่อวาน" }, tone: "blue", icon: "sales" },
    { label: "ค่าโฆษณาวันนี้", value: `฿${money(todayMarketing.adCost)}`, comparison: { ...reportDelta(todayMarketing.adCost, yesterdayMarketing.adCost), hint: "ค่าใช้จ่ายการตลาด" }, tone: "blue", icon: "wallet" },
    { label: "กำไรหลัง Ads", value: `฿${money(todayMarketing.profitAfterAds)}`, comparison: { ...reportDelta(todayMarketing.profitAfterAds, yesterdayMarketing.profitAfterAds), hint: "กำไรก่อน Ads - ค่าโฆษณา" }, tone: "green", icon: "database" },
    { label: "ROAS วันนี้", value: marketingNumber(todayMarketing.roas), comparison: { ...reportDelta(todayMarketing.roas, yesterdayMarketing.roas), hint: "ยอดขาย ÷ ค่าโฆษณา" }, tone: "amber", icon: "chart" }
  ];
  const monthCards = [
    { label: "ยอดขายเดือนนี้", value: `฿${money(monthSales)}`, comparison: { ...reportDelta(monthSales, sales(previousMonthOrders)), hint: "เทียบกับเดือนที่แล้ว" }, tone: "green", icon: "wallet" },
    { label: "ออเดอร์เดือนนี้", value: money(monthOrders.length), suffix: "ออเดอร์", comparison: { ...reportDelta(monthOrders.length, previousMonthOrders.length), hint: "เทียบกับเดือนที่แล้ว" }, tone: "amber", icon: "orders" },
    { label: "กำไรเดือนนี้ (ก่อน Ads)", value: `฿${money(monthProfit)}`, comparison: { ...reportDelta(monthProfit, profit(previousMonthOrders)), hint: "ตัวเลขกำไรเดิม" }, tone: "violet", icon: "database" },
    { label: "ขายได้เดือนนี้", value: money(units(monthOrders)), suffix: "ชิ้น", comparison: { ...reportDelta(units(monthOrders), units(previousMonthOrders)), hint: "เทียบกับเดือนที่แล้ว" }, tone: "blue", icon: "sales" },
    { label: "ค่าโฆษณาเดือนนี้", value: `฿${money(monthMarketing.adCost)}`, comparison: { ...reportDelta(monthMarketing.adCost, previousMonthMarketing.adCost), hint: "ค่าใช้จ่ายการตลาด" }, tone: "blue", icon: "wallet" },
    { label: "กำไรหลัง Ads เดือนนี้", value: `฿${money(monthMarketing.profitAfterAds)}`, comparison: { ...reportDelta(monthMarketing.profitAfterAds, previousMonthMarketing.profitAfterAds), hint: "กำไรก่อน Ads - ค่าโฆษณา" }, tone: "green", icon: "database" },
    { label: "ROAS เดือนนี้", value: marketingNumber(monthMarketing.roas), comparison: { ...reportDelta(monthMarketing.roas, previousMonthMarketing.roas), hint: "ยอดขาย ÷ ค่าโฆษณา" }, tone: "amber", icon: "chart" }
  ];

  els.content.innerHTML = `
    <section class="section saas-page mobile-reports-page">
      <div class="mobile-reports-shell">
        <h2 class="mobile-report-heading">สรุปวันนี้</h2>
        <div class="mobile-report-kpi-grid">
          ${todayCards.map(mobileReportKpiCard).join("")}
        </div>

        <h2 class="mobile-report-heading">สรุปเดือนนี้ <small>(${escapeHtml(reportMonthRange(selectedMonth))})</small></h2>
        <div class="mobile-report-kpi-grid">
          ${monthCards.map(mobileReportKpiCard).join("")}
        </div>

        <section class="mobile-report-card channel-report-card">
          <h2>ช่องทางการขาย <small>(${escapeHtml(reportMonthLabel(selectedMonth))})</small></h2>
          <div class="mobile-report-channel-layout">
            <div class="mobile-report-donut" style="--report-donut:${donutGradient};">
              <div>
                <span>ยอดขายรวม</span>
                <strong>฿${money(monthSales)}</strong>
                <small>บาท</small>
              </div>
            </div>
            <div class="mobile-report-channel-legend">
              ${channelRows.map(row => `
                <div class="mobile-report-channel-row">
                  <span class="report-channel-name"><i style="--channel-color:${row.color}">${escapeHtml(reportChannelIcon(row.name))}</i>${escapeHtml(row.name)}</span>
                  <span>${row.percent.toFixed(1)}%</span>
                  <strong>฿${money(row.revenue)}</strong>
                </div>
              `).join("") || `<div class="mobile-report-empty">ยังไม่มีข้อมูลช่องทางในเดือนนี้</div>`}
            </div>
          </div>
        </section>

        <section class="mobile-report-card">
          <h2>ลูกค้า <small>(${escapeHtml(reportMonthLabel(selectedMonth))})</small></h2>
          <div class="mobile-report-customer-grid">
            <article class="mobile-report-customer-stat tone-blue">
              <span class="customer-stat-icon" aria-hidden="true">${iconSvg("users")}</span>
              <span>ลูกค้าใหม่</span>
              <strong>${money(newCustomerCount)} <small>คน</small></strong>
              <span class="report-trend ${reportDelta(newCustomerCount, previousNewCustomers).tone}">${escapeHtml(reportDelta(newCustomerCount, previousNewCustomers).text)}</span>
              <small>เทียบกับเดือนที่แล้ว</small>
            </article>
            <article class="mobile-report-customer-stat tone-violet">
              <span class="customer-stat-icon" aria-hidden="true">↻</span>
              <span>ลูกค้าเก่ากลับมาซื้อซ้ำ</span>
              <strong>${money(repeatCustomerCount)} <small>คน</small></strong>
              <span class="report-trend ${reportDelta(repeatCustomerCount, previousRepeatCustomers).tone}">${escapeHtml(reportDelta(repeatCustomerCount, previousRepeatCustomers).text)}</span>
              <small>เทียบกับเดือนที่แล้ว</small>
            </article>
          </div>
          <article class="mobile-report-vip-card">
            <div class="mobile-report-vip-title"><span aria-hidden="true">♛</span> ลูกค้า VIP</div>
            <div class="mobile-report-vip-grid">
              ${Object.entries(vipCounts).map(([level, count]) => `
                <div><span>${escapeHtml(level)}</span><strong>${money(count)} <small>คน</small></strong></div>
              `).join("")}
            </div>
          </article>
        </section>

        <section class="mobile-report-card mobile-report-table-card">
          <h2>สินค้าขายดี <small>(${escapeHtml(reportMonthLabel(selectedMonth))})</small></h2>
          <div class="mobile-product-table-head"><span>สินค้า</span><span>ยอดขาย</span><span>ชิ้น</span><span>ออเดอร์</span></div>
          <div class="mobile-product-table-body">
            ${productRows.map(row => `
              <div class="mobile-product-table-row">
                <span class="mobile-report-product">
                  <i>${row.image ? `<img src="${escapeHtml(row.image)}" alt="">` : escapeHtml(initials(row.name))}</i>
                  <b>${escapeHtml(row.name)}</b>
                </span>
                <strong>฿${money(row.revenue)}</strong>
                <span>${money(row.units)}</span>
                <span>${money(row.orders)}</span>
              </div>
            `).join("") || `<div class="mobile-report-empty">ยังไม่มีข้อมูลสินค้าในเดือนนี้</div>`}
          </div>
        </section>

        <section class="mobile-report-card mobile-report-order-channel-card">
          <h2>ช่องทางขาย <small>(จำนวนออเดอร์ ${escapeHtml(reportMonthLabel(selectedMonth))})</small></h2>
          <div class="mobile-report-order-channel-list">
            ${channelRows.map(row => `
              <div>
                <span class="report-channel-name"><i style="--channel-color:${row.color}">${escapeHtml(reportChannelIcon(row.name))}</i>${escapeHtml(row.name)}</span>
                <strong>${money(row.count)} ออเดอร์</strong>
              </div>
            `).join("") || `<div class="mobile-report-empty">ยังไม่มีออเดอร์ในเดือนนี้</div>`}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderReports() {
  const selectedDate = app.reportDate || app.data.summary.selectedDate || todayISO();
  const selectedMonth = app.reportMonth || selectedDate.slice(0, 7);
  renderMobileReports(selectedDate, selectedMonth);
  if (isMobileViewport()) return;
  const desktopReportMonthOptions = Array.from(new Set(app.data.orders.map(order => monthKey(order.date)).filter(Boolean))).sort((a, b) => b.localeCompare(a));
  const shell = els.content.querySelector(".mobile-reports-shell");
  if (shell) {
    shell.insertAdjacentHTML("afterbegin", `
      <div class="desktop-report-controlbar">
        <label class="date-picker compact card-picker" aria-label="เลือกเดือนรายงาน">
          <span>เดือนรายงาน</span>
          <input data-report-month type="month" value="${escapeHtml(selectedMonth)}" list="reportMonthOptions">
          <datalist id="reportMonthOptions">
            ${desktopReportMonthOptions.map(month => `<option value="${escapeHtml(month)}"></option>`).join("")}
          </datalist>
        </label>
        <label class="date-picker compact card-picker" aria-label="เลือกวันที่รายงาน">
          <span>วันที่รายงาน</span>
          <input data-report-date type="date" value="${escapeHtml(selectedDate)}">
        </label>
      </div>
    `);
  }
  return;
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
  const selectedDayMarketing = marketingPerformanceForPeriod({ date: selectedDate });
  const selectedMonthMarketing = marketingPerformanceForPeriod({ month: selectedMonth });
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
        ${metric("ค่าโฆษณาวันที่เลือก", `${money(selectedDayMarketing.adCost)} บาท`, "accent")}
        ${metric("กำไรก่อน Ads วันที่เลือก", `${money(selectedDayMarketing.profitBeforeAds)} บาท`, "purple")}
        ${metric("กำไรหลัง Ads วันที่เลือก", `${money(selectedDayMarketing.profitAfterAds)} บาท`, "green")}
        ${metric("ค่าโฆษณาเดือนนี้", `${money(selectedMonthMarketing.adCost)} บาท`)}
        ${metric("กำไรหลัง Ads เดือนนี้", `${money(selectedMonthMarketing.profitAfterAds)} บาท`, "green")}
        ${metric("ROAS เดือนนี้", marketingNumber(selectedMonthMarketing.roas), "purple")}
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
          <span class="page-kicker">ผู้ช่วยวิเคราะห์ธุรกิจ</span>
          <h2>ข้อมูลเชิงลึกจาก AI</h2>
          <p>${hasAi ? "พร้อมเชื่อมต่อ AI จากระบบเดิม" : "แสดงคำแนะนำแบบ fallback อย่างปลอดภัยเมื่อยังไม่ได้ตั้งค่า AI API"}</p>
        </div>
        <span class="tag">${hasAi ? "AI พร้อมใช้งาน" : "โหมดสำรอง"}</span>
      </div>
      <div class="cards-grid">
        ${cards.map((text, index) => `
          <article class="insight-card">
            <span class="tag">อินไซต์ ${index + 1}</span>
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
  const items = liveNotificationItems();
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
          <p>Owner มีสิทธิ์สูงสุด, Admin ดูแลทีมระดับผู้จัดการ, Staff ใช้งานเฉพาะงานที่ได้รับอนุญาต</p>
        </div>
      </div>
      <div class="two-col">
        <div class="panel stack panel-premium">
          <div class="section-title">
            <h2>สิทธิ์ผู้ใช้</h2>
            <p>Owner มีสิทธิ์สูงสุด, Admin ดูแลทีมระดับผู้จัดการ, Staff ใช้งานเฉพาะงานที่ได้รับอนุญาต</p>
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

function settingsSectionTitle(index, title, subtitle, icon = "◈") {
  return `
    <div class="settings-card-head">
      <div class="settings-card-title">
        <div class="settings-card-icon" aria-hidden="true">${icon}</div>
        <div>
          <h3>${index}. ${escapeHtml(title)}</h3>
          <p>${escapeHtml(subtitle)}</p>
        </div>
      </div>
    </div>
  `;
}

const settingsMenuItems = [
  { view: "settingsStore", index: 1, title: "Store Information", titleTh: "ข้อมูลร้านค้า", description: "ข้อมูลพื้นฐานของร้าน ราคาเริ่มต้น และข้อความดูแลลูกค้า", icon: "⌂" },
  { view: "settingsFinance", index: 2, title: "Finance", titleTh: "การเงิน", description: "ต้นทุนสินค้า ต้นทุนเพิ่มเติม และสรุปกำไรของวันนี้", icon: "◫" },
  { view: "settingsCustomers", index: 3, title: "Customers", titleTh: "ลูกค้า", description: "Follow-up อัตโนมัติและเกณฑ์ VIP ของลูกค้า", icon: "◎" },
  { view: "settingsLineHub", index: 4, title: "LINE OA", titleTh: "LINE OA", description: "เชื่อมต่อ LINE OA, Webhook และข้อมูลการเข้าถึง", icon: "◉" },
  { view: "settingsUsers", index: 5, title: "Users & Permissions", titleTh: "ผู้ใช้งานและสิทธิ์", description: "สิทธิ์การเข้าถึงระบบและการจัดการทีมงาน", icon: "◌" },
  { view: "settingsImportExport", index: 6, title: "Import / Export", titleTh: "นำเข้า / ส่งออก", description: "นำเข้าข้อมูล ส่งออกข้อมูล และสำรองข้อมูล", icon: "⇅" },
  { view: "settingsSubscription", index: 7, title: "Subscription", titleTh: "แพ็กเกจ", description: "แพ็กเกจปัจจุบันและการใช้งานในอนาคต", icon: "♛" }
];

function settingsSubpageShell(kicker, title, description, inner) {
  return `
    <section class="section saas-page settings-page settings-premium-page settings-subpage">
      <div class="settings-subpage-header">
        <button class="subpage-back settings-inline-back" type="button" data-view-shortcut="settings" aria-label="กลับไปหน้าตั้งค่า">←</button>
        <div class="page-identity-copy">
          <span class="page-kicker">${escapeHtml(kicker)}</span>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
        </div>
      </div>
      ${inner}
    </section>
  `;
}

function userRoleLabel(role) {
  if (role === "Owner") return "Owner";
  if (role === "Admin") return "Admin";
  return "Staff";
}

function profileRoleLabel(role) {
  if (role === "Owner") return "เจ้าของร้าน";
  if (role === "Admin") return "Admin";
  return "ทีมงาน";
}

function userStatusLabel(user) {
  return user.active === false ? "ปิด" : "ใช้งาน";
}

function applySavedUser(user) {
  if (!user?.id || !app.data) return;
  app.data.users = app.data.users || [];
  const index = app.data.users.findIndex(item => item.id === user.id);
  if (index === -1) app.data.users.push(user);
  else app.data.users[index] = { ...app.data.users[index], ...user };
  if (app.currentUser?.id === user.id) {
    invalidateStateRequests();
    app.currentUser = { ...app.currentUser, ...user };
    app.data.currentUser = app.currentUser;
    app.data.users[index === -1 ? app.data.users.length - 1 : index] = app.currentUser;
    cacheMobileProfile(app.currentUser);
  }
}

function patchVisibleUserRow(user) {
  if (!user?.id) return;
  const row = document.querySelector(`[data-user-row="${CSS.escape(user.id)}"]`);
  if (!row) return;
  const cells = row.querySelectorAll("td");
  const name = user.name || user.username || "-";
  const nameCell = row.querySelector(".user-row-name strong") || row.querySelector("strong");
  if (nameCell) nameCell.textContent = name;
  if (cells[1]) cells[1].textContent = user.username || "-";
  if (cells[2]) cells[2].innerHTML = badge(userRoleLabel(user.role));
  if (cells[3]) cells[3].textContent = user.active ? "เปิดใช้งาน" : "ปิดใช้งาน";
}

function setTeamSaveState(form, state = "idle") {
  const button = form?.querySelector?.('button[type="submit"]');
  if (!button) return;
  button.dataset.saveState = state;
  button.disabled = state === "saving";
  if (state === "saving") button.textContent = "กำลังบันทึก...";
  else if (state === "saved") button.textContent = "บันทึกแล้ว ✓";
  else button.textContent = "บันทึก";
}

function roleOptions(selectedRole = "Staff", targetUser = null) {
  return ["Owner", "Admin", "Staff"].map(role => {
    const wouldDowngradeLastOwner = targetUser?.role === "Owner" && role !== "Owner" && isLastActiveOwner(targetUser);
    const disabled = !canManageUser(targetUser, role) || wouldDowngradeLastOwner;
    return `<option value="${role}" ${selectedRole === role ? "selected" : ""} ${disabled ? "disabled" : ""}>${role}</option>`;
  }).join("");
}

function userEditorMarkup(user = null, { mobile = false } = {}) {
  const isNew = !user?.id;
  const targetUser = user || null;
  const canDelete = !isNew && canManageUser(targetUser) && !isLastActiveOwner(user) && !(app.currentUser?.id === user.id && user.role === "Owner");
  const formClass = mobile ? "mobile-business-form mobile-user-form grow-modal-panel" : "panel stack panel-premium user-editor-panel grow-modal-panel";
  return `
    <form class="${formClass}" id="teamForm" data-user-form="${isNew ? "new" : escapeHtml(user.id)}">
      ${!mobile ? `
        <div class="section-title">
          <h2>${isNew ? "เพิ่มผู้ใช้งาน" : "แก้ไขผู้ใช้งาน"}</h2>
          <p>ข้อมูลสำหรับเข้าใช้ระบบ</p>
        </div>
      ` : ""}
      <input type="hidden" name="id" value="${escapeHtml(user?.id || "")}">
      <div class="user-editor-section grow-modal-section">
        <h3>ข้อมูลผู้ใช้งาน</h3>
        <label>ชื่อผู้ใช้งาน<input name="name" required value="${escapeHtml(user?.name || "")}" placeholder="กรอกชื่อผู้ใช้งาน"></label>
        <label>บทบาท
          <select name="role" required>
            ${roleOptions(userRoleLabel(user?.role || "Staff"), targetUser)}
          </select>
        </label>
      </div>
      <div class="user-editor-section login-section grow-modal-section">
        <h3>การเข้าสู่ระบบ</h3>
        <label>ชื่อเข้าใช้งาน<input name="username" required value="${escapeHtml(user?.username || "")}" placeholder="กรอกชื่อเข้าใช้งาน" autocomplete="username"></label>
        <label>รหัสผ่าน<input name="password" type="password" ${isNew ? "required" : ""} placeholder="${isNew ? "ตั้งรหัสผ่าน" : "เว้นว่างไว้ถ้าไม่เปลี่ยน"}" autocomplete="new-password"></label>
        <p class="user-editor-note">${isNew ? "Owner/Admin กำหนดรหัสผ่านเริ่มต้นให้ผู้ใช้งานได้จากหน้านี้" : "Owner/Admin รีเซ็ตรหัสผ่านได้จากหน้านี้ตามสิทธิ์ที่อนุญาต"}</p>
      </div>
      <div class="${mobile ? "mobile-user-actions" : "settings-submit-bar"}">
        ${!mobile ? `<button class="button ghost" type="button" data-cancel-user-edit>ยกเลิก</button>` : ""}
        ${canDelete ? `<button class="button danger" type="button" data-delete-user="${escapeHtml(user.id)}">ลบผู้ใช้งาน</button>` : ""}
        <button class="button primary" type="submit">${isNew ? "เพิ่มผู้ใช้งาน" : "บันทึก"}</button>
      </div>
    </form>
  `;
}

function renderTeamManagementPanels() {
  const editingUser = app.editingUserId && app.editingUserId !== "__new"
    ? (app.data.users || []).find(user => user.id === app.editingUserId)
    : null;
  const showEditor = app.editingUserId === "__new" || editingUser;
  return `
    <div class="settings-users-layout">
      <div class="panel stack panel-premium">
        <div class="section-title">
          <div>
            <h2>รายชื่อผู้ใช้งาน</h2>
            <p>กดแถวเพื่อเปิดรายละเอียดและแก้ไขสิทธิ์</p>
          </div>
          <button class="button primary" type="button" data-add-user>${iconSvg("users")} เพิ่มผู้ใช้งาน</button>
        </div>
        <div class="table-wrap mobile-stack-wrap">
          <table class="mobile-stack-table user-management-table">
            <thead><tr><th>ชื่อผู้ใช้งาน</th><th>ชื่อเข้าใช้งาน</th><th>บทบาท</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
            <tbody>
              ${app.data.users.map(user => `
                <tr data-user-row="${escapeHtml(user.id)}" tabindex="0">
                  <td data-label="ชื่อผู้ใช้งาน"><span class="user-row-name"><span class="mobile-business-avatar">${escapeHtml(initials(user.name))}</span><strong>${escapeHtml(user.name)}</strong></span></td>
                  <td data-label="ชื่อเข้าใช้งาน">${escapeHtml(user.username || "-")}</td>
                  <td data-label="บทบาท">${badge(userRoleLabel(user.role))}</td>
                  <td data-label="สถานะ">${user.active ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                  <td data-label="จัดการ"><button class="button ghost compact-action" type="button" data-edit-user="${escapeHtml(user.id)}">${iconSvg("settings")}</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      ${showEditor ? userEditorMarkup(editingUser) : `
        <article class="panel stack panel-premium user-editor-panel user-editor-empty">
          <div class="section-title">
            <h2>เลือกผู้ใช้งาน</h2>
            <p>กดรายชื่อด้านซ้ายหรือเพิ่มผู้ใช้งานใหม่</p>
          </div>
        </article>
      `}
    </div>
  `;
}

function settingsProductCostRows(settings) {
  return normalizeProductCostEntries(settings).map(item => `
    <div class="settings-cost-row" data-product-cost-row data-id="${escapeHtml(item.id)}">
      <div class="settings-cost-grip" aria-hidden="true">⋮⋮</div>
      <label class="settings-cost-field">
        <span>สินค้า</span>
        <input name="productCostName" value="${escapeHtml(item.name)}" readonly>
      </label>
      <label class="settings-cost-field">
        <span>Cost / กระปุก</span>
        <input name="productCostAmount" type="number" min="0" step="0.01" value="${Number(item.costPerJar || 0)}" readonly>
      </label>
      <label class="settings-switch compact">
        <span>เปิดใช้งาน</span>
        <input name="productCostEnabled" type="checkbox" ${item.enabled ? "checked" : ""} disabled>
        <span class="settings-switch-ui"></span>
      </label>
      <div class="settings-cost-actions">
        <button class="button ghost compact-action" type="button" data-edit-product-cost>${"แก้ไข"}</button>
      </div>
    </div>
  `).join("") || `<div class="empty-state">ยังไม่มีสินค้าให้ตั้งต้นทุน</div>`;
}

function settingsAdditionalCostRows(settings) {
  return normalizeAdditionalCostEntries(settings).map(item => `
    <div class="settings-cost-row" data-additional-cost-row data-id="${escapeHtml(item.id)}">
      <div class="settings-cost-grip" aria-hidden="true">⋮⋮</div>
      <div class="settings-cost-summary">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(additionalCostMethodSummary(item))}</span>
      </div>
      <div class="settings-cost-fields">
        <label class="settings-cost-field">
          <span>ชื่อรายการ</span>
          <input name="additionalCostName" value="${escapeHtml(item.name)}" readonly>
        </label>
        <label class="settings-cost-field">
          <span>จำนวนเงิน (บาท)</span>
          <input name="additionalCostAmount" type="number" min="0" step="0.01" value="${Number(item.amount || 0)}" readonly>
        </label>
        <label class="settings-cost-field">
          <span>วิธีคิด</span>
          <select name="additionalCostType" disabled>
            ${[
              ["fixed_per_order", "คงที่ต่อออเดอร์"],
              ["per_item", "ต่อชิ้น"],
              ["percent_sales", "% ของยอดขาย"]
            ].map(([value, label]) => `<option value="${value}" ${item.type === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>
      <label class="settings-switch compact">
        <span>เปิดใช้งาน</span>
        <input name="additionalCostEnabled" type="checkbox" ${item.enabled ? "checked" : ""}>
        <span class="settings-switch-ui"></span>
      </label>
      <div class="settings-cost-actions">
        <button class="button ghost compact-action" type="button" data-edit-additional-cost>แก้ไข</button>
        <button class="button danger compact-action" type="button" data-delete-additional-cost>ลบ</button>
      </div>
    </div>
  `).join("") || `<div class="empty-state">ยังไม่มีต้นทุนเพิ่มเติม</div>`;
}

function renderSettingsStore() {
  const settings = app.data.settings;
  const templates = settings.messageTemplates || {};
  els.content.innerHTML = settingsSubpageShell(
    "Store Information",
    "ข้อมูลร้านค้า",
    "ข้อมูลพื้นฐานของร้าน ราคาเริ่มต้น และข้อความดูแลลูกค้า",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <label>ชื่อธุรกิจ<input name="businessName" value="${escapeHtml(settings.businessName || "Growup Pilot")}"></label>
        <label>ราคาต่อกระปุกเริ่มต้น (บาท)<input name="defaultJarPrice" type="number" min="0" value="${Number(settings.defaultJarPrice || 750)}"></label>
        <label>Template ข้อความลูกค้าปกติ<textarea name="normalTemplate">${escapeHtml(templates.normal || "")}</textarea></label>
        <label>Template ข้อความ VIP<textarea name="vipTemplate">${escapeHtml(templates.vip || "")}</textarea></label>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
    `
  );
}

function renderSettingsFinance() {
  const settings = app.data.settings;
  const todayOrders = app.data.orders.filter(order => order.date === (app.data.summary?.selectedDate || todayISO()));
  const todayBreakdown = profitBreakdownForOrders(todayOrders, settings);
  const todaySales = todayBreakdown.sales;
  const todayProductCosts = todayBreakdown.productCosts;
  const totalAdditionalCosts = todayBreakdown.additionalCosts;
  const todayProfit = todayBreakdown.profitBeforeAds;
  const todayMarketing = marketingPerformanceForPeriod({
    date: app.data.summary?.selectedDate || todayISO()
  });
  els.content.innerHTML = settingsSubpageShell(
    "Finance",
    "การเงิน",
    "ตั้งค่าต้นทุนสินค้าและต้นทุนเพิ่มเติมสำหรับคำนวณกำไร",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <div class="settings-finance-summary">
          <p class="settings-finance-label">สูตรการคำนวณกำไรวันนี้</p>
          <div class="settings-finance-equation">
            <div class="settings-finance-pill sales"><span>ยอดขายวันนี้</span><strong>${money(todaySales)} บาท</strong></div>
            <span class="settings-finance-operator">-</span>
            <div class="settings-finance-pill product"><span>ต้นทุนสินค้าวันนี้</span><strong>${money(todayProductCosts)} บาท</strong></div>
            <span class="settings-finance-operator">-</span>
            <div class="settings-finance-pill extra"><span>ต้นทุนเพิ่มเติม</span><strong>${money(totalAdditionalCosts)} บาท</strong></div>
            <span class="settings-finance-operator">=</span>
            <div class="settings-finance-pill profit"><span>กำไรก่อนค่าโฆษณา</span><strong>${money(todayProfit)} บาท</strong></div>
          </div>
          <div class="settings-finance-equation ad-adjusted-equation">
            <div class="settings-finance-pill profit"><span>กำไรก่อนค่าโฆษณา</span><strong>${money(todayMarketing.profitBeforeAds)} บาท</strong></div>
            <span class="settings-finance-operator">-</span>
            <div class="settings-finance-pill extra"><span>ค่าโฆษณา</span><strong>${money(todayMarketing.adCost)} บาท</strong></div>
            <span class="settings-finance-operator">=</span>
            <div class="settings-finance-pill profit"><span>กำไรหลังค่าโฆษณา</span><strong>${money(todayMarketing.profitAfterAds)} บาท</strong></div>
          </div>
        </div>
        <div class="settings-finance-block">
          <div class="section-title section-title-actions">
            <div>
              <h3>ต้นทุนสินค้า</h3>
              <p>แต่ละสินค้าใช้ Cost / กระปุก ของตัวเอง</p>
            </div>
          </div>
          <div class="settings-cost-list">${settingsProductCostRows(settings)}</div>
        </div>
        <div class="settings-finance-block">
          <div class="section-title section-title-actions">
            <div>
              <h3>ต้นทุนเพิ่มเติม</h3>
              <p>เพิ่มรายการค่าใช้จ่ายได้ไม่จำกัด และระบบจะรวมเฉพาะรายการที่เปิดใช้งาน</p>
            </div>
            <button class="button primary compact-action finance-add-expense" type="button" data-add-additional-cost>+ Add</button>
          </div>
          <div class="settings-expense-helper-card">
            <strong>ค่าใช้จ่ายเพิ่มเติมใช้กับสินค้าทุกตัวที่เปิดใช้งาน</strong>
            <span>เช่น ค่าแพ็กสินค้า ค่าแรง ค่าอุปกรณ์ ค่าธรรมเนียม หรือค่าใช้จ่ายอื่น ๆ ที่เกี่ยวข้องกับสินค้า</span>
            <small>ตัวอย่าง: ตั้งค่า 2% → สินค้าที่ขาย 1,000 บาท จะเพิ่มค่าใช้จ่าย 20 บาท</small>
          </div>
          <div class="settings-cost-list" id="additionalCostList">${settingsAdditionalCostRows(settings)}</div>
          <div class="settings-total-row">
            <span>รวมต้นทุนเพิ่มเติมทั้งหมด</span>
            <strong id="additionalCostsTotal">${money(totalAdditionalCosts)} บาท</strong>
          </div>
        </div>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary settings-save-button" type="submit" data-settings-save>บันทึกต้นทุนและค่าใช้จ่าย</button>
        </div>
      </form>
    `
  );
}

function renderSettingsCustomers() {
  const settings = app.data.settings;
  const thresholds = settings.vipThresholds || {};
  const daysPerUnit = Math.max(1, Number(settings.followUpDaysPerUnit || 15));
  els.content.innerHTML = settingsSubpageShell(
    "Customers",
    "ลูกค้า",
    "ตั้งค่าการติดตามลูกค้าและเกณฑ์ VIP",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <div class="form-grid">
          <label>VIP Threshold<input name="vipThreshold" type="number" min="0" value="${Number(thresholds.vip || 5000)}"></label>
          <label>VVIP Threshold<input name="vvipThreshold" type="number" min="0" value="${Number(thresholds.vvip || 10000)}"></label>
          <label class="span-2">SUPER VIP Threshold<input name="superVipThreshold" type="number" min="0" value="${Number(thresholds.superVip || 20000)}"></label>
        </div>
        <label class="followup-setting-row" for="followupDaysPerUnit">
          <span>จำนวนวันต่อ 1 กระปุก</span>
          <div class="followup-setting-input">
            <input id="followupDaysPerUnit" name="daysPerUnit" type="number" min="1" required value="${daysPerUnit}">
            <span>วัน / กระปุก</span>
          </div>
          <div class="followup-setting-note">ระบบจะคำนวณวันติดตามจากจำนวนทั้งหมดที่ลูกค้าได้รับ รวมของแถม</div>
        </label>
        <div class="panel tight followup-preview-panel">
          <strong>ตัวอย่างการคำนวณ Follow-up</strong>
          <div class="table-wrap mobile-stack-wrap">
            <table class="rules-table mobile-stack-table">
              <thead><tr><th>ลูกค้าได้รับทั้งหมด</th><th>ระบบติดตามอีก</th></tr></thead>
              <tbody id="followupPreviewBody">
                ${followUpPreviewRows(daysPerUnit).map(row => `
                  <tr>
                    <td data-label="ลูกค้าได้รับทั้งหมด">${row.units} กระปุก</td>
                    <td data-label="ระบบติดตามอีก">${row.days} วัน</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
    `
  );
}

function renderSettingsLineHub() {
  const settings = app.data.settings;
  const lineSecretHelp = settings.lineChannelSecretConfigured
    ? settings.lineChannelSecretFromEnv ? "ตั้งค่าไว้ใน Vercel Environment แล้ว" : "มีค่าเดิมอยู่แล้ว เว้นว่างไว้เพื่อคงค่าเดิม"
    : "ยังไม่ได้ตั้งค่า";
  const lineTokenHelp = settings.lineChannelAccessTokenConfigured
    ? settings.lineChannelAccessTokenFromEnv ? "ตั้งค่าไว้ใน Vercel Environment แล้ว" : "มีค่าเดิมอยู่แล้ว เว้นว่างไว้เพื่อคงค่าเดิม"
    : "ยังไม่ได้ตั้งค่า";
  els.content.innerHTML = settingsSubpageShell(
    "LINE OA",
    "LINE OA",
    "เชื่อม LINE OA, ควบคุม Webhook และข้อมูลการเข้าถึง",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <label>LINE Group ID<input name="lineGroupId" value="${escapeHtml(settings.lineGroupId || "")}" ${settings.lineGroupIdFromEnv ? "readonly" : ""}></label>
        <label>LINE Channel ID<input name="lineChannelId" value="${escapeHtml(settings.lineChannelId || "")}" ${settings.lineChannelIdFromEnv ? "readonly" : ""}></label>
        <label>LINE Channel Secret<input name="lineChannelSecret" type="password" autocomplete="new-password" placeholder="${escapeHtml(lineSecretHelp)}"></label>
        <label>LINE Channel Access Token<textarea name="lineChannelAccessToken" autocomplete="off" placeholder="${escapeHtml(lineTokenHelp)}"></textarea></label>
        <label class="settings-switch">
          <span>เปิดใช้งาน LINE Webhook</span>
          <input name="lineWebhookEnabled" type="checkbox" ${settings.lineWebhookEnabled ? "checked" : ""}>
          <span class="settings-switch-ui"></span>
        </label>
        <label>Webhook URL<input value="${escapeHtml(`${location.origin}/api/line/webhook`)}" readonly></label>
        <div class="inline">
          <button class="button primary" type="button" data-test-webhook>ทดสอบ Webhook</button>
          <button class="button ghost" type="button" data-copy-webhook>คัดลอก URL</button>
        </div>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
    `
  );
}

function renderSettingsUsers() {
  const settings = app.data.settings;
  els.content.innerHTML = settingsSubpageShell(
    "Users & Permissions",
    "ผู้ใช้งานและสิทธิ์",
    "กำหนดสิทธิ์การส่งออกข้อมูลและจัดการทีมงาน",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <label class="settings-switch">
          <span>Staff สามารถ Export ข้อมูลได้</span>
          <input name="staffCanExport" type="checkbox" ${settings.staffCanExport ? "checked" : ""}>
          <span class="settings-switch-ui"></span>
        </label>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
      ${renderTeamManagementPanels()}
    `
  );
}

function renderSettingsImportExport() {
  const daysPerUnit = Math.max(1, Number(app.data.settings.followUpDaysPerUnit || 15));
  els.content.innerHTML = settingsSubpageShell(
    "Import / Export",
    "นำเข้า / ส่งออก",
    "รวมปุ่มใช้งานเกี่ยวกับการนำเข้า ส่งออก และสำรองข้อมูล",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <input name="daysPerUnit" type="hidden" value="${daysPerUnit}">
        <div class="settings-action-grid settings-action-grid-column">
          <button class="button ghost" type="button" data-view-shortcut="import">นำเข้าข้อมูล</button>
          <button class="button ghost" type="button" data-view-shortcut="reports">ส่งออกข้อมูล</button>
          <a class="button ghost" href="/api/backup" target="_blank" rel="noreferrer">สำรองข้อมูล</a>
        </div>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-reset-settings>ยกเลิก</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
    `
  );
}

function renderSettingsSubscription() {
  const daysPerUnit = Math.max(1, Number(app.data.settings.followUpDaysPerUnit || 15));
  els.content.innerHTML = settingsSubpageShell(
    "Subscription",
    "แพ็กเกจ",
    "ดูแพ็กเกจปัจจุบันและทางเลือกสำหรับการใช้งานในอนาคต",
    `
      <form class="panel stack panel-premium settings-subpage-form" id="settingsForm">
        <input name="daysPerUnit" type="hidden" value="${daysPerUnit}">
        <p class="muted">หน้านี้ยังคงใช้ข้อมูลแพ็กเกจเดิมของ Growup Pilot และไม่ได้เปลี่ยน business logic การชำระเงินจริง</p>
        <div class="pricing-grid settings-subscription-grid">
          <article class="pricing-card">
            <span class="tag">Starter</span>
            <h3>เริ่มต้นดูแลร้าน</h3>
            <div class="pricing-price">฿0<span>/ทดลอง</span></div>
            <p class="muted">เหมาะสำหรับทดลอง dashboard, orders, customers และ workflow พื้นฐาน</p>
          </article>
          <article class="pricing-card featured">
            <span class="tag">Growth</span>
            <h3>Growup Pilot Pro</h3>
            <div class="pricing-price">฿1,990<span>/เดือน</span></div>
            <p class="muted">สำหรับธุรกิจที่ต้องการ AI insight, broadcast workflow และ command center เต็มรูปแบบ</p>
          </article>
        </div>
        <div class="settings-submit-bar">
          <button class="button ghost" type="button" data-view-shortcut="pricing">ดูรายละเอียดแพ็กเกจ</button>
          <button class="button primary" type="submit">บันทึกการตั้งค่า</button>
        </div>
      </form>
    `
  );
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
      <div class="followup-setting-note">ระบบจะคำนวณวันติดตามอัตโนมัติจากจำนวนที่ลูกค้าได้รับทั้งหมด (รวมของแถม)</div>
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
    <div class="detail-grid grow-modal-section-grid">
      <div class="panel stack detail-card grow-modal-section">
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
        <form class="stack grow-modal-section nested-form" id="customerEditForm">
          <input type="hidden" name="customerId" value="${customer.id}">
          <label>อาการลูกค้า
            <input name="tags" value="${escapeHtml((customer.tags || []).join(", "))}">
          </label>
          <label>หมายเหตุลูกค้า
            <textarea name="note">${escapeHtml(customer.note || "")}</textarea>
          </label>
          <button class="button secondary" type="submit">บันทึกอาการลูกค้า / หมายเหตุ</button>
        </form>
        <form class="stack grow-modal-section nested-form" id="contactForm">
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
      <div class="panel stack detail-card grow-modal-section">
        <h3>ประวัติออเดอร์</h3>
        <div class="timeline">
          ${customer.orders.slice().reverse().map(order => `
            <div class="timeline-item">
              <strong>${formatShortDate(order.date)} · ${escapeHtml(order.items || "-")} · ${order.jars} กระปุก · ${money(order.amount)} บาท</strong>
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

function openProductDialog(product = null) {
  app.editingProductId = product?.id || "";
  app.productSavePending = false;
  app.productDraftImage = normalizeProductImageSource(product?.image);
  app.productOriginalImage = app.productDraftImage;
  app.productPackageDraft = normalizeSalesPackages(product?.salesPackages);
  app.productExpandedPackageId = "";
  els.productForm.reset();
  els.productDialogTitle.textContent = product ? "แก้ไขสินค้า" : "เพิ่มสินค้า";
  if (product) {
    Object.entries({
      name: product.name,
      sku: product.sku,
      description: product.description,
      salePrice: product.salePrice,
      costPerItem: product.costPerItem,
      stockQuantity: product.stockQuantity,
      lowStockAlert: product.lowStockAlert,
      status: product.status,
      followUpDays: product.followUpDays,
      followUpRule: product.followUpRule
    }).forEach(([key, value]) => {
      if (els.productForm.elements[key]) els.productForm.elements[key].value = value ?? "";
    });
    if (els.productForm.elements.image && /^https?:\/\//i.test(app.productDraftImage)) {
      els.productForm.elements.image.value = app.productDraftImage;
    }
    els.productForm.elements.followUpEnabled.checked = Boolean(product.followUpEnabled);
  } else {
    els.productForm.elements.followUpEnabled.checked = true;
    els.productForm.elements.followUpDays.value = 15;
    els.productForm.elements.followUpRule.value = "1 ชิ้น = 15 วัน";
    els.productForm.elements.status.value = "พร้อมขาย";
  }
  if (els.productImageFileInput) els.productImageFileInput.value = "";
  setProductSaveState(false);
  updateProductImagePreview(app.productDraftImage, product?.name || "");
  renderProductPackageEditor();
  document.body.classList.add("modal-scroll-locked");
  els.productDialog.showModal();
}

function updateProductImagePreview(imageUrl = "", productName = "") {
  if (!els.productImagePreview) return;
  const label = initials(productName || "สินค้า");
  if (String(imageUrl || "").trim()) {
    els.productImagePreview.innerHTML = productImageMarkup(imageUrl, productName || "สินค้า");
    return;
  }
  els.productImagePreview.textContent = label;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String(event.target?.result || ""));
    reader.onerror = () => reject(reader.error || new Error("อ่านไฟล์รูปไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("เปิดไฟล์รูปไม่สำเร็จ"));
    image.src = src;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => {
    if (!canvas.toBlob) return resolve(null);
    canvas.toBlob(blob => resolve(blob), type, quality);
  });
}

async function compressProductImageFile(file) {
  if (!file?.type?.startsWith("image/") || file.type === "image/svg+xml") {
    return readFileAsDataUrl(file);
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const maxSide = 1200;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return readFileAsDataUrl(file);
    ctx.drawImage(image, 0, 0, width, height);
    const preferredType = "image/webp";
    let blob = await canvasToBlob(canvas, preferredType, 0.86);
    if (!blob) blob = await canvasToBlob(canvas, "image/jpeg", 0.88);
    if (!blob) return readFileAsDataUrl(file);
    if (blob.size >= file.size && file.size < 350_000) return readFileAsDataUrl(file);
    return readFileAsDataUrl(blob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function packageDraftId(prefix) {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}

function renderProductPackageEditor() {
  const list = document.querySelector("#productPackageList");
  if (!list) return;
  list.innerHTML = app.productPackageDraft.map((item, packageIndex) => {
    const isOpen = app.productExpandedPackageId === item.id;
    const activeLabel = item.enabled ? "เปิดขาย" : "ปิดอยู่";
    const expenseCount = Array.isArray(item.expenses) ? item.expenses.length : 0;
    return `
      <article class="sales-package-card ${isOpen ? "is-open" : ""}" data-sales-package-id="${escapeHtml(item.id)}">
        <button class="sales-package-summary" type="button" data-toggle-sales-package aria-expanded="${isOpen ? "true" : "false"}">
          <span class="sales-package-summary-main">
            <i>${iconSvg("box")}</i>
            <strong>${escapeHtml(item.name || `แพ็กเกจ ${packageIndex + 1}`)}</strong>
            <small class="${item.enabled ? "is-active" : "is-paused"}">${activeLabel}</small>
          </span>
          <span class="sales-package-summary-metrics">
            <b>รวม ${money(item.totalQuantityShipped)} ชิ้น</b>
            <b>ราคา ${money(item.salePrice)} บาท</b>
            <b>ค่าใช้จ่าย ${money(expenseCount)} รายการ</b>
            <em aria-hidden="true">${isOpen ? "⌃" : "⌄"}</em>
          </span>
        </button>
        ${isOpen ? `
          <div class="sales-package-edit-panel">
            <div class="sales-package-card-head">
              <span>แก้ไขแพ็กเกจ</span>
              <div class="table-actions">
                <button class="button ghost compact-action" type="button" data-move-sales-package="-1" aria-label="เลื่อนขึ้น">↑</button>
                <button class="button ghost compact-action" type="button" data-move-sales-package="1" aria-label="เลื่อนลง">↓</button>
                <button class="button ghost compact-action" type="button" data-duplicate-sales-package>ทำซ้ำ</button>
                <button class="button danger compact-action" type="button" data-delete-sales-package>ลบ</button>
              </div>
            </div>
            <div class="sales-package-grid">
              <label>ชื่อแพ็กเกจ<input name="packageName" value="${escapeHtml(item.name)}"></label>
              <label class="inline package-toggle"><input name="packageEnabled" type="checkbox" ${item.enabled ? "checked" : ""} style="width:auto"> เปิดใช้งาน</label>
              <label>จำนวนที่ชำระ<input name="packagePaidQuantity" type="number" min="0" step="1" value="${item.paidQuantity}"></label>
              <label>จำนวนแถม<input name="packageFreeQuantity" type="number" min="0" step="1" value="${item.freeQuantity}"></label>
              <label>จำนวนจัดส่งรวม<input name="packageTotalQuantity" type="number" min="0" step="1" value="${item.totalQuantityShipped}"></label>
              <label>ราคาขาย<input name="packageSalePrice" type="number" min="0" step="0.01" value="${item.salePrice}"></label>
            </div>
            <div class="package-expense-head">
              <span>ค่าใช้จ่ายของแพ็กเกจนี้</span>
              <button class="button ghost compact-action" type="button" data-add-package-expense>+ เพิ่มค่าใช้จ่าย</button>
            </div>
            <div class="package-expense-list">
              ${item.expenses.map(expense => `
                <div class="package-expense-row" data-package-expense-id="${escapeHtml(expense.id)}">
                  <label>ชื่อ<input name="packageExpenseName" value="${escapeHtml(expense.name)}" placeholder="เช่น ค่ากล่อง"></label>
                  <label>จำนวนเงิน<input name="packageExpenseAmount" type="number" min="0" step="0.01" value="${expense.amount}"></label>
                  <label class="inline"><input name="packageExpenseEnabled" type="checkbox" ${expense.enabled ? "checked" : ""} style="width:auto"> ใช้</label>
                  <button class="button danger compact-action" type="button" data-delete-package-expense>ลบ</button>
                </div>
              `).join("") || `<div class="package-expense-empty">ยังไม่มีค่าใช้จ่ายในแพ็กเกจนี้</div>`}
            </div>
          </div>
        ` : ""}
      </article>
    `;
  }).join("") || `<div class="empty-state">ยังไม่มีแพ็กเกจ กด “+ เพิ่มแพ็กเกจ” เพื่อเริ่มต้น</div>`;
}

function readProductPackageDraft() {
  return [...document.querySelectorAll("[data-sales-package-id]")].map(card => {
    const existing = app.productPackageDraft.find(item => item.id === card.dataset.salesPackageId) || {};
    const nameField = card.querySelector("[name='packageName']");
    const paidField = card.querySelector("[name='packagePaidQuantity']");
    const freeField = card.querySelector("[name='packageFreeQuantity']");
    const totalField = card.querySelector("[name='packageTotalQuantity']");
    const salePriceField = card.querySelector("[name='packageSalePrice']");
    const enabledField = card.querySelector("[name='packageEnabled']");
    const expenseRows = [...card.querySelectorAll("[data-package-expense-id]")];
    return {
      id: card.dataset.salesPackageId,
      name: nameField?.value.trim() || existing.name || "แพ็กเกจ",
      paidQuantity: Math.max(0, Number(paidField?.value ?? existing.paidQuantity ?? 0)),
      freeQuantity: Math.max(0, Number(freeField?.value ?? existing.freeQuantity ?? 0)),
      totalQuantityShipped: Math.max(0, Number(totalField?.value ?? existing.totalQuantityShipped ?? 0)),
      salePrice: Math.max(0, Number(salePriceField?.value ?? existing.salePrice ?? 0)),
      enabled: enabledField ? Boolean(enabledField.checked) : existing.enabled !== false,
      expenses: expenseRows.length ? expenseRows.map(row => ({
        id: row.dataset.packageExpenseId,
        name: row.querySelector("[name='packageExpenseName']")?.value.trim() || "ค่าใช้จ่าย",
        amount: Math.max(0, Number(row.querySelector("[name='packageExpenseAmount']")?.value || 0)),
        enabled: Boolean(row.querySelector("[name='packageExpenseEnabled']")?.checked)
      })) : (existing.expenses || [])
    };
  });
}

function applyProductSavePayload(payload = {}) {
  if (!app.data) return;
  app.data.settings = app.data.settings || {};
  if (Array.isArray(payload.settings?.products)) {
    app.data.settings.products = normalizeProductRecords({ products: payload.settings.products });
  } else if (payload.product) {
    const products = normalizeProductRecords();
    const index = products.findIndex(item => item.id === payload.product.id);
    if (index === -1) products.push(payload.product);
    else products[index] = { ...products[index], ...payload.product };
    app.data.settings.products = normalizeProductRecords({ products });
  }
  if (Array.isArray(payload.settings?.productCosts)) {
    app.data.settings.productCosts = payload.settings.productCosts;
  }
}

function setProductSaveState(isSaving) {
  app.productSavePending = isSaving;
  if (!els.productSubmitButton) return;
  els.productSubmitButton.disabled = isSaving;
  els.productSubmitButton.dataset.loading = isSaving ? "true" : "false";
  els.productSubmitButton.textContent = isSaving ? "กำลังบันทึก..." : "บันทึกสินค้า";
}

function renderProductDetail(product) {
  els.productDetailTitle.textContent = product.name;
  els.productDetail.innerHTML = `
    <div class="customer-detail-hero">
      <div class="product-thumb large">${productImageMarkup(product.image, product.name, escapeHtml(initials(product.name)))}</div>
      <div>
        <h2>${escapeHtml(product.name)}</h2>
        <div class="inline">${product.sku ? `<span class="tag">${escapeHtml(product.sku)}</span>` : ""}<span class="badge ${product.computedStatus === "พร้อมขาย" ? "vip" : product.computedStatus === "ใกล้หมด" ? "risk" : product.computedStatus === "เหลือน้อย" ? "lost" : "normal"}">${escapeHtml(product.computedStatus)}</span></div>
        <p>${escapeHtml(product.description || "ไม่มีคำอธิบายสินค้า")}</p>
      </div>
    </div>
    <div class="detail-grid">
      <div class="panel stack detail-card">
        <div class="mini-stats">
          <div class="mini-stat"><span>ราคาขาย</span><strong>${money(product.salePrice)} บาท</strong></div>
          <div class="mini-stat"><span>ต้นทุนต่อชิ้น</span><strong>${productCostMoney(product.costPerItem)} บาท</strong></div>
          <div class="mini-stat"><span>สต๊อก</span><strong>${money(product.stockQuantity)} ชิ้น</strong></div>
          <div class="mini-stat"><span>แจ้งเตือนสต๊อกต่ำ</span><strong>${money(product.lowStockAlert)} ชิ้น</strong></div>
          <div class="mini-stat"><span>ติดตามลูกค้า</span><strong>${product.followUpEnabled ? `${money(product.followUpDays)} วัน` : "ปิด"}</strong></div>
          <div class="mini-stat"><span>กติกา</span><strong>${escapeHtml(product.followUpRule)}</strong></div>
        </div>
      </div>
      <div class="panel stack detail-card">
        <div class="mini-stats">
          <div class="mini-stat"><span>ยอดขาย</span><strong>${money(product.revenue)} บาท</strong></div>
          <div class="mini-stat"><span>ขายแล้ว</span><strong>${money(product.soldCount)} ชิ้น</strong></div>
          <div class="mini-stat"><span>ออเดอร์</span><strong>${money(product.orderCount)}</strong></div>
          <div class="mini-stat"><span>ลูกค้าที่ต้องติดตาม</span><strong>${money(product.followUpCustomers)} ราย</strong></div>
        </div>
      </div>
    </div>
  `;
  els.productDetailDialog.showModal();
}

function render(options = {}) {
  const mobile = isMobileViewport();
  app.layoutMode = mobile ? "mobile" : "desktop";
  if (!app.data && app.view !== "login") {
    if (!mobile) renderNav();
    updateShell();
    els.pageTitle.textContent = titleFor(app.view);
    if (els.pageSubtitle) els.pageSubtitle.textContent = "";
    document.title = `${titleFor(app.view)} | Growup Pilot`;
    renderSubpageNav();
    els.content.innerHTML = `
      <section class="app-loading-state" aria-live="polite">
        <span class="app-loading-spinner" aria-hidden="true"></span>
        <strong>กำลังโหลดข้อมูลธุรกิจ</strong>
        <span>เตรียมแดชบอร์ดของคุณสักครู่</span>
      </section>
    `;
    if (mobile) {
      els.content.dataset.renderedView = app.view;
      if (!options.deferMobileNavSync) renderNav();
    }
    return;
  }
  if (!mobile) renderNav();
  updateShell();
  els.pageTitle.textContent = !mobile && app.view === "dashboard"
    ? `สวัสดีครับ, ${app.currentUser?.name || "เจ้าของธุรกิจ"} 👋`
    : titleFor(app.view);
  if (els.pageSubtitle) {
    els.pageSubtitle.textContent = !mobile && app.view === "dashboard" ? "นี่คือภาพรวมธุรกิจของคุณวันนี้" : "";
  }
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
    settingsStore: renderSettingsStore,
    settingsFinance: renderSettingsFinance,
    settingsCustomers: renderSettingsCustomers,
    settingsLineHub: renderSettingsLineHub,
    settingsUsers: renderSettingsUsers,
    settingsImportExport: renderSettingsImportExport,
    settingsSubscription: renderSettingsSubscription,
    settingsFollowup: renderSettingsFollowup,
    settingsVip: renderSettingsVip,
    settingsLine: renderSettingsLine,
    lineDebug: renderLineDebug
  }[app.view] || renderDashboard;
  const renderResult = renderer();
  if (mobile) {
    els.content.dataset.renderedView = app.view;
    if (!options.deferMobileNavSync) renderNav();
  }
  return renderResult;
}

function handleViewportResize() {
  const nextMode = isMobileViewport() ? "mobile" : "desktop";
  if (app.layoutMode !== nextMode) {
    render();
    return;
  }
  renderNav();
  updateShell();
  renderSubpageNav();
}

function setView(view) {
  if (!canAccessView(view)) {
    showToast("เมนูนี้ต้องใช้สิทธิ์ Owner/Admin");
    return;
  }
  if (view !== "settings") clearBusinessManagementScrollRestore();
  app.mobileOrderMenuId = "";
  app.view = view;
  clearTimeout(app.importPollTimer);
  navigateToView(view);
  render();
  refreshSharedState().catch(error => console.warn("[state-sync]", error.message || error));
  if (view === "import" && !app.importWorker) refreshImportJob().catch(error => showToast(error.message));
}

async function setMobileNavView(view) {
  if (!canAccessView(view)) {
    showToast("เมนูนี้ต้องใช้สิทธิ์ Owner/Admin");
    return;
  }
  if (view !== "settings") clearBusinessManagementScrollRestore();

  const sequence = ++app.mobileNavigationSequence;
  const previousPage = app.view;
  const clickedAt = performance.now();
  let renderStartedAt = 0;
  let renderEndedAt = 0;
  let activeNavSyncedAt = 0;

  app.mobileOrderMenuId = "";
  app.view = view;
  clearTimeout(app.importPollTimer);
  navigateToView(view);

  try {
    renderStartedAt = performance.now();
    await Promise.resolve(render({ deferMobileNavSync: true }));
    renderEndedAt = performance.now();

    if (sequence !== app.mobileNavigationSequence || app.view !== view) return;
    renderNav();
    activeNavSyncedAt = performance.now();
    refreshSharedState().catch(error => console.warn("[state-sync]", error.message || error));
    console.debug("[mobile-nav]", {
      clickedTab: view,
      previousPage,
      nextPage: view,
      renderStart: Number((renderStartedAt - clickedAt).toFixed(2)),
      renderEnd: Number((renderEndedAt - clickedAt).toFixed(2)),
      activeNavSync: Number((activeNavSyncedAt - clickedAt).toFixed(2))
    });
  } catch (error) {
    if (sequence === app.mobileNavigationSequence) {
      app.view = previousPage;
      navigateToView(previousPage, true);
      render();
    }
    throw error;
  }
}

function syncViewFromLocation(event = null) {
  const nextView = routeFromLocation();
  const previousBusinessPage = app.mobileBusinessPage || "main";
  if (!app.currentUser && nextView !== "login") {
    clearBusinessManagementScrollRestore();
    app.mobileBusinessPage = "main";
    app.view = "login";
    navigateToView("login", true);
    render();
    return;
  }
  if (app.currentUser && nextView === "login") {
    clearBusinessManagementScrollRestore();
    app.mobileBusinessPage = "main";
    app.view = "dashboard";
    navigateToView("dashboard", true);
    render();
    return;
  }
  if (!canAccessView(nextView)) {
    clearBusinessManagementScrollRestore();
    app.mobileBusinessPage = "main";
    app.view = "settings";
    navigateToView("settings", true);
    showToast("เมนูนี้ต้องใช้สิทธิ์ Owner/Admin");
    render();
    return;
  }
  if (nextView === "settings" && event?.type === "popstate") {
    const nextBusinessPage = event.state?.businessManagementPage || "main";
    if (previousBusinessPage === "main" && nextBusinessPage !== "main") saveBusinessManagementScrollPosition();
    app.mobileBusinessPage = nextBusinessPage;
    if (nextBusinessPage !== "security") app.securityDetailKey = "";
  } else if (nextView !== "settings") {
    clearBusinessManagementScrollRestore();
    app.mobileBusinessPage = "main";
  }
  app.view = nextView;
  render();
  refreshSharedState().catch(error => console.warn("[state-sync]", error.message || error));
  if (nextView === "settings" && previousBusinessPage !== "main" && app.mobileBusinessPage === "main") {
    restoreBusinessManagementScrollWhenReady();
  }
}

function setOrderSaveState(isSaving) {
  app.orderSavePending = isSaving;
  if (!els.orderSubmitButton) return;
  els.orderSubmitButton.disabled = isSaving;
  els.orderSubmitButton.dataset.loading = isSaving ? "true" : "false";
  if (isSaving) els.orderSubmitButton.textContent = "กำลังบันทึก...";
}

async function submitOrder(form) {
  if (app.orderSavePending) return;
  setOrderSaveState(true);
  const data = Object.fromEntries(new FormData(form).entries());
  if (String(data.date || "").includes("T")) {
    const [datePart, timePart] = String(data.date).split("T");
    data.date = datePart;
    data.time = timePart || "";
  }
  const preservedOriginSource = String(form.dataset.originSourceValue || "").trim();
  data.originSource = String(data.originSourceChoice || "").trim() || preservedOriginSource;
  delete data.originSourceChoice;
  applyQuantityMatchedOrderPackage(data);
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
  } finally {
    setOrderSaveState(false);
  }
}

function openDeleteOrderDialog(orderId) {
  app.deletingOrderId = orderId;
  app.mobileOrderMenuId = "";
  const order = app.data.orders.find(item => item.id === orderId);
  if (els.mobileDeleteOrderNumber) {
    els.mobileDeleteOrderNumber.textContent = order ? mobileOrderNumber(order) : "-";
  }
  els.deleteOrderDialog.showModal();
}

function openDeleteCustomerDialog(customerId) {
  app.deletingCustomerId = customerId;
  els.deleteCustomerDialog.showModal();
}

function openDeleteUserDialog(userId) {
  const user = (app.data.users || []).find(item => item.id === userId);
  if (!user) return;
  if (!canManageUser(user)) {
    showToast("ไม่มีสิทธิ์ลบผู้ใช้งานนี้");
    return;
  }
  if (app.currentUser?.id === user.id && user.role === "Owner") {
    showToast("ไม่สามารถลบ Owner ที่กำลังใช้งานอยู่ได้");
    return;
  }
  if (isLastActiveOwner(user)) {
    showToast("ไม่สามารถลบ Owner คนสุดท้ายได้");
    return;
  }
  app.deletingUserId = userId;
  if (els.deleteUserName) els.deleteUserName.textContent = user.name || user.username || "-";
  els.deleteUserDialog.showModal();
}

function packageProducts() {
  return normalizeProductRecords().filter(product => product.salesPackages.length);
}

function applyQuantityMatchedOrderPackage(data) {
  const quantity = Number(data.jars || 0);
  const product = packageProducts().find(item =>
    normalizeProductName(item.name) === normalizeProductName(data.items)
  );
  const matchedPackage = product?.salesPackages.find(item =>
    item.enabled && Number(item.totalQuantityShipped || 0) === quantity
  );
  data.productId = product?.id || "";
  data.packageId = matchedPackage?.id || "";
  data.packageName = matchedPackage?.name || "";
  data.paidQuantity = matchedPackage ? Number(matchedPackage.paidQuantity || 0) : 0;
  data.freeQuantity = matchedPackage ? Number(matchedPackage.freeQuantity || 0) : 0;
  data.totalQuantityShipped = matchedPackage ? Number(matchedPackage.totalQuantityShipped || 0) : 0;
  data.packageExpenses = matchedPackage
    ? normalizePackageExpenses(matchedPackage.expenses).map(expense => ({ ...expense }))
    : [];
}

function renderOrderPackageExpenses(expenses = []) {
  const list = document.querySelector("#orderPackageExpenseList");
  if (!list) return;
  list.innerHTML = normalizePackageExpenses(expenses).map(expense => `
    <div class="package-expense-row" data-order-package-expense-id="${escapeHtml(expense.id)}">
      <label>ชื่อ<input name="orderPackageExpenseName" value="${escapeHtml(expense.name)}"></label>
      <label>จำนวนเงิน<input name="orderPackageExpenseAmount" type="number" min="0" step="0.01" value="${expense.amount}"></label>
      <label class="inline"><input name="orderPackageExpenseEnabled" type="checkbox" ${expense.enabled ? "checked" : ""} style="width:auto"> ใช้</label>
    </div>
  `).join("");
}

function selectedOrderPackageProduct() {
  const productId = els.orderForm?.elements?.productId?.value || "";
  return packageProducts().find(product => product.id === productId) || null;
}

function updateOrderPackageOptions(selectedPackageId = "", expenses = []) {
  const product = selectedOrderPackageProduct();
  const select = els.orderForm?.elements?.packageId;
  if (!select) return;
  const packages = (product?.salesPackages || []).filter(item => item.enabled || item.id === selectedPackageId);
  select.innerHTML = `<option value="">ไม่ใช้แพ็กเกจ</option>${packages.map(item => `
    <option value="${escapeHtml(item.id)}" ${item.id === selectedPackageId ? "selected" : ""}>${escapeHtml(item.name)}</option>
  `).join("")}`;
  renderOrderPackageExpenses(expenses);
}

function setupOrderPackageFields(order = null) {
  const section = document.querySelector("#orderPackageSection");
  const productSelect = els.orderForm?.elements?.productId;
  if (!section || !productSelect) return;
  const products = packageProducts();
  section.hidden = true;
  productSelect.innerHTML = `<option value="">เลือกสินค้า</option>${products.map(product => `
    <option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>
  `).join("")}`;
  const matchedProduct = products.find(product =>
    product.id === order?.productId || normalizeProductName(product.name) === normalizeProductName(order?.items)
  );
  productSelect.value = matchedProduct?.id || "";
  updateOrderPackageOptions(order?.packageId || "", order?.packageExpenses || []);
  for (const [name, value] of Object.entries({
    paidQuantity: order?.paidQuantity || "",
    freeQuantity: order?.freeQuantity || "",
    totalQuantityShipped: order?.totalQuantityShipped || ""
  })) {
    if (els.orderForm.elements[name]) els.orderForm.elements[name].value = value;
  }
}

function applySelectedOrderPackage() {
  const product = selectedOrderPackageProduct();
  const packageId = els.orderForm?.elements?.packageId?.value || "";
  const item = product?.salesPackages.find(entry => entry.id === packageId);
  if (!product || !item) {
    renderOrderPackageExpenses([]);
    return;
  }
  els.orderForm.elements.items.value = product.name;
  els.orderForm.elements.paidQuantity.value = item.paidQuantity;
  els.orderForm.elements.freeQuantity.value = item.freeQuantity;
  els.orderForm.elements.totalQuantityShipped.value = item.totalQuantityShipped;
  els.orderForm.elements.jars.value = item.totalQuantityShipped;
  els.orderForm.elements.amount.value = item.salePrice;
  renderOrderPackageExpenses(item.expenses);
}

function readOrderPackageExpenses() {
  return [...document.querySelectorAll("[data-order-package-expense-id]")].map(row => ({
    id: row.dataset.orderPackageExpenseId,
    name: row.querySelector("[name='orderPackageExpenseName']")?.value.trim() || "ค่าใช้จ่าย",
    amount: Math.max(0, Number(row.querySelector("[name='orderPackageExpenseAmount']")?.value || 0)),
    enabled: Boolean(row.querySelector("[name='orderPackageExpenseEnabled']")?.checked)
  }));
}

function openOrderDialog(order = null) {
  if (isMobileViewport() && app.view === "orders") {
    rememberMobileOrdersScrollPosition();
    closeMobileOrderActionMenu();
  }
  app.editingOrderId = order?.id || "";
  setOrderSaveState(false);
  const dateField = els.orderForm.elements.date;
  dateField.type = isMobileViewport() ? "datetime-local" : "date";
  els.orderForm.reset();
  delete els.orderForm.dataset.originSourceValue;
  els.orderDialogTitle.textContent = order ? "แก้ไขออเดอร์" : "เพิ่มออเดอร์";
  els.orderSubmitButton.textContent = order ? "บันทึกการแก้ไข" : "บันทึกออเดอร์";
  if (order) {
    const fields = {
      items: order.items,
      orderNumber: order.orderNumber,
      date: isMobileViewport() ? `${order.date}T${order.time || "09:00"}` : order.date,
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
    const dateValue = els.workDate.value || todayISO();
    const now = new Date();
    const timeValue = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    els.orderForm.elements.date.value = isMobileViewport() ? `${dateValue}T${timeValue}` : dateValue;
    els.orderForm.elements.amount.value = app.data?.settings?.defaultJarPrice || 750;
  }
  setupOrderPackageFields(order);
  const mobileRequiredFields = ["items", "orderNumber", "date", "sourceChannel", "name", "phone", "address", "jars", "amount"];
  for (const fieldName of mobileRequiredFields) {
    const field = els.orderForm.elements[fieldName];
    if (field) field.required = isMobileViewport() || ["date", "name", "phone", "jars", "amount"].includes(fieldName);
  }
  if (isMobileViewport()) {
    els.orderForm.elements.items.placeholder = "ชื่อ สินค้า";
    els.orderForm.elements.orderNumber.placeholder = "เช่น 1/1";
    els.orderForm.elements.sourceChannel.placeholder = "เช่น F: สมใจ / L: somjai";
    els.orderForm.elements.freeGift.placeholder = "เช่น แถมกระบอกน้ำ";
  } else {
    els.orderForm.elements.items.placeholder = "เช่น Zomin";
    els.orderForm.elements.orderNumber.placeholder = "เช่น 1/27";
    els.orderForm.elements.sourceChannel.placeholder = "เลือกหรือพิมพ์ช่องทางการสั่งซื้อ";
    els.orderForm.elements.freeGift.placeholder = "เช่น แถม 1 กระปุก, ค่าส่งฟรี";
  }
  els.orderDialog.showModal();
  if (isMobileViewport() && app.view === "orders") restoreMobileOrdersScrollPosition();
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

els.productDialog?.addEventListener("close", () => {
  document.body.classList.remove("modal-scroll-locked");
});

document.addEventListener("click", async event => {
  if (event.target.closest("#mobileMenuToggle")) {
    document.body.classList.toggle("sidebar-open");
  }

  if (event.target.closest("#headerNotificationButton")) {
    setView("notifications");
    return;
  }

  if (event.target.closest("[data-open-profile]")) {
    openProfileDialog();
    return;
  }

  if (event.target.closest("[data-pick-profile-image]")) {
    document.querySelector("#profileImageInput")?.click();
    return;
  }

  if (event.target.closest("[data-close-profile]")) {
    app.profileDraftImage = "";
    els.profileDialog?.close();
    return;
  }

  if (event.target.closest("[data-add-product]")) {
    openProductDialog();
  }

  if (event.target.closest("[data-products-filter-reset]")) {
    app.productsFilterQ = "";
    app.productsFilterStatus = "";
    renderProducts();
  }

  if (event.target.closest("[data-pick-product-image]")) {
    els.productImageFileInput?.click();
  }

  if (event.target.closest("[data-focus-product-image]")) {
    els.productForm?.elements?.image?.focus();
  }

  if (event.target.closest("[data-clear-product-image]")) {
    if (els.productForm?.elements?.image) {
      app.productDraftImage = "";
      els.productForm.elements.image.value = "";
      if (els.productImageFileInput) els.productImageFileInput.value = "";
      updateProductImagePreview("", els.productForm.elements.name?.value || "");
    }
  }

  if (event.target.closest("[data-add-sales-package]")) {
    app.productPackageDraft = readProductPackageDraft();
    const packageId = packageDraftId("package");
    app.productPackageDraft.push({
      id: packageId,
      name: `แพ็กเกจ ${app.productPackageDraft.length + 1}`,
      paidQuantity: 1,
      freeQuantity: 0,
      totalQuantityShipped: 1,
      salePrice: 0,
      enabled: true,
      expenses: []
    });
    app.productExpandedPackageId = packageId;
    renderProductPackageEditor();
    return;
  }

  const packageCard = event.target.closest("[data-sales-package-id]");
  if (packageCard && event.target.closest("[data-toggle-sales-package]")) {
    app.productPackageDraft = readProductPackageDraft();
    const packageId = packageCard.dataset.salesPackageId;
    app.productExpandedPackageId = app.productExpandedPackageId === packageId ? "" : packageId;
    renderProductPackageEditor();
    return;
  }

  if (packageCard && event.target.closest("[data-duplicate-sales-package]")) {
    app.productPackageDraft = readProductPackageDraft();
    const index = app.productPackageDraft.findIndex(item => item.id === packageCard.dataset.salesPackageId);
    if (index >= 0) {
      const original = app.productPackageDraft[index];
      const packageId = packageDraftId("package");
      app.productPackageDraft.splice(index + 1, 0, {
        ...original,
        id: packageId,
        name: `${original.name} สำเนา`,
        expenses: original.expenses.map(expense => ({ ...expense, id: packageDraftId("expense") }))
      });
      app.productExpandedPackageId = packageId;
      renderProductPackageEditor();
    }
    return;
  }

  if (packageCard && event.target.closest("[data-delete-sales-package]")) {
    app.productPackageDraft = readProductPackageDraft()
      .filter(item => item.id !== packageCard.dataset.salesPackageId);
    if (app.productExpandedPackageId === packageCard.dataset.salesPackageId) app.productExpandedPackageId = "";
    renderProductPackageEditor();
    return;
  }

  const movePackageButton = event.target.closest("[data-move-sales-package]");
  if (packageCard && movePackageButton) {
    app.productPackageDraft = readProductPackageDraft();
    const index = app.productPackageDraft.findIndex(item => item.id === packageCard.dataset.salesPackageId);
    const nextIndex = index + Number(movePackageButton.dataset.moveSalesPackage || 0);
    if (index >= 0 && nextIndex >= 0 && nextIndex < app.productPackageDraft.length) {
      const [item] = app.productPackageDraft.splice(index, 1);
      app.productPackageDraft.splice(nextIndex, 0, item);
      app.productExpandedPackageId = item.id;
      renderProductPackageEditor();
    }
    return;
  }

  if (packageCard && event.target.closest("[data-add-package-expense]")) {
    app.productPackageDraft = readProductPackageDraft();
    const item = app.productPackageDraft.find(entry => entry.id === packageCard.dataset.salesPackageId);
    if (item) {
      item.expenses.push({ id: packageDraftId("expense"), name: "", amount: 0, enabled: true });
      app.productExpandedPackageId = item.id;
      renderProductPackageEditor();
    }
    return;
  }

  const expenseRow = event.target.closest("[data-package-expense-id]");
  if (packageCard && expenseRow && event.target.closest("[data-delete-package-expense]")) {
    app.productPackageDraft = readProductPackageDraft();
    const item = app.productPackageDraft.find(entry => entry.id === packageCard.dataset.salesPackageId);
    if (item) item.expenses = item.expenses.filter(expense => expense.id !== expenseRow.dataset.packageExpenseId);
    renderProductPackageEditor();
    return;
  }

  const editProductButton = event.target.closest("[data-edit-product]");
  if (editProductButton) {
    const product = productRowsData().find(item => item.id === editProductButton.dataset.editProduct);
    if (product) openProductDialog(product);
  }

  const detailProductButton = event.target.closest("[data-product-details]");
  if (detailProductButton) {
    const product = productRowsData().find(item => item.id === detailProductButton.dataset.productDetails);
    if (product) renderProductDetail(product);
  }

  const archiveProductButton = event.target.closest("[data-archive-product]");
  if (archiveProductButton) {
    const productId = archiveProductButton.dataset.archiveProduct;
    const product = productRowsData().find(item => item.id === productId);
    if (product?.derived) {
      const payload = await api("/api/products", {
        method: "POST",
        body: JSON.stringify({ ...product, archived: true, status: "เก็บถาวร" })
      });
      if (payload.product?.id) {
        await api(`/api/products/${encodeURIComponent(payload.product.id)}/archive`, {
          method: "POST",
          body: "{}"
        });
      }
    } else {
      await api(`/api/products/${encodeURIComponent(productId)}/archive`, {
        method: "POST",
        body: "{}"
      });
    }
    showToast("เก็บถาวรสินค้าแล้ว");
    await loadState();
  }

  const navButton = event.target.closest("[data-view]");
  if (navButton) {
    const nextView = navButton.dataset.view;
    if (nextView !== "settings") clearBusinessManagementScrollRestore();
    if (nextView === "settings") app.mobileBusinessPage = "main";
    if (isMobileViewport()) await setMobileNavView(nextView);
    else setView(nextView);
    document.body.classList.remove("sidebar-open");
    return;
  }

  const businessPageButton = event.target.closest("[data-business-page]");
  if (businessPageButton && app.view === "settings") {
    const nextPage = businessPageButton.dataset.businessPage || "main";
    const statePage = history.state?.businessManagementPage || "main";
    if (nextPage === "main" && statePage !== "main") {
      history.back();
      return;
    }
    setBusinessManagementPage(nextPage);
    if (nextPage !== "main") window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const securityCardButton = event.target.closest("[data-security-card]");
  if (securityCardButton) {
    app.securityDetailKey = securityCardButton.dataset.securityCard || "";
    renderSettings();
    if (isMobileViewport()) {
      requestAnimationFrame(() => document.querySelector(".security-detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    return;
  }

  if (event.target.closest("[data-security-close]")) {
    app.securityDetailKey = "";
    renderSettings();
    return;
  }

  if (event.target.closest("[data-logout-all-devices]")) {
    showToast("ปุ่มนี้ถูกย้ายมาไว้ในส่วนอุปกรณ์แล้ว รอเชื่อมระบบออกจากระบบทุกอุปกรณ์");
    return;
  }

  const businessCustomerButton = event.target.closest("[data-business-customer]");
  if (businessCustomerButton && app.view === "settings") {
    app.mobileBusinessCustomerId = businessCustomerButton.dataset.businessCustomer;
    setBusinessManagementPage("customerDetail");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const businessProductButton = event.target.closest("[data-business-product]");
  if (businessProductButton && app.view === "settings") {
    app.mobileBusinessProductId = businessProductButton.dataset.businessProduct;
    app.mobileBusinessProductReturnPage = app.mobileBusinessPage === "finance" ? "finance" : "products";
    setBusinessManagementPage("productDetail");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const addUserButton = event.target.closest("[data-add-user]");
  if (addUserButton) {
    app.editingUserId = "__new";
    if (app.view === "settings") {
      setBusinessManagementPage("userEditor");
    } else {
      render();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const editUserButton = event.target.closest("[data-edit-user], [data-mobile-edit-user]");
  if (editUserButton) {
    app.editingUserId = editUserButton.dataset.editUser || editUserButton.dataset.mobileEditUser || "";
    if (app.view === "settings") {
      setBusinessManagementPage("userEditor");
    } else {
      render();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const userRow = event.target.closest("[data-user-row]");
  if (userRow && !event.target.closest("button")) {
    app.editingUserId = userRow.dataset.userRow;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (event.target.closest("[data-cancel-user-edit]")) {
    app.editingUserId = "";
    render();
    return;
  }

  if (event.target.closest("[data-user-editor-back]")) {
    app.editingUserId = "";
    setBusinessManagementPage("roles");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const deleteUserButton = event.target.closest("[data-delete-user]");
  if (deleteUserButton) {
    openDeleteUserDialog(deleteUserButton.dataset.deleteUser);
    return;
  }

  const editAdCostButton = event.target.closest("[data-edit-ad-cost]");
  if (editAdCostButton) {
    app.editingAdCostId = editAdCostButton.dataset.editAdCost;
    renderMobileBusinessManagement();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  if (event.target.closest("[data-cancel-ad-cost]")) {
    app.editingAdCostId = "";
    renderMobileBusinessManagement();
    return;
  }

  const toggleAdCostButton = event.target.closest("[data-toggle-ad-cost]");
  if (toggleAdCostButton) {
    const record = normalizeAdCostRecords().find(item => item.id === toggleAdCostButton.dataset.toggleAdCost);
    if (record) {
      await api(`/api/ad-costs/${encodeURIComponent(record.id)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !record.enabled })
      });
      showToast(record.enabled ? "ปิดใช้รายการค่าโฆษณาแล้ว" : "เปิดใช้รายการค่าโฆษณาแล้ว");
      await loadState();
    }
    return;
  }

  const deleteAdCostButton = event.target.closest("[data-delete-ad-cost]");
  if (deleteAdCostButton) {
    if (!window.confirm("ลบรายการค่าโฆษณานี้ใช่หรือไม่?")) return;
    await api(`/api/ad-costs/${encodeURIComponent(deleteAdCostButton.dataset.deleteAdCost)}`, { method: "DELETE" });
    app.editingAdCostId = "";
    showToast("ลบรายการค่าโฆษณาแล้ว");
    await loadState();
    return;
  }

  const editAdPlatformButton = event.target.closest("[data-edit-ad-platform]");
  if (editAdPlatformButton) {
    app.editingAdPlatformId = editAdPlatformButton.dataset.editAdPlatform;
    renderMobileBusinessManagement();
    return;
  }

  if (event.target.closest("[data-cancel-ad-platform]")) {
    app.editingAdPlatformId = "";
    renderMobileBusinessManagement();
    return;
  }

  const toggleAdPlatformButton = event.target.closest("[data-toggle-ad-platform]");
  if (toggleAdPlatformButton) {
    const platform = normalizeAdPlatforms().find(item => item.id === toggleAdPlatformButton.dataset.toggleAdPlatform);
    if (platform) {
      await api(`/api/ad-platforms/${encodeURIComponent(platform.id)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !platform.enabled })
      });
      showToast(platform.enabled ? "ปิดใช้แพลตฟอร์มแล้ว" : "เปิดใช้แพลตฟอร์มแล้ว");
      await loadState();
    }
    return;
  }

  const deleteAdPlatformButton = event.target.closest("[data-delete-ad-platform]");
  if (deleteAdPlatformButton) {
    if (!window.confirm("ลบแพลตฟอร์มนี้ใช่หรือไม่? รายการค่าโฆษณาเดิมจะยังคงอยู่")) return;
    await api(`/api/ad-platforms/${encodeURIComponent(deleteAdPlatformButton.dataset.deleteAdPlatform)}`, { method: "DELETE" });
    app.editingAdPlatformId = "";
    showToast("ลบแพลตฟอร์มแล้ว");
    await loadState();
    return;
  }

  const shortcut = event.target.closest("[data-view-shortcut]");
  if (shortcut) {
    setView(shortcut.dataset.viewShortcut);
    document.body.classList.remove("sidebar-open");
  }

  if (event.target.closest("[data-open-order]") && app.view === "orders") openOrderDialog();

  const mobileOrderActions = event.target.closest("[data-mobile-order-actions]");
  if (mobileOrderActions && app.view === "orders" && isMobileViewport()) {
    const orderId = mobileOrderActions.dataset.mobileOrderActions;
    toggleMobileOrderActionMenu(orderId, mobileOrderActions);
    return;
  }

  if (event.target.closest("[data-mobile-orders-filter]") && app.view === "orders" && isMobileViewport()) {
    const searchInput = document.querySelector("[data-order-filter='q']");
    app.ordersFilterDraft = searchInput?.value ?? app.ordersFilterDraft;
    app.ordersFilterQ = app.ordersFilterDraft;
    app.mobileOrderMenuId = "";
    renderOrders();
    return;
  }

  if (event.target.closest("[data-mobile-orders-sort]") && app.view === "orders" && isMobileViewport()) {
    app.mobileOrdersDescending = !app.mobileOrdersDescending;
    app.mobileOrderMenuId = "";
    renderOrders();
    return;
  }

  const opportunityFilter = event.target.closest("[data-mobile-opportunity-filter]");
  if (opportunityFilter && app.view === "opportunities") {
    app.mobileOpportunityFilter = opportunityFilter.dataset.mobileOpportunityFilter;
    renderOpportunities();
    return;
  }

  if (event.target.closest("[data-mobile-opportunity-sort]") && app.view === "opportunities") {
    app.mobileOpportunitySort = app.mobileOpportunitySort === "urgency" ? "value" : "urgency";
    renderOpportunities();
    return;
  }

  const editOrderButton = event.target.closest("[data-edit-order]");
  if (editOrderButton) {
    const order = app.data.orders.find(item => item.id === editOrderButton.dataset.editOrder);
    if (order) openOrderDialog(order);
  }

  const deleteOrderButton = event.target.closest("[data-delete-order]");
  if (deleteOrderButton) openDeleteOrderDialog(deleteOrderButton.dataset.deleteOrder);

  if (
    app.view === "orders"
    && isMobileViewport()
    && app.mobileOrderMenuId
    && !event.target.closest("[data-mobile-order-menu]")
  ) {
    closeMobileOrderActionMenu();
  }

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

  if (event.target.closest("[data-copy-webhook]")) {
    copyText(`${location.origin}/api/line/webhook`);
  }

  if (event.target.closest("[data-reset-settings]")) {
    renderSettings();
  }

  if (event.target.closest("[data-add-additional-cost]")) {
    const list = document.querySelector("#additionalCostList");
    if (list) {
      list.querySelector(".empty-state")?.remove();
      list.insertAdjacentHTML("beforeend", createAdditionalCostRow({ enabled: true }));
      refreshAdditionalCostsSummary();
    }
  }

  const editAdditionalCost = event.target.closest("[data-edit-additional-cost]");
  if (editAdditionalCost) {
    const row = editAdditionalCost.closest("[data-additional-cost-row]");
    const isEditing = row?.classList.contains("is-editing");
    if (row && isEditing && !row.querySelector("[name='additionalCostName']")?.value.trim()) {
      showToast("กรอกชื่อรายการต้นทุนเพิ่มเติมก่อน");
      return;
    }
    toggleCostRowEditing(row, !isEditing);
    refreshAdditionalCostsSummary();
  }

  const editProductCost = event.target.closest("[data-edit-product-cost]");
  if (editProductCost) {
    const row = editProductCost.closest("[data-product-cost-row]");
    toggleCostRowEditing(row, !row?.classList.contains("is-editing"));
  }

  const deleteAdditionalCost = event.target.closest("[data-delete-additional-cost]");
  if (deleteAdditionalCost) {
    deleteAdditionalCost.closest("[data-additional-cost-row]")?.remove();
    refreshAdditionalCostsSummary();
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
      renderCurrentImportSurface();
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

  if (event.target.closest("[data-order-search]")) {
    app.ordersFilterQ = app.ordersFilterDraft;
    renderOrders();
  }

  if (event.target.closest("[data-close-order]")) {
    app.editingOrderId = "";
    els.orderDialog.close();
    if (app.view === "orders" && isMobileViewport()) restoreMobileOrdersScrollPosition();
  }

  if (event.target.closest("[data-close-delete-order]")) {
    app.deletingOrderId = "";
    els.deleteOrderDialog.close();
    if (app.view === "orders" && isMobileViewport()) renderOrders();
  }

  if (event.target.closest("[data-close-delete-customer]")) {
    app.deletingCustomerId = "";
    els.deleteCustomerDialog.close();
  }

  if (event.target.closest("[data-close-delete-user]")) {
    app.deletingUserId = "";
    els.deleteUserDialog.close();
  }

  if (event.target.closest("[data-close-customer]")) els.customerDialog.close();
  if (event.target.closest("[data-close-profile]")) els.profileDialog.close();
  if (event.target.closest("[data-close-product]")) {
    app.editingProductId = "";
    app.productDraftImage = "";
    app.productOriginalImage = "";
    app.productPackageDraft = [];
    app.productExpandedPackageId = "";
    app.productSavePending = false;
    setProductSaveState(false);
    els.productDialog.close();
  }
  if (event.target.closest("[data-close-product-detail]")) els.productDetailDialog.close();

});

document.addEventListener("dragover", event => {
  const zone = event.target.closest?.(".import-upload-card");
  if (!zone) return;
  event.preventDefault();
  zone.classList.add("drag-over");
});

document.addEventListener("dragleave", event => {
  const zone = event.target.closest?.(".import-upload-card");
  if (zone) zone.classList.remove("drag-over");
});

document.addEventListener("drop", event => {
  const zone = event.target.closest?.(".import-upload-card");
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove("drag-over");
  const file = event.dataTransfer?.files?.[0];
  const input = zone.querySelector("#csvFile");
  if (!file || input?.disabled) return;
  if (input) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  }
  startCsvImport(file);
});

document.addEventListener("input", event => {
  if (event.target?.name === "totalQuantityShipped" && event.target.form?.id === "orderForm") {
    els.orderForm.elements.jars.value = event.target.value;
  }

  if (event.target?.matches?.("[name='packagePaidQuantity'], [name='packageFreeQuantity']")) {
    const card = event.target.closest("[data-sales-package-id]");
    const paid = Number(card?.querySelector("[name='packagePaidQuantity']")?.value || 0);
    const free = Number(card?.querySelector("[name='packageFreeQuantity']")?.value || 0);
    const total = card?.querySelector("[name='packageTotalQuantity']");
    if (total) total.value = String(Math.max(0, paid + free));
  }

  const filter = event.target.closest("[data-filter]");
  if (filter) {
    app.filters[filter.dataset.filter] = filter.value;
    updateSearchResults();
  }

  const orderFilter = event.target.closest("[data-order-filter]");
  if (orderFilter) {
    app.ordersFilterDraft = orderFilter.value;
  }

  const opportunitySearch = event.target.closest("[data-mobile-opportunity-search] input[name='q']");
  if (opportunitySearch) {
    app.mobileOpportunitySearchDraft = opportunitySearch.value;
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

  if (event.target?.matches?.("[name='additionalCostName'], [name='additionalCostAmount'], [name='additionalCostEnabled'], [name='additionalCostType']")) {
    updateAdditionalCostRowSummary(event.target.closest("[data-additional-cost-row]"));
    refreshAdditionalCostsSummary();
  }

  const productFilter = event.target.closest("[data-products-filter]");
  if (productFilter) {
    if (productFilter.dataset.productsFilter === "q") app.productsFilterQ = productFilter.value;
    if (productFilter.dataset.productsFilter === "status") app.productsFilterStatus = productFilter.value;
    renderProducts();
  }

  if (event.target?.matches?.("[data-product-image-input]")) {
    app.productDraftImage = event.target.value;
    updateProductImagePreview(event.target.value, els.productForm?.elements?.name?.value || "");
  }

  if (event.target?.name === "name" && event.target.form?.id === "productForm") {
    updateProductImagePreview(app.productDraftImage, event.target.value);
  }

  if (event.target?.name === "displayName" && event.target.form?.id === "profileForm") {
    setProfileSaveState(false);
  }

  if (elementId(event.target?.form) === "teamForm") {
    setTeamSaveState(event.target.form, "idle");
  }
});

document.addEventListener("change", event => {
  if (elementId(event.target?.form) === "teamForm") {
    setTeamSaveState(event.target.form, "idle");
  }
  if (event.target === els.orderForm.elements.originSourceChoice) syncOriginSourceFields();
  if (event.target === els.orderForm.elements.productId) {
    const product = selectedOrderPackageProduct();
    if (product) els.orderForm.elements.items.value = product.name;
    updateOrderPackageOptions();
  }
  if (event.target === els.orderForm.elements.packageId) applySelectedOrderPackage();
  if (event.target?.matches?.("[name='additionalCostType'], [name='additionalCostEnabled']")) {
    updateAdditionalCostRowSummary(event.target.closest("[data-additional-cost-row]"));
    refreshAdditionalCostsSummary();
  }
});

document.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  if (event.target?.matches?.("[data-order-filter]")) {
    event.preventDefault();
    app.ordersFilterDraft = event.target.value;
    app.ordersFilterQ = event.target.value;
    renderOrders();
  }
});

document.addEventListener("change", async event => {
  if (event.target === els.workDate) {
    app.ordersShowAll = false;
    app.customersShowAll = false;
    if (isMobileViewport() && app.data) {
      const startedAt = performance.now();
      const selectedDate = event.target.value || todayISO();
      console.info("[Mobile date] Date change start", { view: app.view, selectedDate });
      app.ordersFilterQ = "";
      app.ordersFilterDraft = "";
      app.mobileOrdersDateOnly = true;
      app.mobileOrderMenuId = "";
      const calculationStartedAt = performance.now();
      app.data.summary = buildLocalSummary(selectedDate);
      if (app.view === "reports") {
        app.reportDate = selectedDate;
        app.reportMonth = monthKey(selectedDate);
      }
      const calculationTime = performance.now() - calculationStartedAt;
      if (els.workDateDisplay) els.workDateDisplay.textContent = formatMobileDatePill(selectedDate);
      const domStartedAt = performance.now();
      if (app.view === "orders") renderOrders();
      else patchMobileDateView();
      const domUpdateTime = performance.now() - domStartedAt;
      const totalTime = performance.now() - startedAt;
      console.info("[Mobile date] Data calculation time", `${calculationTime.toFixed(2)} ms`);
      console.info("[Mobile date] DOM update time", `${domUpdateTime.toFixed(2)} ms`);
      console.info("[Mobile date] Total render time", `${totalTime.toFixed(2)} ms`);
      return;
    }
    if (app.data) {
      const startedAt = performance.now();
      const selectedDate = event.target.value || todayISO();
      console.info("[Desktop date] Date change start", { view: app.view, selectedDate });
      const calculationStartedAt = performance.now();
      refreshDesktopDateSensitiveCustomers(selectedDate);
      app.data.summary = buildLocalSummary(selectedDate);
      const calculationTime = performance.now() - calculationStartedAt;
      if (els.workDateDisplay) els.workDateDisplay.textContent = formatDatePill(selectedDate);
      const domStartedAt = performance.now();
      renderDesktopDateView();
      const domUpdateTime = performance.now() - domStartedAt;
      const totalTime = performance.now() - startedAt;
      console.info("[Desktop date] Data calculation time", `${calculationTime.toFixed(2)} ms`);
      console.info("[Desktop date] DOM update time", `${domUpdateTime.toFixed(2)} ms`);
      console.info("[Desktop date] Total render time", `${totalTime.toFixed(2)} ms`);
      return;
    }
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

  if (event.target?.matches?.("[data-marketing-date]")) {
    app.marketingDate = event.target.value || todayISO();
    renderMobileBusinessManagement();
  }

  if (event.target?.matches?.("[data-marketing-month]")) {
    app.marketingMonth = event.target.value || todayISO().slice(0, 7);
    renderMobileBusinessManagement();
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

  if (event.target === els.productImageFileInput) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const result = await compressProductImageFile(file);
      if (!result) return;
      app.productDraftImage = result;
      if (els.productForm.elements.image) els.productForm.elements.image.value = "";
      updateProductImagePreview(result, els.productForm.elements.name?.value || "");
    } catch (error) {
      console.error(error);
      showToast("อ่านไฟล์รูปไม่สำเร็จ", "error");
    }
  }

  if (event.target?.id === "profileImageInput") {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = loadEvent => {
      const result = String(loadEvent.target?.result || "");
      if (!result) return;
      app.profileDraftImage = result;
      syncProfileAvatarPreview();
      setProfileSaveState(false);
    };
    reader.readAsDataURL(file);
  }

  if (event.target?.id === "importSheetSelect" && app.importWorker) {
    app.importPreparing = true;
    renderCurrentImportSurface();
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
  const currentFormId = elementId(form);

  try {
    if (form.matches("[data-mobile-opportunity-search]")) {
      app.mobileOpportunitySearchDraft = String(new FormData(form).get("q") || "");
      app.mobileOpportunitySearch = app.mobileOpportunitySearchDraft;
      renderOpportunities();
      return;
    }

    if (currentFormId === "loginForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      const payload = await api("/api/login", {
        method: "POST",
        body: JSON.stringify(data)
      });
      saveSession(payload.user);
      clearBusinessManagementScrollRestore();
      app.mobileBusinessPage = "main";
      app.view = "dashboard";
      navigateToView("dashboard");
      showToast("เข้าสู่ระบบแล้ว");
      render();
      loadStateAfterLogin();
      return;
    }

    if (currentFormId === "orderForm") {
      await submitOrder(form);
    }

    if (currentFormId === "productForm") {
      if (app.productSavePending) return;
      setProductSaveState(true);
      const data = Object.fromEntries(new FormData(form).entries());
      delete data.imageFile;
      if (app.productDraftImage !== app.productOriginalImage) data.image = app.productDraftImage;
      else delete data.image;
      data.salesPackages = readProductPackageDraft();
      data.followUpEnabled = form.elements.followUpEnabled.checked;
      const editingProduct = productRowsData().find(item => item.id === app.editingProductId);
      const useCreate = !app.editingProductId || editingProduct?.derived;
      const url = useCreate ? "/api/products" : `/api/products/${encodeURIComponent(app.editingProductId)}`;
      const method = useCreate ? "POST" : "PUT";
      try {
        const payload = await api(url, {
          method,
          body: JSON.stringify(data)
        });
        applyProductSavePayload(payload);
        app.editingProductId = "";
        app.productDraftImage = "";
        app.productOriginalImage = "";
        app.productPackageDraft = [];
        app.productExpandedPackageId = "";
        if (els.productImageFileInput) els.productImageFileInput.value = "";
        els.productDialog.close();
        showToast("บันทึกสินค้าแล้ว");
        render();
      } finally {
        setProductSaveState(false);
      }
    }

    if (currentFormId === "deleteOrderForm" && app.deletingOrderId) {
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

    if (currentFormId === "deleteCustomerForm" && app.deletingCustomerId) {
      await api(`/api/customers/${encodeURIComponent(app.deletingCustomerId)}`, {
        method: "DELETE"
      });
      app.deletingCustomerId = "";
      els.deleteCustomerDialog.close();
      els.customerDialog.close();
      showToast("ลบลูกค้าแล้ว");
      await loadState();
    }

    if (currentFormId === "deleteUserForm" && app.deletingUserId) {
      await api(`/api/team/${encodeURIComponent(app.deletingUserId)}`, {
        method: "DELETE"
      });
      app.deletingUserId = "";
      app.editingUserId = "";
      els.deleteUserDialog.close();
      if (isMobileViewport()) app.mobileBusinessPage = "roles";
      showToast("ลบผู้ใช้งานแล้ว");
      await loadState();
    }

    if (currentFormId === "logoutForm") {
      try {
        await api("/api/logout", { method: "POST" });
      } catch {
        // Session may already be expired; still return to login.
      }
      els.logoutDialog.close();
      clearSession();
      clearBusinessManagementScrollRestore();
      app.mobileBusinessPage = "main";
      app.view = "login";
      navigateToView("login");
      render();
    }

    if (currentFormId === "teamForm") {
      if (app.teamSavePending) return;
      app.teamSavePending = true;
      setTeamSaveState(form, "saving");
      const data = Object.fromEntries(new FormData(form).entries());
      const id = String(data.id || "").trim();
      delete data.id;
      try {
        const payload = await api(id ? `/api/team/${encodeURIComponent(id)}` : "/api/team", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data)
        });
        invalidateStateRequests();
        applySavedUser(payload.user);
        patchVisibleUserRow(payload.user);
        showToast("บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว");
        setTeamSaveState(form, "saved");
        window.setTimeout(() => {
          if (!form.isConnected) return;
          if (!id) {
            app.editingUserId = "";
            if (isMobileViewport()) app.mobileBusinessPage = "roles";
            render();
          } else if (form.querySelector('button[type="submit"]')?.dataset.saveState === "saved") {
            setTeamSaveState(form, "idle");
          }
        }, 2000);
      } catch (error) {
        setTeamSaveState(form, "idle");
        showToast(error.message || "บันทึกผู้ใช้งานไม่สำเร็จ");
        return;
      } finally {
        app.teamSavePending = false;
      }
    }

    if (currentFormId === "tagsForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/tags", {
        method: "POST",
        body: JSON.stringify(data)
      });
      showToast("เพิ่มอาการลูกค้าแล้ว");
      form.reset();
      await loadState();
    }

    if (currentFormId === "adCostForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      const product = productRowsData().find(item => item.id === data.productId);
      const platform = normalizeAdPlatforms().find(item => item.id === data.platformId);
      data.productName = product?.name || "";
      data.platformName = platform?.name || "";
      data.value = Number(data.value || 0);
      data.enabled = form.elements.enabled.checked;
      const id = String(data.id || "");
      delete data.id;
      await api(id ? `/api/ad-costs/${encodeURIComponent(id)}` : "/api/ad-costs", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(data)
      });
      app.editingAdCostId = "";
      showToast(id ? "แก้ไขค่าโฆษณาแล้ว" : "เพิ่มค่าโฆษณาแล้ว");
      await loadState();
      return;
    }

    if (currentFormId === "adPlatformForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      data.enabled = form.elements.enabled.checked;
      const id = String(data.id || "");
      delete data.id;
      await api(id ? `/api/ad-platforms/${encodeURIComponent(id)}` : "/api/ad-platforms", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(data)
      });
      app.editingAdPlatformId = "";
      showToast(id ? "แก้ไขแพลตฟอร์มแล้ว" : "เพิ่มแพลตฟอร์มแล้ว");
      await loadState();
      return;
    }

    if (currentFormId === "settingsForm") {
      const settingsSaveButton = form.querySelector("[data-settings-save]");
      if (settingsSaveButton) {
        if (app.settingsSavePending) return;
        app.settingsSavePending = true;
        setSettingsSaveState("saving", settingsSaveButton);
        const data = readFinanceSettingsForm(form);
        const payload = await api("/api/settings/finance", {
          method: "PUT",
          body: JSON.stringify(data)
        });
        if (app.data?.settings) {
          app.data.settings = {
            ...app.data.settings,
            ...(payload.settings || data)
          };
        }
        setSettingsSaveState("saved", settingsSaveButton);
        await new Promise(resolve => setTimeout(resolve, 1200));
        showToast("บันทึกต้นทุนและค่าใช้จ่ายแล้ว");
        app.settingsSavePending = false;
        renderSettings();
        return;
      }
      const data = Object.fromEntries(new FormData(form).entries());
      if (form.elements.lineWebhookEnabled) data.lineWebhookEnabled = form.elements.lineWebhookEnabled.checked;
      if (form.elements.staffCanExport) data.staffCanExport = form.elements.staffCanExport.checked;
      data.followUpDaysPerUnit = Math.max(1, Number(form.elements.daysPerUnit?.value || app.data?.settings?.followUpDaysPerUnit || 15));
      if (form.querySelector("[data-product-cost-row]")) {
        data.productCosts = Array.from(form.querySelectorAll("[data-product-cost-row]")).map(row => ({
          id: row.dataset.id,
          name: row.querySelector("[name='productCostName']")?.value.trim(),
          costPerJar: Number(row.querySelector("[name='productCostAmount']")?.value || 0),
          enabled: row.querySelector("[name='productCostEnabled']")?.checked
        })).filter(item => item.name);
      }
      if (form.querySelector("[data-additional-cost-row]")) {
        data.additionalCosts = Array.from(form.querySelectorAll("[data-additional-cost-row]")).map(row => ({
          id: row.dataset.id,
          name: row.querySelector("[name='additionalCostName']")?.value.trim(),
          amount: Number(row.querySelector("[name='additionalCostAmount']")?.value || 0),
          type: row.querySelector("[name='additionalCostType']")?.value || "fixed_per_order",
          enabled: row.querySelector("[name='additionalCostEnabled']")?.checked
        })).filter(item => item.name);
      }
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      if (settingsSaveButton) {
        setSettingsSaveState("saved", settingsSaveButton);
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      showToast("บันทึกการตั้งค่าแล้ว");
      app.settingsSavePending = false;
      await loadState();
    }

    if (currentFormId === "settingsVipForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกตั้งค่า VIP แล้ว");
      await loadState();
    }

    if (currentFormId === "vipThresholdForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกยอด VIP แล้ว");
      await loadState();
    }

    if (currentFormId === "settingsLineForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      data.lineWebhookEnabled = form.elements.lineWebhookEnabled.checked;
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(data)
      });
      showToast("บันทึกตั้งค่า LINE OA แล้ว");
      await loadState();
    }

    if (currentFormId === "rulesForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/followup-rules", {
        method: "PUT",
        body: JSON.stringify({ daysPerUnit: data.daysPerUnit })
      });
      showToast("บันทึกค่า Follow-up แล้ว");
      await loadState();
    }

    if (currentFormId === "contactForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api("/api/contact-log", {
        method: "POST",
        body: JSON.stringify(data)
      });
      showToast("บันทึกการติดต่อแล้ว");
      els.customerDialog.close();
      await loadState();
    }

    if (currentFormId === "customerEditForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      await api(`/api/customers/${encodeURIComponent(data.customerId)}`, {
        method: "PUT",
        body: JSON.stringify({ tags: data.tags, note: data.note })
      });
      showToast("บันทึกข้อมูลลูกค้าแล้ว");
      els.customerDialog.close();
      await loadState();
    }

    if (currentFormId === "profileForm") {
      const data = Object.fromEntries(new FormData(form).entries());
      const displayName = String(data.displayName || "").trim();
      if (!displayName) {
        showToast("กรุณาใส่ชื่อที่ต้องการแสดง");
        return;
      }
      setProfileSaveState(true);
      try {
        const avatar = app.profileDraftImage || app.currentUser?.avatar || "";
        const payload = await api("/api/profile", {
          method: "PUT",
          body: JSON.stringify({ displayName, avatar })
        });
        invalidateStateRequests();
        app.currentUser = {
          ...payload.user,
          avatar: payload.user?.avatar || avatar
        };
        if (app.data) {
          app.data.currentUser = app.currentUser;
          const userIndex = (app.data.users || []).findIndex(user => user.id === app.currentUser.id);
          if (userIndex >= 0) app.data.users[userIndex] = app.currentUser;
        }
        cacheMobileProfile(app.currentUser);
        app.profileDraftImage = "";
        updateShell();
        els.profileDialog?.close();
        showToast("บันทึกโปรไฟล์แล้ว");
      } finally {
        setProfileSaveState(false);
      }
    }

  } catch (error) {
    app.settingsSavePending = false;
    setSettingsSaveState("idle");
    setProfileSaveState(false);
    showToast(error.message);
    return;
  }
  setProfileSaveState(false);
});

window.addEventListener("hashchange", syncViewFromLocation);
window.addEventListener("popstate", syncViewFromLocation);
window.addEventListener("resize", handleViewportResize);
window.addEventListener("focus", () => {
  refreshCurrentUser().catch(error => console.warn("[user-sync]", error.message || error));
  refreshSharedState({ force: true }).catch(error => console.warn("[state-sync]", error.message || error));
});
window.addEventListener("pageshow", event => {
  refreshCurrentUser().catch(error => console.warn("[user-sync]", error.message || error));
  refreshSharedState({ force: Boolean(event.persisted) }).catch(error => console.warn("[state-sync]", error.message || error));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshCurrentUser().catch(error => console.warn("[user-sync]", error.message || error));
    refreshSharedState({ force: true }).catch(error => console.warn("[state-sync]", error.message || error));
  }
});
window.setInterval(() => {
  refreshCurrentUser().catch(error => console.warn("[user-sync]", error.message || error));
}, 5000);

// Add-order entry point is now rendered only inside the Orders page.
if (els.workDate) els.workDate.value = todayISO();

async function init() {
  await restoreSession();
  if (!app.currentUser) {
    clearBusinessManagementScrollRestore();
    app.mobileBusinessPage = "main";
    app.view = "login";
    navigateToView("login", true);
    render();
    return;
  }
  await loadState();
  if (isImportCenterActive()) await refreshImportJob();
}

async function startApp() {
  try {
    await init();
  } catch (error) {
    els.content.innerHTML = `<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
  } finally {
    await finishAppStartup();
  }
}

startApp();
