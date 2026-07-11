const fs = require("fs");
const path = require("path");

const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const permissionToggleMatch = appJs.match(/function permissionToggle[\s\S]*?return `([\s\S]*?)`;\n}/);
assert(permissionToggleMatch, "permissionToggle() not found");
const toggleTemplate = permissionToggleMatch[1];
assert((toggleTemplate.match(/type="checkbox"/g) || []).length === 1, "permissionToggle must render exactly one checkbox input");
assert(toggleTemplate.includes("class=\"permission-switch\""), "permissionToggle must use permission-switch label");
assert(toggleTemplate.includes("class=\"settings-switch-ui\""), "permissionToggle must render one Growup switch UI");

assert(!appJs.includes("permission-table-wrap"), "legacy permission table wrapper should not be rendered");
assert(!appJs.includes("permission-table\""), "legacy permission table should not be rendered");
assert(appJs.includes("permission-card-grid"), "desktop permission cards are missing");
assert(appJs.includes("data-permission-role"), "role selector missing");
assert(appJs.includes("data-permission-enable-all"), "enable all action missing");
assert(appJs.includes("data-permission-disable-all"), "disable all action missing");
assert(appJs.includes("data-permission-restore-defaults"), "restore defaults action missing");
assert(appJs.includes("markPermissionDraftSaved();"), "save flow must reset permission dirty snapshot");
assert(appJs.includes("confirmDiscardPermissionChanges"), "unsaved-change discard guard missing");
assert(appJs.includes("data-permission-accordion"), "mobile permission accordion missing");

const clickHandlerStart = appJs.indexOf('document.addEventListener("click"');
const changeHandlerStart = appJs.indexOf('document.addEventListener("change"');
assert(clickHandlerStart >= 0 && changeHandlerStart > clickHandlerStart, "click/change handlers not found");
const clickHandler = appJs.slice(clickHandlerStart, changeHandlerStart);
assert(!clickHandler.includes("[data-permission-role]"), "role selector should not be handled by click rerenders");
const changeHandler = appJs.slice(changeHandlerStart, appJs.indexOf('document.addEventListener("keydown"', changeHandlerStart));
assert(changeHandler.includes("[data-permission-role]"), "role selector change handler missing");
assert(changeHandler.includes("[data-permission-toggle]"), "permission toggle change handler missing");

assert(css.includes(".permission-switch input"), "permission checkbox hiding CSS missing");
assert(css.includes("opacity: 0"), "permission checkbox should be visually hidden");
assert(css.includes(".permission-switch input:focus-visible + .settings-switch-ui"), "switch focus style missing");
assert(css.includes(".permission-switch .settings-switch-ui") && css.includes("pointer-events: none"), "visual switch must not intercept pointer events");
assert(css.includes(".permission-row-copy b,") && css.includes("text-overflow: ellipsis"), "one-line ellipsis for permission labels/descriptions missing");
assert(css.includes("@media (max-width: 760px)") && css.includes("grid-template-columns: 1fr"), "mobile one-column permission layout missing");
assert(css.includes("bottom: 74px"), "mobile sticky save should sit above bottom navigation");
assert(css.includes("padding-bottom: 112px"), "mobile panel must reserve space for sticky save");

console.log("Permission UI contract test passed.");
