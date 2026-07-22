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

const lightCustomerScope = 'html[data-theme="light"] body.desktop-app-shell:not(.login-view) :is(.customers-page:not(.settings-customers-management):not(.embedded-customer-management), .customer-management-business-page .customers-page.embedded-customer-management)';
assert(appJs.includes('customer-management-business-page'), "Business Management customer page class must remain available for scoped styling");
assert(appJs.includes('extraClass: "embedded-customer-management"'), "Business Management customer view must keep its embedded class");
assert(css.includes(`${lightCustomerScope} .customers-hero`), "Desktop Light customer hero styling must include the Business Management embedded customer page");
assert(css.includes(`${lightCustomerScope} .customer-summary-card`), "Desktop Light customer KPI styling must include the Business Management embedded customer page");
const darkDesktopHeroIndex = css.indexOf("body.desktop-app-shell:not(.login-view) .workspace-hero");
const lightCustomerHeroIndex = css.indexOf(`${lightCustomerScope} .customers-hero`);
assert(darkDesktopHeroIndex !== -1 && lightCustomerHeroIndex > darkDesktopHeroIndex, "Desktop Light customer hero rule must load after the dark desktop workspace hero baseline");
const lightCustomerHeroRule = css.slice(lightCustomerHeroIndex, css.indexOf("}", lightCustomerHeroIndex));
assert(lightCustomerHeroRule.includes("#ffffff") && lightCustomerHeroRule.includes("#f5efff"), "Desktop Light customer hero must resolve to a white/soft-purple background");
assert(!lightCustomerHeroRule.includes("rgba(5, 17, 29") && !lightCustomerHeroRule.includes("rgba(4, 12, 23"), "Desktop Light customer hero rule must not retain the dark surface colors");
assert(!css.includes("html[data-theme=\"light\"] body.desktop-app-shell:not(.login-view) .customers-page:not(.settings-customers-management):not(.embedded-customer-management) .customers-hero"), "Old standalone-only selector must be corrected instead of remaining as an ineffective selector");

const darkDesktopCellIndex = css.indexOf("body.desktop-app-shell:not(.login-view) .workspace-table tbody td");
const lightCustomerCellSelector = `${lightCustomerScope} .workspace-table tbody td`;
const lightCustomerCellIndex = css.indexOf(lightCustomerCellSelector);
assert(darkDesktopCellIndex !== -1 && lightCustomerCellIndex > darkDesktopCellIndex, "Desktop Light customer table cell rule must load after the dark desktop table baseline");
const lightCustomerCellRule = css.slice(lightCustomerCellIndex, css.indexOf("}", lightCustomerCellIndex));
assert(lightCustomerCellRule.includes("background: #ffffff !important"), "Desktop Light customer table cells must use a true white surface instead of a transparent tinted surface");
assert(lightCustomerCellRule.includes("color: #172033 !important"), "Desktop Light customer table cells must use readable text");
assert(lightCustomerCellRule.includes("padding: 15px 14px"), "Desktop Light customer table cells must keep readable vertical spacing");
assert(css.includes(`${lightCustomerScope} .workspace-table-wrap`) && css.includes("background: #ffffff !important"), "Desktop Light customer table wrapper must not add a purple gradient behind rows");
assert(css.includes(`${lightCustomerScope} .workspace-table thead th`) && css.includes("background: #faf8ff !important") && css.includes("color: #32254d !important"), "Desktop Light customer table headings must use a readable light header");
assert(css.includes(`${lightCustomerScope} .workspace-table tbody tr {\n    background: #ffffff !important`), "Desktop Light customer table rows must use a clean white surface");
assert(css.includes(`${lightCustomerScope} .workspace-table tbody tr:nth-child(even) td {\n    background: #fdfbff !important`), "Desktop Light customer alternate row cells must use only a very light purple tint");
assert(css.includes(`${lightCustomerScope} .workspace-table tbody tr:hover td`) && css.includes("background: #f7f2ff !important"), "Desktop Light customer hover state must remain a soft purple highlight");
assert(css.includes(`${lightCustomerScope} .table-identity small`) && css.includes("color: #667085 !important"), "Desktop Light customer address text must remain muted but readable");
assert(css.includes(`${lightCustomerScope} .workspace-table .badge`) && css.includes("background: #efe4ff !important") && css.includes("color: #5b21b6 !important"), "Desktop Light customer badges must remain pastel purple with readable text");
assert(css.includes(`${lightCustomerScope} .table-actions .button.secondary`) && css.includes("color: #6d28d9 !important"), "Desktop Light customer edit action must stay compact and recognizable");
assert(css.includes(`${lightCustomerScope} .table-actions .button.danger`) && css.includes("color: #be123c !important"), "Desktop Light customer delete action must stay compact and recognizable");

console.log("Customer Management redesign static tests passed");
