const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const appJs = read("public/app.js");
const importWorker = read("public/import-worker.js");
const serviceWorker = read("public/service-worker.js");
const packageJson = JSON.parse(read("package.json"));
const packageLock = read("package-lock.json");

assert(!fs.existsSync(path.join(root, "public", "xlsx.full.min.js")), "public XLSX parser asset must not be shipped");
assert(!fs.existsSync(path.join(root, "public", "templates", "order-import-template.xlsx")), "XLSX import template must not be shipped");
assert(!packageJson.dependencies?.xlsx, "xlsx must not be a production dependency");
assert(!packageLock.includes("node_modules/xlsx"), "package-lock must not include xlsx");
assert(!packageLock.includes("\"xlsx\""), "package-lock must not reference xlsx");

assert(!importWorker.includes("importScripts(\"/xlsx.full.min.js\")"), "import worker must not load the XLSX parser");
assert(!importWorker.includes("XLSX.read"), "import worker must not parse XLSX workbooks");
assert(!importWorker.includes("sheet_to_json"), "import worker must not use XLSX sheet parsing helpers");
assert(importWorker.includes("parseCsvRows"), "import worker must keep the CSV parser path");
assert(importWorker.includes("รองรับไฟล์ CSV เท่านั้น"), "import worker must reject non-CSV files clearly");

assert(!serviceWorker.includes("xlsx.full.min.js"), "service worker must not cache XLSX parser assets");
assert(appJs.includes("accept=\".csv,text/csv\""), "file input must accept CSV only");
assert(!appJs.includes(".xlsx,.xls"), "file input must not accept XLSX/XLS extensions");
assert(!appJs.includes("order-import-template.xlsx"), "UI must not link to the XLSX template");
assert(appJs.includes("รองรับไฟล์ CSV เท่านั้น"), "UI must clearly say CSV only");

console.log("XLSX import disabled regression checks passed.");
