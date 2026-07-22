const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

function assert(condition, message) {
  if (!condition) {
    console.error(`Theme selector test failed: ${message}`);
    process.exit(1);
  }
}

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(root, "public", "service-worker.js"), "utf8");
const jsonAdapter = fs.readFileSync(path.join(root, "lib", "db", "json-adapter.js"), "utf8");
const supabaseAdapter = fs.readFileSync(path.join(root, "lib", "db", "supabase-adapter.js"), "utf8");

assert(html.indexOf('const preference = "system"') < html.indexOf("/styles.css?v=20260722-customer-light-cache-v1"), "theme bootstrap must default to System before stylesheet load");
assert(html.includes('document.documentElement.dataset.theme = resolved'), "theme bootstrap must set resolved theme before render");
assert(!html.includes("growup_theme_preference_v1"), "bootstrap must not read a shared theme key before authentication");
assert(html.includes('/app.js?v=20260722-customer-light-cache-v1'), "app asset version must be bumped");

assert(appJs.includes('const THEME_STORAGE_PREFIX = "growup-theme:"'), "theme storage must be namespaced per user");
assert(!appJs.includes("growup_theme_preference_v1"), "client must not use a shared theme storage key");
assert(appJs.includes('const THEME_OPTIONS = new Set(["dark", "light", "system"])'), "client theme options must be exactly dark/light/system");
assert(appJs.includes("function applyThemePreference"), "theme apply helper missing");
assert(appJs.includes('return THEME_OPTIONS.has(value) ? value : "system"'), "invalid client theme values must fall back to System");
assert(appJs.includes('applyThemePreference("system", { persistLocal: false })'), "logout/session cleanup must return the document to System");
assert(appJs.includes('window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change"'), "System mode must react to device theme changes");
assert(appJs.includes("[data-theme-select]"), "Display theme selector change handler missing");
const profileDialogHtml = html.slice(html.indexOf('<dialog id="profileDialog"'), html.indexOf('<dialog id="lineVideoDialog"'));
assert(!profileDialogHtml.includes("data-profile-theme-select"), "Profile dialog must not include the personal theme selector");
assert(!profileDialogHtml.includes("profileTheme"), "Profile dialog must not keep the removed theme field name");
assert(!profileDialogHtml.includes(">Theme<") && !profileDialogHtml.includes(">ธีม<") && !profileDialogHtml.includes(">ธีมหน้าจอ<"), "Profile dialog must not show a theme label");
assert((profileDialogHtml.match(/class="span-2"/g) || []).length === 1, "Profile dialog must not leave an empty theme field gap");
assert(html.includes("data-clear-profile-image"), "Profile dialog must allow users to remove their own avatar");
assert(!appJs.includes("[data-profile-theme-select]"), "Profile theme selector handler must be removed");
assert(appJs.includes("profileAvatarRemovePending"), "Profile avatar removal must distinguish remove from unchanged avatar");
assert(appJs.includes("PROFILE_AVATAR_ALLOWED_TYPES"), "Profile avatar upload must validate MIME types before reading");
assert(appJs.includes("function userAvatarMarkup"), "Users list must render real user avatars before initials fallback");
assert(appJs.includes("markAvatarImagesLoaded(els.content)"), "Users list avatars must register load/error fallback handlers");
assert(appJs.includes("function saveCurrentUserThemePreference"), "Theme controls must share one save helper");
const saveHelperStart = appJs.indexOf("async function saveCurrentUserThemePreference");
const saveHelperEnd = appJs.indexOf("function todayISO", saveHelperStart);
const saveHelper = appJs.slice(saveHelperStart, saveHelperEnd);
assert(saveHelper.includes('applyThemePreference(normalized, { persistLocal: true, userId })'), "theme must apply and update localStorage synchronously before API");
assert(saveHelper.indexOf('applyThemePreference(normalized, { persistLocal: true, userId })') < saveHelper.indexOf('flushThemeSaveQueue()'), "visible theme update must happen before the API request starts");
assert(!saveHelper.includes("await app.themeSavePromise"), "theme switching must not wait for an older network request before updating UI");
assert(saveHelper.includes("app.themeSaveSequence"), "background theme saves must guard against stale API responses");
assert(appJs.includes("function userWithActiveThemePreference"), "stale user payloads must be merged with the active optimistic theme");
assert(appJs.includes("function flushThemeSaveQueue"), "theme saves must be serialized so the latest selection wins on the server");
assert(appJs.includes("settleThemeSaveWaiters({ latestSequence, saved: true })"), "only the latest persisted selection should resolve as saved");
assert(appJs.includes("rollbackThemePreference(userId, rollbackPreference)"), "latest save failure must roll back to the last persisted theme");
assert(appJs.includes('document.querySelectorAll("[data-theme-select]")'), "Display selector must stay synchronized");
assert(appJs.includes('document.querySelectorAll("[data-theme-button]")'), "Sidebar theme buttons must stay synchronized");
assert(appJs.includes('button.classList.toggle("is-active", active)') && appJs.includes('button.setAttribute("aria-pressed", active ? "true" : "false")'), "Sidebar theme buttons must expose active state");
assert(appJs.includes('document.querySelectorAll("[data-mobile-theme-icon]")'), "Mobile header icon must reflect the current theme preference");
assert(appJs.includes('document.querySelectorAll("[data-mobile-theme-option]")'), "Mobile bottom sheet options must expose active state");
assert(appJs.includes('["dark", "มืด"') && appJs.includes('["light", "สว่าง"') && appJs.includes('["system", "อัตโนมัติ"'), "Theme controls must expose Thai Dark, Light, System labels");
assert(appJs.includes('settingsUnifiedCard("ธีมหน้าจอ", "เปลี่ยนตามการตั้งค่าของอุปกรณ์"'), "Display settings theme selector must be localized");
assert(appJs.includes('<label>ธีมหน้าจอ'), "Display settings theme heading must be localized");
assert(appJs.includes('class="sidebar-theme-controls"') && appJs.indexOf('class="sidebar-upgrade-card"') < appJs.indexOf('${themeControlMarkup()}'), "Sidebar theme buttons must render directly below Upgrade Pro");
assert(appJs.includes('data-theme-button="${value}"') && appJs.includes('aria-label="${label}" title="${label}"'), "Sidebar theme buttons must have Thai aria-labels and tooltips");
assert(appJs.includes('const themeButton = event.target.closest("[data-theme-button]")'), "Sidebar theme button click handler missing");
assert(appJs.includes('saveCurrentUserThemePreference(themeButton.dataset.themeButton)'), "Sidebar theme buttons must persist through the existing per-user save helper");
assert(appJs.includes('if (event.target.closest("#mobileThemeButton"))') && appJs.includes("openMobileThemeSheet()"), "Mobile header theme button must open the bottom sheet");
assert(appJs.includes('const mobileThemeOption = event.target.closest("[data-mobile-theme-option]")'), "Mobile bottom sheet option handler missing");
assert(appJs.includes('saveCurrentUserThemePreference(mobileThemeOption.dataset.mobileThemeOption)'), "Mobile bottom sheet must persist through the existing per-user save helper");
assert(appJs.includes("function openMobileThemeSheet") && appJs.includes("function closeMobileThemeSheet"), "Mobile theme bottom sheet open/close helpers missing");
assert(appJs.includes('document.documentElement.dataset.themePreference\n    || app.currentUser?.themePreference'), "Auto mode must follow device changes using the current optimistic preference first");
assert(appJs.includes('if (event.target?.matches?.("[data-theme-select]"))') && appJs.includes('saveCurrentUserThemePreference(event.target.value)'), "Display selector must switch and persist immediately");
assert(appJs.includes('/api/profile/theme'), "theme must persist through the per-user profile theme endpoint");
assert(!appJs.includes('app.data?.settings?.displayPreferences?.theme'), "theme must not be read from shared business settings");
assert(appJs.includes('if (["settingsStore", "settingsGoals", "settingsAi", "settingsNotifications", "settingsDisplay", "settingsFollowup", "settingsVip"].includes(view)) return can("system.business");'), "Display settings permission gate must remain unchanged");

