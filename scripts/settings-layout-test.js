const fs = require("fs");
const path = require("path");

function assert(condition, message) {
  if (!condition) {
    console.error(`Settings layout test failed: ${message}`);
    process.exit(1);
  }
}

const root = path.resolve(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function functionBody(name) {
  const start = appJs.indexOf(`function ${name}`);
  assert(start !== -1, `${name}() not found`);
  const next = appJs.indexOf("\nfunction ", start + 1);
  return appJs.slice(start, next === -1 ? appJs.length : next);
}

const menuStart = appJs.indexOf("const settingsMenuItems = [");
const menuEnd = appJs.indexOf("];", menuStart);
assert(menuStart !== -1 && menuEnd !== -1, "settingsMenuItems not found");
const menuSource = appJs.slice(menuStart, menuEnd);
const titles = [...menuSource.matchAll(/titleTh:\s*"([^"]+)"/g)].map(match => match[1]);
assert(JSON.stringify(titles) === JSON.stringify([
  "ข้อมูลธุรกิจ",
  "เป้าหมายธุรกิจ",
  "AI",
  "ตั้งค่าการแจ้งเตือน",
  "การแสดงผล",
  "การเชื่อมต่อ"
]), "settings menu order changed");
assert(!menuSource.includes("settingsFinance"), "settings landing must not include Finance");
assert(!menuSource.includes("การเงิน"), "settings landing must not include finance label");

const shell = functionBody("settingsSubpageShell");
assert(shell.includes("mobile-business-page mobile-business-subpage settings-shared-page settings-subpage"), "settings detail pages must reuse the mobile business subpage shell");
assert(shell.includes("mobileBusinessHeader(title, description, icon"), "settings detail pages must reuse mobileBusinessHeader");
assert(!shell.includes("settings-premium-page"), "settingsSubpageShell must not render the old narrow settings-premium-page shell");
assert(!shell.includes("settings-subpage-header"), "settingsSubpageShell must not render the old page-specific header");
assert(!shell.includes("page-kicker"), "settingsSubpageShell must not render English kicker badges");

const menuMarkup = functionBody("settingsMenuMarkup");
assert(menuMarkup.includes("mobile-business-page mobile-business-subpage settings-shared-page"), "settings landing must reuse the mobile business subpage shell");
assert(menuMarkup.includes("mobileBusinessHeader(\"ตั้งค่า\""), "settings landing must reuse mobileBusinessHeader");
assert(!menuMarkup.includes("settings-premium-page"), "settings landing must not render the old narrow settings-premium-page shell");
assert(!menuMarkup.includes("settings-subpage-header"), "settings landing must not render the old page-specific header");

const businessMain = functionBody("renderMobileBusinessMain");
assert(businessMain.includes('mobileBusinessMenuRow("system", "ตั้งค่าระบบ"'), "Business Management must keep the existing System Settings card");
assert(!businessMain.includes("settingsMenuItems.map"), "Settings landing rows must not render directly on Business Management");
assert(!businessMain.includes("notifications"), "Business Management must not restore the duplicate Notifications card");

const businessSystem = functionBody("renderMobileBusinessSystem");
assert(businessSystem.includes("settingsMenuMarkup({ embeddedInBusiness: true })"), "System Settings card must open the Settings landing page");

const header = functionBody("mobileBusinessHeader");
assert(header.includes("data-settings-back"), "shared header must support Settings back navigation");
assert(header.includes("data-business-page"), "shared header must preserve Business Management back navigation");

assert(css.includes(".settings-shared-page .mobile-business-subhead"), "settings shared header CSS missing");
assert(css.includes(".settings-shared-content"), "settings shared content CSS missing");
assert(css.includes(".settings-shared-page .settings-unified-form"), "settings shared form CSS missing");
assert(css.includes(".settings-shared-page .integration-grid"), "settings integration grid must be scoped to shared page");
assert(css.includes("@media (max-width: 900px)"), "responsive Settings layout rules missing");

const notificationEvents = functionBody("notificationEvents");
assert(notificationEvents.includes("stock:${stableProductKey}"), "stock notification IDs must use the stable product key");
assert(notificationEvents.includes("!/^product_\\d+$/.test(persistentProductId)"), "stock notifications must reject array-index fallback product IDs");
assert(!notificationEvents.includes("stock:${product.id}"), "stock notification IDs must not use normalized index fallback IDs");

const notificationNavigation = functionBody("navigateFromNotification");
assert(notificationNavigation.includes("closeNotifications({ replaceHistory: true })"), "notification routing must replace the overlay history entry before navigation");

const workDateChangeStart = appJs.indexOf("if (event.target === els.workDate)");
const workDateChangeEnd = appJs.indexOf("if (event.target?.matches?.(\"[data-orders-show-all]\"))", workDateChangeStart);
const workDateChangeSource = appJs.slice(workDateChangeStart, workDateChangeEnd);
assert((workDateChangeSource.match(/updateShell\(\)/g) || []).length >= 2, "desktop and mobile date changes must refresh the unread badge");

console.log("Settings layout contract OK");
