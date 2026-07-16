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

console.log("Customer Management redesign static tests passed");