assert(serverJs.includes('const allowedThemes = new Set(["dark", "light", "system"])'), "server theme whitelist must be exactly dark/light/system");
assert(serverJs.includes('theme: allowedThemes.has(preferences.theme) ? preferences.theme : "system"'), "shared display preferences must default to System");
assert(serverJs.includes('function normalizeThemePreference'), "server user theme normalization missing");
assert(serverJs.includes('themePreference: normalizeThemePreference(user.themePreference)'), "public user payload must include normalized per-user theme preference");
assert(serverJs.includes('/api/profile/theme'), "server per-user theme endpoint missing");
assert(serverJs.includes('throw new Error("รองรับเฉพาะไฟล์รูปภาพ PNG, JPG, WebP หรือ GIF")'), "server must reject unsupported profile avatar MIME data URLs");

assert(jsonAdapter.includes("function persistUserThemePreference"), "JSON adapter must persist per-user theme");
assert(jsonAdapter.includes("user.themePreference"), "JSON adapter must store theme on the authenticated user object");
assert(supabaseAdapter.includes("theme_preference_${userId}"), "Supabase adapter must persist theme with a per-user key");
assert(supabaseAdapter.includes("themePreference: String"), "Supabase user mapping must return themePreference");
assert(supabaseAdapter.includes("profile_avatar_${user.id}") && supabaseAdapter.includes("avatarRows"), "Supabase login path must include the current profile avatar");

