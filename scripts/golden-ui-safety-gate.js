"use strict";

const fs = require("fs");
const path = require("path");

const manifestPath = path.resolve(process.env.GOLDEN_UI_MANIFEST || "ui-baselines/golden-ui/manifest.json");
const expectedDeployment = "dpl_6ZZK5fLiJkn6dehz9DpAFPnKB41y";
const expectedSourceCommit = "cfb7c8e8b999b559d031d2a5558baa537a934b67";
const expectedProductionDb = "mjnpzdmrqweugdnvlqwq";
const requiredProtectedRoutes = ["dashboard", "orders", "reports", "settings", "login"];
const requiredViewports = ["desktop", "mobile375", "mobile400"];

function fail(message) {
  console.error(`Golden UI safety gate FAILED: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(manifestPath)) fail(`missing approved Golden manifest: ${manifestPath}`);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`invalid approved Golden manifest: ${error.message}`);
}

if (manifest.name !== "GROWUP PILOT — GOLDEN UI") fail("manifest is not the approved Golden UI manifest");
if (manifest.deploymentId !== expectedDeployment) fail("manifest deployment does not match the approved Golden deployment");
if (manifest.sourceCommit !== expectedSourceCommit) fail("manifest source does not match the approved Golden source commit");
if (manifest.environmentScope !== "PRODUCTION") fail("manifest is not marked Production-scoped");
if (manifest.productionDbProject !== expectedProductionDb) fail("manifest Production DB project does not match the approved project");
if (manifest.approval?.status !== "USER_APPROVED") fail("manifest is not user-approved");
if (manifest.goldenUiGuard !== "PASS") fail("manifest Golden UI evidence is not PASS");
if (!requiredViewports.every(viewport => manifest.viewports?.[viewport]?.width && manifest.viewports?.[viewport]?.height)) {
  fail("manifest viewport matrix is incomplete");
}
if (!Array.isArray(manifest.themes) || !manifest.themes.includes("light") || !manifest.themes.includes("dark")) {
  fail("manifest theme matrix is incomplete");
}

const evidence = manifest.visualEvidence || {};
if (evidence.previewMatrix !== "PASS" || evidence.liveProductionSpotChecks !== "PASS" || evidence.protectedRoutes !== "PASS") {
  fail("manifest visual evidence is incomplete");
}
const live = manifest.liveVerification || {};
for (const route of requiredProtectedRoutes) {
  const key = route === "settings" ? "settings" : route;
  if (live[key]?.ui !== "PASS") fail(`live UI evidence missing for ${route}`);
}
if (live.settingsLine?.ui !== "PASS" || live.settingsLine?.rawCredentialsExposed !== false) {
  fail("/settings/line evidence is incomplete or exposes credentials");
}
if (live.webhookHealth?.http !== 200) fail("webhook health evidence is not HTTP 200");
for (const [route, expected] of Object.entries({ dashboard: "dashboard-desktop-light.png", orders: "orders-desktop-light.png", reports: "reports-desktop-light.png", settings: "settings-desktop-light.png", login: "login-desktop-light.png" })) {
  const screenshot = path.resolve(path.dirname(manifestPath), "../current/screenshots", expected);
  if (!fs.existsSync(screenshot)) fail(`missing approved protected screenshot for ${route}`);
}
for (const screenshot of evidence.screenshots?.livePublicDesktopLight || []) {
  if (!fs.existsSync(path.resolve(path.dirname(manifestPath), screenshot))) fail(`missing approved public screenshot ${screenshot}`);
}

console.log("Golden UI safety gate PASS: approved immutable manifest, source, Production scope, visual evidence, protected routes, and screenshots are proven.");
