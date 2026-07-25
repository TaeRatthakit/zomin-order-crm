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

const businessCustomerLightScope = 'html[data-theme="light"] body:not(.login-view) :is(.customers-page.settings-customers-management, .customer-management-business-page .customers-page.embedded-customer-management)';
assert(css.includes(businessCustomerLightScope), "Business Customer Management light scope must exist");
assert(!css.split("\n").some(line => line.startsWith(`${businessCustomerLightScope.replace('html[data-theme="light"] ', "")} .workspace-table tbody td`)), "Business Customer Management table repair must stay Light Theme scoped");
assert(css.includes(".customers-page.settings-customers-management") && css.includes(".customer-management-business-page .customers-page.embedded-customer-management"), "Business Customer Management repair must cover desktop settings and mobile business subpage only");

const darkDesktopCellIndex = css.indexOf("body.desktop-app-shell:not(.login-view) .workspace-table tbody td");
const businessCustomerCellSelector = `${businessCustomerLightScope} .workspace-table tbody td`;
const businessCustomerCellIndex = css.indexOf(businessCustomerCellSelector);
assert(darkDesktopCellIndex !== -1 && businessCustomerCellIndex > darkDesktopCellIndex, "Business Customer Management light cell rule must load after the dark desktop table baseline");
const businessCustomerCellRule = css.slice(businessCustomerCellIndex, css.indexOf("}", businessCustomerCellIndex));
assert(businessCustomerCellRule.includes("background: #ffffff !important"), "Business Customer Management light cells must restore a white surface");
assert(businessCustomerCellRule.includes("color: #172033 !important"), "Business Customer Management light cells must keep readable text");
assert(css.includes(`${businessCustomerLightScope} .workspace-table-wrap {\n  border-color: rgba(226, 218, 249, 0.92) !important;\n  background: #ffffff !important`), "Business Customer Management light wrapper must be white");
assert(css.includes(`${businessCustomerLightScope} .workspace-table-wrap::before`) && css.includes("content: none !important;") && css.includes("background: none !important;"), "Business Customer Management light wrapper must disable the base pseudo overlay");
assert(css.includes(`${businessCustomerLightScope} .workspace-table thead th`) && css.includes("background: #faf8ff !important") && css.includes("color: #32254d !important"), "Business Customer Management light table heading must use a readable light surface");
assert(css.includes(`${businessCustomerLightScope} .workspace-table tbody tr {\n  border-color: rgba(226, 218, 249, 0.78) !important;\n  background: #ffffff !important`), "Business Customer Management light rows must be white");
assert(css.includes(`${businessCustomerLightScope} .workspace-table tbody tr:nth-child(even) td {\n  background: #fdfbff !important`), "Business Customer Management light alternate cells must remain subtly tinted");
assert(css.includes(`${businessCustomerLightScope} .workspace-table tbody tr:hover td`) && css.includes("background: #f7f2ff !important"), "Business Customer Management light hover cells must remain readable");
assert(css.includes(`${businessCustomerLightScope} .workspace-table tbody tr.is-selected`) && css.includes(`${businessCustomerLightScope} .workspace-table tbody tr[aria-selected="true"]`), "Business Customer Management light selected row protection must exist");
assert(css.includes(`${businessCustomerLightScope} .mobile-stack-table td::before`) && css.includes("color: #667085 !important"), "Business Customer Management mobile card labels must stay readable");
assert(css.includes(`${businessCustomerLightScope} .table-identity small`) && css.includes("color: #667085 !important"), "Business Customer Management light secondary customer text must stay readable");
assert(css.includes(`${businessCustomerLightScope} .workspace-table .badge`) && css.includes("background: #efe4ff !important") && css.includes("color: #5b21b6 !important"), "Business Customer Management light badges must stay pastel and readable");
assert(css.includes(`${businessCustomerLightScope} .table-actions .button.secondary`) && css.includes("color: #6d28d9 !important"), "Business Customer Management light edit action must stay readable");
assert(css.includes(`${businessCustomerLightScope} .table-actions .button.danger`) && css.includes("color: #be123c !important"), "Business Customer Management light delete action must stay readable");
assert(!css.includes('html[data-theme="light"] body:not(.login-view) .customers-page .workspace-table tbody td {\n  background: #ffffff !important'), "Business Customer Management fix must not target all customer pages");

console.log("Customer Management redesign static tests passed");