const finalLightLayerIndex = css.lastIndexOf('html[data-theme="light"]');
const premiumLayerIndex = css.indexOf("/* Growup Pilot premium redesign layer */");
assert(finalLightLayerIndex > premiumLayerIndex, "Light theme layer must come after the dark premium baseline");
assert(css.includes('html[data-theme="light"] *:focus-visible'), "Light theme focus-visible coverage missing");
assert(css.includes("/* Light theme completion: ordinary data surfaces use light colors; premium artwork stays dark. */"), "Light theme completion layer missing");
assert(css.includes("--light-card-solid: #ffffff"), "Light theme must expose centralized light surface token");
assert(css.includes('html[data-theme="light"] body.desktop-app-shell:not(.login-view) .mobile-report-kpi'), "Light theme must cover Reports KPI cards");
assert(css.includes('html[data-theme="light"] body.desktop-app-shell:not(.login-view) #orderList'), "Light theme must cover Orders table surface");
assert(css.includes('html[data-theme="light"] body.desktop-app-shell:not(.login-view) .orders-page .orders-hero'), "Light theme must cover Orders desktop hero");
assert(css.includes('html[data-theme="light"] body:not(.login-view) .grow-settings-row'), "Light theme must cover Business Management settings rows");
assert(css.includes('html[data-theme="light"] body:not(.login-view) .settings-users-page .settings-user-tabs button'), "Light theme must cover Users & Permissions tabs");
assert(css.includes('html[data-theme="light"] body:not(.login-view) .settings-users-page .mobile-business-avatar'), "Light theme must cover Users avatar initials fallback");
assert(!css.includes('html[data-theme="dark"]'), "Dark theme must remain the unmodified baseline");

