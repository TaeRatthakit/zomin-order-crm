"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function fail(message) {
  throw new Error(`Approved-change manifest test failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function diffRecords(diff) {
  const records = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) { file = fileMatch[2]; continue; }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) { oldLine = Number(hunkMatch[1]); newLine = Number(hunkMatch[2]); continue; }
    if (!/^[+-](?![+-])/.test(line)) {
      if (line && oldLine && newLine) { oldLine += 1; newLine += 1; }
      continue;
    }
    const sign = line[0];
    records.push({ file, sign, line: sign === "+" ? newLine : oldLine, text: line.slice(1) });
    if (sign === "+") newLine += 1;
    else oldLine += 1;
  }
  return records;
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "growup-approved-manifest-"));
fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
fs.mkdirSync(path.join(fixture, "public"), { recursive: true });
fs.mkdirSync(path.join(fixture, "ui-baselines"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "ui-regression-guard.js"), path.join(fixture, "scripts", "ui-regression-guard.js"));
fs.writeFileSync(path.join(fixture, "public", "app.js"), "function renderLanding() { return '<button>Old</button>'; }\n");
run("git", ["init"], fixture);
run("git", ["config", "user.email", "guard-test@example.com"], fixture);
run("git", ["config", "user.name", "Guard Test"], fixture);
run("git", ["add", "."], fixture);
run("git", ["commit", "-m", "baseline"], fixture);
const baseCommit = run("git", ["rev-parse", "HEAD"], fixture).trim();

const candidate = "function renderLanding() { return '<button>New approved CTA</button>'; }\n";
fs.writeFileSync(path.join(fixture, "public", "app.js"), candidate);
const diff = run("git", ["diff", "--unified=0", "--", "public/app.js"], fixture).trim();
const manifest = {
  schemaVersion: 1,
  id: "fixture-approved-change",
  base: { sourceCommit: baseCommit, productionArtifact: "fixture-artifact" },
  allowedFiles: ["public/app.js"],
  approvedChanges: [{ route: "Public Homepage", component: "approved CTA", regions: ["CTA"], selectors: ["button"] }],
  expectedTextChanges: [{ route: "Public Homepage", component: "approved CTA", from: "Old", to: "New approved CTA" }],
  expectedDiffSha256: crypto.createHash("sha256").update(diff).digest("hex"),
  expectedDiffLines: diffRecords(diff)
};
const manifestPath = path.join(fixture, "ui-baselines", "approved-change-manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

function guard() {
  try {
    run("node", ["scripts/ui-regression-guard.js"], fixture, {
      env: { ...process.env, UI_CHANGE_SCOPE: "landing", UI_APPROVED_CHANGE_MANIFEST: manifestPath }
    });
    return true;
  } catch (error) {
    return false;
  }
}

assert(guard(), "the exact approved manifest fixture must pass");
fs.writeFileSync(path.join(fixture, "public", "app.js"), `${candidate}function renderDashboard() { return '<div>unapproved</div>'; }\n`);
assert(!guard(), "an additional UI change must fail the exact manifest gate");
console.log("Approved-change manifest safety test passed");
