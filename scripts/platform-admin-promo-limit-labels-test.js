const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const uiSource = fs.readFileSync(
  path.join(root, "public/platform-admin/platform-admin.js"),
  "utf8"
);
const serverSource = fs.readFileSync(path.join(root, "lib/platform-admin.js"), "utf8");

const requiredUiText = [
  "จำนวนครั้งที่ใช้ได้ทั้งหมด",
  "จำนวนครั้งที่ใช้ได้ต่อบริษัท",
  'placeholder="ไม่จำกัด"',
  'promo.usageLimit === null ? "ไม่จำกัด"',
  'cardMetric("เหลือใช้ / ไม่จำกัด"',
];

for (const text of requiredUiText) {
  if (!uiSource.includes(text)) {
    throw new Error(`Missing required Promo limit UI text: ${text}`);
  }
}

for (const oldLabel of ["จำกัดใช้รวม", "จำกัดต่อบริษัท"]) {
  if (uiSource.includes(oldLabel)) {
    throw new Error(`Old Promo limit label is still user-facing: ${oldLabel}`);
  }
}

if (!serverSource.includes('text.toLowerCase() === "unlimited"')) {
  throw new Error("Internal Unlimited parsing changed unexpectedly");
}

if (!serverSource.includes("positiveLimit")) {
  throw new Error("Promo usage-limit server validation changed unexpectedly");
}

console.log("Platform Admin Promo limit label tests passed");
