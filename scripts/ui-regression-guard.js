"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MANIFEST_PATH = process.env.UI_BASELINE_MANIFEST || "ui-baselines/current/manifest.json";
const SOURCE_COMPARE_REF = process.env.UI_SOURCE_COMPARE_REF || "";
const INVALID_SOURCE_REFS = new Set(["ui-baseline-current", "ui-baseline-invalid-9297873"]);
const VISUAL_BASELINE_REF = /^ui-visual-baseline-/;
const SCOPE = (process.env.UI_CHANGE_SCOPE || "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

const UI_FILES = [
  "public/index.html",
  "public/landing.html",
  "public/styles.css",
  "public/app.js",
  "public/service-worker.js"
];

const UI_ASSET_RE = /^public\/.*\.(png|jpe?g|webp|svg|ico)$/i;
const TEXT_UI_RE = /\.(css|js|html)$/i;

const PAGE_PATTERNS = {
  landing: [/landing/i, /public/i, /hero/i, /features/i, /pricing/i, /how-it-works/i, /"\/": "dashboard"/i, /isAuthView/i, /ผู้ใช้งานสูงสุด 10 คน/i, /จัดการธุรกิจให้เติบโต/i],
  login: [/login/i, /auth/i, /app-startup/i],
  signup: [/signup/i, /auth/i, /app-startup/i],
  dashboard: [/dashboard/i, /home/i, /growth-banner/i, /hero/i, /onboarding/i],
  customers: [/customer/i],
  orders: [/order/i],
  opportunities: [/opportunit/i, /sales-opportunit/i],
  "follow-up": [/follow/i],
  vip: [/\bvip\b/i],
  tags: [/\btag/i],
  import: [/import/i],
  reports: [/report/i, /chart/i, /kpi/i],
  settings: [/setting/i, /business/i, /permission/i, /user/i],
  finance: [/finance/i, /cost/i, /profit/i, /expense/i, /product-cost/i],
  team: [/team/i, /user/i, /permission/i],
  "export-backup": [/export/i, /backup/i],
  light: [/data-theme="light"/i, /light/i],
  dark: [/data-theme="dark"/i, /dark/i],
  mobile: [/mobile/i, /max-width/i],
  desktop: [/desktop/i, /min-width/i],
  global: [/^(\+|-)\s*(html|body|:root|@media|@supports|\/\*)/i, /sidebar/i, /topbar/i, /mobile-app-shell/i, /desktop-app-shell/i]
};

function runGit(args, allowEmpty = false) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    if (allowEmpty) return String(error.stdout || "").trim();
    throw error;
  }
}

