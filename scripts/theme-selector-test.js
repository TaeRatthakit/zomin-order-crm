const fs = require("fs");
const path = require("path");
const os = require("os");

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

assert(html.indexOf('const preference = "system"') < html.indexOf("/styles.css?v=20260715-light-theme-contrast-v3"), "theme bootstrap must default to System before stylesheet load");
assert(html.includes('document.documentElement.dataset.theme = resolved'), "theme bootstrap must set resolved theme before render");
assert(!html.includes("growup_theme_preference_v1"), "bootstrap must not read a shared theme key before authentication");
assert(html.includes('/app.js?v=20260715-light-theme-contrast-v3'), "app asset version must be bumped");

assert(appJs.includes('const THEME_STORAGE_PREFIX = "growup-theme:"'), "theme storage must be namespaced per user");
assert(!appJs.includes("growup_theme_preference_v1"), "client must not use a shared theme storage key");
assert(appJs.includes('const THEME_OPTIONS = new Set(["dark", "light", "system"])'), "client theme options must be exactly dark/light/system");
assert(appJs.includes("function applyThemePreference"), "theme apply helper missing");
assert(appJs.includes('return THEME_OPTIONS.has(value) ? value : "system"'), "invalid client theme values must fall back to System");
assert(appJs.includes('applyThemePreference("system", { persistLocal: false })'), "logout/session cleanup must return the document to System");
assert(appJs.includes('window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change"'), "System mode must react to device theme changes");
assert(appJs.includes("[data-theme-select]"), "Display theme selector change handler missing");
assert(html.includes("data-profile-theme-select"), "Profile dialog must include the personal theme selector for every authenticated user");
assert(appJs.includes("[data-profile-theme-select]"), "Profile theme selector change handler missing");
assert(appJs.includes("function saveCurrentUserThemePreference"), "Profile and Display theme selectors must share one save helper");
assert(appJs.includes('if (app.themeSavePreference === normalized) return app.themeSavePromise'), "theme save helper must avoid duplicate save requests for one selection");
assert(appJs.includes('document.querySelectorAll("[data-theme-select], [data-profile-theme-select]")'), "Profile and Display theme selectors must stay synchronized");
assert(appJs.includes('["dark", "Dark"]') && appJs.includes('["light", "Light"]') && appJs.includes('["system", "System"]'), "Display selector must expose exactly Dark, Light, System");
assert(html.includes('<option value="dark">Dark</option>') && html.includes('<option value="light">Light</option>') && html.includes('<option value="system">System</option>'), "Profile selector must expose exactly Dark, Light, System");
assert(appJs.includes('/api/profile/theme'), "theme must persist through the per-user profile theme endpoint");
assert(!appJs.includes('app.data?.settings?.displayPreferences?.theme'), "theme must not be read from shared business settings");
assert(appJs.includes('if (["settingsStore", "settingsGoals", "settingsAi", "settingsNotifications", "settingsDisplay", "settingsFollowup", "settingsVip"].includes(view)) return can("system.business");'), "Display settings permission gate must remain unchanged");

assert(serverJs.includes('const allowedThemes = new Set(["dark", "light", "system"])'), "server theme whitelist must be exactly dark/light/system");
assert(serverJs.includes('theme: allowedThemes.has(preferences.theme) ? preferences.theme : "system"'), "shared display preferences must default to System");
assert(serverJs.includes('function normalizeThemePreference'), "server user theme normalization missing");
assert(serverJs.includes('themePreference: normalizeThemePreference(user.themePreference)'), "public user payload must include normalized per-user theme preference");
assert(serverJs.includes('/api/profile/theme'), "server per-user theme endpoint missing");

assert(jsonAdapter.includes("function persistUserThemePreference"), "JSON adapter must persist per-user theme");
assert(jsonAdapter.includes("user.themePreference"), "JSON adapter must store theme on the authenticated user object");
assert(supabaseAdapter.includes("theme_preference_${userId}"), "Supabase adapter must persist theme with a per-user key");
assert(supabaseAdapter.includes("themePreference: String"), "Supabase user mapping must return themePreference");

const finalLightLayerIndex = css.lastIndexOf('html[data-theme="light"]');
const premiumLayerIndex = css.indexOf("/* Growup Pilot premium redesign layer */");
assert(finalLightLayerIndex > premiumLayerIndex, "Light theme layer must come after the dark premium baseline");
assert(css.includes('html[data-theme="light"] *:focus-visible'), "Light theme focus-visible coverage missing");
assert(css.includes("/* Light theme completion: ordinary data surfaces use light colors; premium artwork stays dark. */"), "Light theme completion layer missing");
assert(css.includes("--light-card-solid: #ffffff"), "Light theme must expose centralized light surface token");
assert(css.includes('html[data-theme="light"] body.desktop-app-shell:not(.login-view) .mobile-report-kpi'), "Light theme must cover Reports KPI cards");
assert(css.includes('html[data-theme="light"] body.desktop-app-shell:not(.login-view) #orderList'), "Light theme must cover Orders table surface");
assert(css.includes('html[data-theme="light"] body:not(.login-view) .grow-settings-row'), "Light theme must cover Business Management settings rows");
assert(!css.includes('html[data-theme="dark"]'), "Dark theme must remain the unmodified baseline");

assert(serviceWorker.includes('growup-pilot-pwa-v96-light-theme-contrast'), "service worker cache name must be bumped");
assert(serviceWorker.includes('/styles.css?v=20260715-light-theme-contrast-v3'), "service worker must cache current stylesheet");
assert(serviceWorker.includes('/app.js?v=20260715-light-theme-contrast-v3'), "service worker must cache current app bundle");

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

runPerUserApiTest()
  .then(() => console.log("Theme selector contract OK"))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
