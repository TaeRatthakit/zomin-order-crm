const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

function fail(message) {
  console.error(`Customer Management redesign test failed: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const customerRowMatch = appJs.match(/function customerRow\(customer\) \{[\s\S]*?\n\}/);
assert(customerRowMatch, "customerRow function must exist");
const customerRow = customerRowMatch[0];

assert(customerRow.includes("data-open-customer-management"), "customer row/name must open the dedicated Customer Management detail view");
assert(customerRow.includes("data-edit-customer"), "customer row actions must include Edit");
assert(customerRow.includes("data-delete-customer"), "customer row actions must include Delete");
assert(!customerRow.includes(">ดู<"), "customer row actions must not include the old View button");
assert(appJs.includes('if (row && !event.target.closest("button"))'), "row-open handler must ignore action buttons");

assert(appJs.includes("function renderCustomerManagementDetail(customer)"), "dedicated Customer Management detail renderer must exist");
assert(appJs.includes("customerManagementDetailId"), "Customer Management detail state must be tracked separately");
assert(appJs.includes("customerManagementListScrollTop"), "list scroll position must be preserved for detail back navigation");
assert(appJs.includes("history[replaceHistory ? \"replaceState\" : \"pushState\"]"), "opening detail must push safe browser history state");

const detailStart = appJs.indexOf("function renderCustomerManagementDetail(customer)");
const detailEnd = appJs.indexOf("function customerGroupDefinitions", detailStart);
assert(detailStart !== -1 && detailEnd !== -1, "detail renderer body must be readable");
const detail = appJs.slice(detailStart, detailEnd);
assert((detail.match(/customer-management-social-row/g) || []).length === 1, "detail header must render exactly one combined social row");
assert(detail.includes("ชื่อลูกค้า:"), "combined social row must show one customer/social display name");
assert(detail.includes("[\"overview\", \"ภาพรวม\"]"), "overview tab must exist");
assert(detail.includes("[\"orders\", \"ประวัติออเดอร์\"]"), "order history tab must exist");
assert(detail.includes("[\"contacts\", \"ประวัติการติดต่อ\"]"), "contact history tab must exist");
assert(!detail.includes("data-start-customer-call"), "Customer Management detail must not include Start Call");
assert(!detail.includes("data-submit-contact"), "Customer Management detail must not include CRM/contact save actions");

assert(appJs.includes("function openCustomerEditDialog(customerId)"), "Edit action must reuse the existing customerEditForm submit flow");
assert(appJs.includes('customerDialogShell.id = "customerEditForm"'), "Edit dialog must use customerEditForm");
assert(appJs.includes('currentFormId === "customerEditForm"'), "existing customer edit submit logic must remain wired");

assert(css.includes(".customer-management-detail-view"), "detail view CSS must exist");
assert(css.includes("html[data-theme=\"light\"] body:not(.login-view) .customer-management-detail-view"), "light theme detail override must exist");
assert(css.includes("@media (max-width: 780px)") && css.includes(".customer-management-summary-cards"), "mobile responsive detail CSS must exist");

// The approved source has separate standalone Desktop and embedded page scopes.
const standaloneScope = 'html[data-theme="light"] body.desktop-app-shell:not(.login-view) .customers-page:not(.settings-customers-management):not(.embedded-customer-management)';
const embeddedScope = 'html[data-theme="light"] body:not(.login-view) :is(.customers-page.settings-customers-management, .customer-management-business-page .customers-page.embedded-customer-management)';
assert(appJs.includes('customer-management-business-page'), "Business Management customer page class must remain available");
assert(appJs.includes('extraClass: "embedded-customer-management"'), "embedded customer class must remain present");
function rule(selector) {
  const index = css.indexOf(selector);
  assert(index >= 0, `missing approved selector: ${selector}`);
  const open = css.indexOf("{", index);
  return { index, body: css.slice(open + 1, css.indexOf("}", open)) };
}
function declarations(selector, values) {
  const found = rule(selector);
  for (const value of values) assert(found.body.includes(value), `missing ${value} in ${selector}`);
  return found.index;
}
const standaloneHero = declarations(`${standaloneScope} .customers-hero`, ["#ffffff", "#f5efff"]);
assert(standaloneHero > css.indexOf("body.desktop-app-shell:not(.login-view) .workspace-hero"), "standalone Light hero must follow the dark baseline");
assert(!rule(`${standaloneScope} .customers-hero`).body.includes("rgba(5, 17, 29"), "standalone hero must not retain dark colors");
declarations(`${standaloneScope} .customer-summary-card`, ["padding: 13px 14px", "rgba(255, 255, 255, 0.72)"]);
declarations(`${embeddedScope} .customers-hero`, ["#ffffff", "#fbf9ff", "color: #111827"]);
declarations(`${embeddedScope} .customers-hero .page-identity-copy h2`, ["color: #111827"]);
declarations(`${embeddedScope} .customers-hero .page-identity-copy p`, ["color: #6b7280"]);
const cells = declarations(`${embeddedScope} .workspace-table tbody td`, ["background: #ffffff !important", "color: #172033 !important"]);
assert(cells > css.indexOf("body.desktop-app-shell:not(.login-view) .workspace-table tbody td"), "embedded Light cells must follow the dark baseline");
// Spacing is inherited from the approved table rule, not invented in the color override.
declarations("body.desktop-app-shell:not(.login-view) .workspace-table tbody td", ["padding: 13px 14px"]);
assert(!rule(`${embeddedScope} .workspace-table tbody td`).body.includes("padding:"), "embedded Light color override must preserve inherited approved table spacing");
declarations(`${embeddedScope} .workspace-table-wrap`, ["background: #ffffff !important"]);
declarations(`${embeddedScope} .workspace-table-wrap::before`, ["content: none !important", "background: none !important"]);
declarations(`${embeddedScope} .workspace-table thead th`, ["background: #faf8ff !important", "color: #32254d !important"]);
declarations(`${embeddedScope} .workspace-table tbody tr {`, ["background: #ffffff !important"]);
declarations(`${embeddedScope} .workspace-table tbody tr:nth-child(even) td`, ["background: #fdfbff !important"]);
declarations(`${embeddedScope} .workspace-table tbody tr:hover td`, ["background: #f7f2ff !important"]);
declarations(`${embeddedScope} .table-identity small`, ["color: #667085 !important"]);
declarations(`${embeddedScope} .workspace-table .badge`, ["background: #efe4ff !important", "color: #5b21b6 !important"]);
declarations(`${embeddedScope} .table-actions .button.secondary`, ["color: #6d28d9 !important"]);
declarations(`${embeddedScope} .table-actions .button.danger`, ["color: #be123c !important"]);
console.log("Customer Management redesign static tests passed");