function sha256(file) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function loadBaselineAssets() {
  if (!fs.existsSync(MANIFEST_PATH)) return new Map();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const assets = new Map();
  for (const asset of manifest.assets || []) {
    if (!asset.sha256) continue;
    if (asset.localFile) {
      assets.set(path.normalize(path.join(path.dirname(MANIFEST_PATH), asset.localFile)), asset.sha256);
    }
    if (asset.path?.startsWith("/")) {
      const pathname = asset.path.split("?")[0].replace(/^\//, "");
      assets.set(path.normalize(path.join("public", pathname)), asset.sha256);
    }
  }
  return assets;
}

function changedFiles() {
  const committed = SOURCE_COMPARE_REF
    ? runGit(["diff", "--name-only", `${SOURCE_COMPARE_REF}..HEAD`], true)
    : "";
  const working = runGit(["diff", "--name-only"], true);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"], true);
  return Array.from(new Set(`${committed}\n${working}\n${untracked}`.split("\n").filter(Boolean))).sort();
}

function changedUiFiles(files) {
  const baselineAssets = loadBaselineAssets();
  return files.filter(file => {
    if (!UI_FILES.includes(file) && !UI_ASSET_RE.test(file)) return false;
    const baselineHash = baselineAssets.get(path.normalize(file));
    if (baselineHash && fs.existsSync(file) && sha256(file) === baselineHash) return false;
    return true;
  });
}

function diffFor(files) {
  const chunks = [];
  for (const file of files) {
    const baselineFile = path.join(path.dirname(MANIFEST_PATH), "assets", path.basename(file));
    if (fs.existsSync(baselineFile) && fs.existsSync(file)) {
      chunks.push(runGit(["diff", "--no-index", "--unified=0", baselineFile, file], true));
    } else if (SOURCE_COMPARE_REF) {
      chunks.push(runGit(["diff", "--unified=0", SOURCE_COMPARE_REF, "--", file], true));
    } else {
      chunks.push(runGit(["diff", "--unified=0", "--", file], true));
    }
  }
  return chunks.filter(Boolean).join("\n");
}

function lineMatchesScope(line, scope) {
  const patterns = PAGE_PATTERNS[scope] || [];
  return patterns.some(pattern => pattern.test(line));
}

function pathMatchesScope(file) {
  return SCOPE.some(scope => lineMatchesScope(file, scope))
    || (SCOPE.includes("global") && lineMatchesScope(file, "global"));
}

function classifyOutOfScope(diff) {
  const lines = diff.split("\n").filter(line => /^[+-](?![+-])/.test(line));
  let activeBlockIsInScope = false;
  let activeBlockDepth = 0;
  return lines.filter(line => {
    if (!line.slice(1).trim()) return false;
    const lineIsInScope = SCOPE.some(scope => lineMatchesScope(line, scope))
      || (SCOPE.includes("global") && lineMatchesScope(line, "global"));
    if (line.includes("{")) {
      if (!activeBlockIsInScope) activeBlockIsInScope = lineIsInScope;
      if (activeBlockIsInScope) activeBlockDepth += (line.match(/\{/g) || []).length;
    }
    if (lineIsInScope || activeBlockIsInScope) {
      if (activeBlockIsInScope && line.includes("}")) {
        activeBlockDepth -= (line.match(/\}/g) || []).length;
        if (activeBlockDepth <= 0) {
          activeBlockDepth = 0;
          activeBlockIsInScope = false;
        }
      }
      return false;
    }
    return true;
  });
}

function main() {
  const forbiddenSourceRef = process.env.UI_BASELINE_REF || SOURCE_COMPARE_REF;
  if (INVALID_SOURCE_REFS.has(forbiddenSourceRef) || VISUAL_BASELINE_REF.test(forbiddenSourceRef)) {
    console.error(`${forbiddenSourceRef} is a visual or invalid baseline and must not be used as application source.`);
    process.exit(1);
  }
  if (SOURCE_COMPARE_REF) runGit(["rev-parse", "--verify", SOURCE_COMPARE_REF]);
  const files = changedFiles();
  const uiFiles = changedUiFiles(files);

  if (!uiFiles.length) {
    console.log("UI regression guard passed: no UI files changed.");
    return;
  }

  if (!SCOPE.length) {
    console.error("UI regression guard failed: UI files changed without UI_CHANGE_SCOPE.");
    console.error(uiFiles.map(file => `- ${file}`).join("\n"));
    console.error("Set UI_CHANGE_SCOPE to the requested page keys, e.g. UI_CHANGE_SCOPE=orders or UI_CHANGE_SCOPE=orders,global.");
    process.exit(1);
  }

  const unknownScopes = SCOPE.filter(scope => !PAGE_PATTERNS[scope]);
  if (unknownScopes.length) {
    console.error(`UI regression guard failed: unknown UI_CHANGE_SCOPE value(s): ${unknownScopes.join(", ")}`);
    process.exit(1);
  }

  const outOfScopeAssets = uiFiles.filter(file => !TEXT_UI_RE.test(file) && !pathMatchesScope(file));
  if (outOfScopeAssets.length) {
    console.error(`UI regression guard failed: ${outOfScopeAssets.length} changed UI asset(s) did not match scope ${SCOPE.join(", ")}.`);
    console.error(outOfScopeAssets.map(file => `- ${file}`).join("\n"));
    process.exit(1);
  }

  const textUiFiles = uiFiles.filter(file => TEXT_UI_RE.test(file));
  const diff = diffFor(textUiFiles);
  const outOfScope = classifyOutOfScope(diff);
  if (outOfScope.length) {
    console.error(`UI regression guard failed: ${outOfScope.length} changed UI line(s) did not match scope ${SCOPE.join(", ")}.`);
    console.error(outOfScope.slice(0, 80).join("\n"));
    if (outOfScope.length > 80) console.error(`...and ${outOfScope.length - 80} more line(s).`);
    process.exit(1);
  }

  console.log(`UI regression guard passed for scope ${SCOPE.join(", ")}.`);
  console.log(uiFiles.map(file => `- ${file}`).join("\n"));
}

main();