assert(css.includes(".sidebar-theme-button") && css.includes("width: 30px;") && css.includes("height: 30px;"), "Desktop theme buttons must remain compact");
assert(css.includes(".sidebar-theme-button.is-active"), "Sidebar theme buttons must have an active state");
assert(css.includes("body.mobile-app-shell:not(.login-view) .brand,\n  body.mobile-app-shell:not(.login-view) .sidebar-footer {\n    display: none;"), "Mobile layout must keep the sidebar footer hidden");
assert(css.includes("@media (max-width: 820px)") && css.includes(".mobile-theme-toggle") && css.includes("min-width: 44px;") && css.includes("min-height: 44px;"), "Mobile header theme button must be mobile-only with a 44px touch target");
assert(css.includes(".mobile-theme-sheet-dialog[open]") && css.includes("env(safe-area-inset-bottom)") && css.includes(".mobile-theme-option.is-active"), "Mobile bottom sheet must support safe-area and active option styling");
assert(css.includes("body.mobile-app-shell:not(.login-view) .mobile-theme-toggle") && !css.includes("body.desktop-app-shell:not(.login-view) .mobile-theme-toggle"), "Mobile theme toggle must not modify desktop layout");
const topbarHtml = html.slice(html.indexOf('<div class="topbar-icon-row">'), html.indexOf('<div class="date-picker date-pill">'));
assert(topbarHtml.indexOf("headerNotificationButton") < topbarHtml.indexOf("mobileThemeButton") && topbarHtml.indexOf("mobileThemeButton") < topbarHtml.indexOf("headerLogoutButton"), "Mobile theme button must sit between notification and logout");
assert(html.includes('id="mobileThemeButton"') && html.includes('aria-label="เปลี่ยนธีม"') && html.includes('title="เปลี่ยนธีม"'), "Mobile theme button must have Thai aria label and title");
assert(html.includes('id="mobileThemeSheetDialog"') && html.includes("เลือกธีมหน้าจอ") && html.includes("ใช้ธีมมืด") && html.includes("ใช้ธีมสว่าง") && html.includes("เปลี่ยนตามการตั้งค่าของอุปกรณ์"), "Mobile bottom sheet must include Thai labels and descriptions");
assert(html.includes('data-mobile-theme-option="dark"') && html.includes('data-mobile-theme-option="light"') && html.includes('data-mobile-theme-option="system"'), "Mobile bottom sheet must expose all three theme values");
assert(serviceWorker.includes('growup-pilot-pwa-v122-customer-light-cache-v1'), "service worker cache name must be bumped");
assert(serviceWorker.includes('/styles.css?v=20260722-customer-light-cache-v1'), "service worker must cache current stylesheet");
assert(serviceWorker.includes('/app.js?v=20260722-customer-light-cache-v1'), "service worker must cache current app bundle");

function createDummyElement() {
  const element = {
    hidden: false,
    dataset: {},
    style: {},
    value: "",
    innerHTML: "",
    className: "",
    elements: {},
    classList: {
      add() {},
      remove() {},
      toggle() {}
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    getAttribute(name) {
      return this[name] || "";
    },
    removeAttribute(name) {
      delete this[name];
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    matches() {
      return false;
    }
  };
  return element;
}

function createThemeHarness({ initialTheme = "light", systemDark = true } = {}) {
  const localStorageValues = new Map();
  const documentElement = createDummyElement();
  documentElement.removeAttribute = name => {
    if (name === "data-theme-user") delete documentElement.dataset.themeUser;
    else delete documentElement[name];
  };
  const pendingRequests = [];
  const context = {
    console,
    location: { pathname: "/dashboard", hash: "", href: "https://example.test/dashboard", origin: "https://example.test" },
    history: { state: {}, pushState() {}, replaceState() {}, back() {}, scrollRestoration: "auto" },
    performance: { now: () => 0 },
    CSS: { escape: value => String(value) },
    Image: function Image() {},
    FormData: function FormData() {},
    requestAnimationFrame: callback => callback(),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    document: {
      documentElement,
      body: createDummyElement(),
      visibilityState: "visible",
      querySelector() {
        return createDummyElement();
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {}
    },
    localStorage: {
      getItem(key) {
        return localStorageValues.has(key) ? localStorageValues.get(key) : null;
      },
      setItem(key, value) {
        localStorageValues.set(key, String(value));
      },
      removeItem(key) {
        localStorageValues.delete(key);
      }
    },
    fetch(url, options) {
      assert(String(url) === "/api/profile/theme", `unexpected fetch URL ${url}`);
      return new Promise((resolve, reject) => {
        pendingRequests.push({ url, options, resolve, reject });
      });
    }
  };
  context.window = {
    ...context,
    localStorage: context.localStorage,
    matchMedia(query) {
      return {
        matches: query.includes("prefers-color-scheme: dark") ? systemDark : false,
        addEventListener() {},
        removeEventListener() {}
      };
    },
    addEventListener() {},
    removeEventListener() {}
  };
  context.globalThis = context;
  vm.createContext(context);
  const testableAppJs = appJs.replace(
    /\nstartApp\(\);\s*$/,
    "\nglobalThis.__themeTest = { app, saveCurrentUserThemePreference, updateCurrentUserTheme, applyThemePreference, applyUserTheme };\n"
  );
  vm.runInContext(testableAppJs, context, { filename: "public/app.js" });
  const harness = context.__themeTest;
  harness.app.currentUser = { id: "u1", name: "User One", themePreference: initialTheme };
  harness.app.data = {
    currentUser: harness.app.currentUser,
    users: [harness.app.currentUser],
    settings: { displayPreferences: {} }
  };
  harness.applyThemePreference(initialTheme, { persistLocal: true, userId: "u1" });
  return {
    ...harness,
    context,
    pendingRequests,
    localStorageValues,
    resolveRequest(index, themePreference) {
      pendingRequests[index].resolve({
        ok: true,
        status: 200,
        headers: { get: () => "" },
        text: async () => JSON.stringify({
          ok: true,
          user: { id: "u1", name: "User One", themePreference }
        })
      });
    },
    rejectRequest(index, message = "save failed") {
      pendingRequests[index].reject(new Error(message));
    },
    tick() {
      return new Promise(resolve => setImmediate(resolve));
    }
  };
}

async function runClientThemeRaceTests() {
  {
    const h = createThemeHarness({ initialTheme: "light" });
    const save = h.saveCurrentUserThemePreference("dark");
    assert(h.context.document.documentElement.dataset.theme === "dark", "Light to Dark must apply immediately");
    assert(h.app.currentUser.themePreference === "dark", "Light to Dark must update in-memory user immediately");
    assert(h.localStorageValues.get("growup-theme:u1") === "dark", "Light to Dark must update per-user localStorage immediately");
    h.updateCurrentUserTheme({ id: "u1", name: "User One", themePreference: "light" });
    assert(h.context.document.documentElement.dataset.theme === "dark", "stale Light profile payload must not repaint over pending Dark");
    h.resolveRequest(0, "dark");
    const result = await save;
    assert(result.saved === true, "Light to Dark should report one successful persisted selection");
  }

  {
    const h = createThemeHarness({ initialTheme: "dark" });
    const save = h.saveCurrentUserThemePreference("light");
    assert(h.context.document.documentElement.dataset.theme === "light", "Dark to Light must apply immediately");
    h.resolveRequest(0, "light");
    const result = await save;
    assert(result.saved === true, "Dark to Light should report one successful persisted selection");
  }

  {
    const h = createThemeHarness({ initialTheme: "dark", systemDark: false });
    const save = h.saveCurrentUserThemePreference("system");
    assert(h.context.document.documentElement.dataset.themePreference === "system", "System selection must keep the System preference");
    assert(h.context.document.documentElement.dataset.theme === "light", "System selection must resolve from device color scheme");
    h.resolveRequest(0, "system");
    const result = await save;
    assert(result.saved === true, "System selection should persist");
  }

  {
    const h = createThemeHarness({ initialTheme: "light" });
    const first = h.saveCurrentUserThemePreference("dark");
    const second = h.saveCurrentUserThemePreference("light");
    assert(h.pendingRequests.length === 1, "rapid Light/Dark clicks must serialize network saves");
    assert(h.context.document.documentElement.dataset.theme === "light", "latest rapid selection must remain visible while older save is delayed");
    h.resolveRequest(0, "dark");
    await h.tick();
    assert(h.pendingRequests.length === 2, "latest rapid selection must be saved after the delayed older save completes");
    assert(h.context.document.documentElement.dataset.theme === "light", "delayed older save response must not repaint over the latest selection");
    h.resolveRequest(1, "light");
    const firstResult = await first;
    const secondResult = await second;
    assert(firstResult.saved === false, "superseded rapid selection must not show a success toast");
    assert(secondResult.saved === true, "latest rapid selection must show the single success toast");
  }

  {
    const h = createThemeHarness({ initialTheme: "light" });
    const save = h.saveCurrentUserThemePreference("dark");
    h.rejectRequest(0, "theme save failed");
    let failed = false;
    try {
      await save;
    } catch {
      failed = true;
    }
    assert(failed, "latest save failure must reject so the control can show an error toast");
    assert(h.context.document.documentElement.dataset.theme === "light", "save failure must roll back to the previous persisted theme");
    assert(h.app.currentUser.themePreference === "light", "save failure rollback must update in-memory user");
    assert(h.localStorageValues.get("growup-theme:u1") === "light", "save failure rollback must update per-user localStorage");
  }

  {
    const h = createThemeHarness({ initialTheme: "light" });
    const save = h.saveCurrentUserThemePreference("dark");
    h.resolveRequest(0, "dark");
    await save;
    const refreshed = createThemeHarness({ initialTheme: "dark" });
    assert(refreshed.app.currentUser.themePreference === "dark", "refresh persistence must use the saved server theme");
    assert(h.localStorageValues.get("growup-theme:u1") === "dark", "refresh persistence must have the saved per-user localStorage value");
  }
}

async function runPerUserApiTest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "growup-theme-test-"));
  const dbFile = path.join(tmpDir, "db.json");
  process.env.DATABASE_PROVIDER = "json";
  process.env.JSON_DB_PATH = dbFile;
  process.env.NODE_ENV = "test";
  fs.writeFileSync(dbFile, `${JSON.stringify({
    settings: {
      displayPreferences: {
        language: "th",
        dateFormat: "DD/MM/YYYY",
        numberFormat: "1,234.56",
        currency: "THB"
      }
    },
    followUpRules: [],
    users: [
      { id: "u_a", username: "user-a", passwordHash: "hash-a", name: "User A", role: "Owner", active: true },
      { id: "u_b", username: "user-b", passwordHash: "hash-b", name: "User B", role: "Staff", active: true }
    ],
    customers: [],
    orders: [],
    tags: [],
    contactLogs: [],
    lineMessages: []
  }, null, 2)}\n`, "utf8");
  const adapterPath = path.join(root, "lib", "db", "json-adapter.js");
  delete require.cache[require.resolve(adapterPath)];
  const { findUserForLogin, readUserById, persistUserThemePreference } = require(adapterPath);

  try {
    const userAFirst = await findUserForLogin("user-a");
    const userBFirst = await findUserForLogin("user-b");
    assert((userAFirst.themePreference || "system") === "system", "User A without preference must default to System");
    assert((userBFirst.themePreference || "system") === "system", "User B without preference must default to System");

    const saveALight = persistUserThemePreference("u_a", "light");
    assert(saveALight?.themePreference === "light", "User A must save Light");
    assert(readUserById("u_a")?.themePreference === "light", "User A Light must survive refresh/session reload");
    assert((readUserById("u_b")?.themePreference || "system") === "system", "User B must not inherit User A Light");

    const saveBDark = persistUserThemePreference("u_b", "dark");
    assert(saveBDark?.themePreference === "dark", "User B must save Dark");
    assert(readUserById("u_a")?.themePreference === "light", "User A must remain Light after User B saves Dark");

    const invalidB = persistUserThemePreference("u_b", "unknown");
    assert(invalidB?.themePreference === "system", "Invalid per-user values must fall back to System");
    persistUserThemePreference("u_b", "dark");

    assert(findUserForLogin("user-a")?.themePreference === "light", "User A login must return Light after account switch");
    assert(findUserForLogin("user-b")?.themePreference === "dark", "User B login must return Dark after account switch");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runClientThemeRaceTests()
  .then(runPerUserApiTest)
  .then(() => console.log("Theme selector contract OK"))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
