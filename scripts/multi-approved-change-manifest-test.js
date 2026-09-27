"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "growup-multi-approval-"));
const approvalDir = path.join(fixture, "ui-baselines", "approved-changes");
const legacyPath = path.join(fixture, "ui-baselines", "approved-change-manifest.json");
const appPath = path.join(fixture, "public", "app.js");
const baseText = "function renderPricing() { return 'BEFORE'; }\n";
const targetText = "function renderPricing() { return 'AFTER'; }\n";

function git(...args) {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8" }).trim();
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function records(diff) {
  const result = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) { file = fileMatch[2]; continue; }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (!/^[+-](?![+-])/.test(line)) {
      if (line && oldLine && newLine) { oldLine += 1; newLine += 1; }
      continue;
    }
    const sign = line[0];
    result.push({ file, sign, line: sign === "+" ? newLine : oldLine, text: line.slice(1) });
    if (sign === "+") newLine += 1;
    else oldLine += 1;
  }
  return result;
}

function guard(extraEnv = {}) {
  return spawnSync(process.execPath, ["scripts/ui-regression-guard.js"], {
    cwd: fixture,
    encoding: "utf8",
    env: {
      ...process.env,
      UI_CHANGE_SCOPE: "pricing",
      UI_SOURCE_COMPARE_REF: "",
      UI_APPROVED_CHANGE_MANIFEST: "",
      ...extraEnv
    }
  });
}

function pass(label, extraEnv) {
  const result = guard(extraEnv);
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
}

function fail(label, extraEnv, reason) {
  const result = guard(extraEnv);
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  if (reason) assert.match(result.stderr, reason, `${label}: ${result.stderr}`);
}

function clearApprovals() {
  for (const name of fs.readdirSync(approvalDir)) fs.unlinkSync(path.join(approvalDir, name));
}

function writeApproval(manifest) {
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const file = path.join(approvalDir, `${hash(bytes)}.json`);
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

function makeManifest(base, target, diff, after = "AFTER") {
  return {
    schemaVersion: 1,
    id: "payment-v2-fixture",
    base: { sourceCommit: base },
    ...(target ? { target: { sourceCommit: target } } : {}),
    allowedFiles: ["public/app.js"],
    expectedTextChanges: [{ route: "Pricing", component: "request orchestration", from: "BEFORE", to: after }],
    expectedDiffSha256: hash(diff),
    expectedDiffLines: records(diff)
  };
}

try {
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "public"), { recursive: true });
  fs.mkdirSync(approvalDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "ui-regression-guard.js"), path.join(fixture, "scripts", "ui-regression-guard.js"));
  fs.writeFileSync(appPath, baseText);
  git("init", "-q");
  git("config", "user.email", "guard-test@example.com");
  git("config", "user.name", "Guard Test");
  git("add", "public/app.js", "scripts/ui-regression-guard.js");
  git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");

  fs.writeFileSync(appPath, "function renderPricing() { return 'LEGACY'; }\n");
  const legacyDiff = git("diff", "--unified=0", "--", "public/app.js");
  fs.writeFileSync(legacyPath, `${JSON.stringify(makeManifest(base, "", legacyDiff, "LEGACY"), null, 2)}\n`);
  pass("legacy exact approval", { UI_APPROVED_CHANGE_MANIFEST: legacyPath });
  fs.writeFileSync(appPath, baseText);
  fs.unlinkSync(legacyPath);
  pass("no protected diff");

  fs.writeFileSync(appPath, targetText);
  git("add", "public/app.js");
  git("commit", "-qm", "second exact candidate");
  const target = git("rev-parse", "HEAD");
  const diff = git("diff", "--unified=0", base, "--", "public/app.js");
  const approved = makeManifest(base, target, diff);
  const compare = { UI_SOURCE_COMPARE_REF: base };
  const original = writeApproval(approved);
  pass("second independent exact approval", compare);

  fs.writeFileSync(appPath, "function renderPricing() { return 'UNKNOWN'; }\n");
  fail("unknown patch", compare);
  fs.writeFileSync(appPath, targetText);

  fs.writeFileSync(appPath, "function renderPricing() { return 'OTHER'; }\n");
  const otherDiff = git("diff", "--unified=0", base, "--", "public/app.js");
  clearApprovals();
  writeApproval(makeManifest(base, target, otherDiff, "OTHER"));
  fail("approval for another patch at same target", compare, /does not belong to target commit/);
  fs.writeFileSync(appPath, targetText);

  clearApprovals();
  writeApproval({ ...approved, base: { sourceCommit: target } });
  fail("wrong base", compare);
  clearApprovals();
  writeApproval({ ...approved, target: { sourceCommit: base } });
  fail("wrong target", compare, /target commit|no exact/);
  clearApprovals();
  writeApproval({ ...approved, target: undefined });
  fail("missing target", compare, /exact target commit/);
  clearApprovals();
  writeApproval({ ...approved, expectedDiffSha256: "0".repeat(64) });
  fail("wrong diff hash", compare);

  clearApprovals();
  writeApproval(approved);
  fs.writeFileSync(path.join(fixture, "server.js"), "unapproved\n");
  fail("extra non-UI file", compare, /unapproved candidate files/);
  fs.unlinkSync(path.join(fixture, "server.js"));
  fs.writeFileSync(path.join(fixture, "public", "styles.css"), ".unexpected {}\n");
  fail("approved file plus unauthorized UI file", compare);
  fs.unlinkSync(path.join(fixture, "public", "styles.css"));

  fs.writeFileSync(original.file, `${original.bytes} `);
  fail("tampered content-addressed approval", compare, /content hash mismatch/);
  clearApprovals();
  const malformed = "{broken";
  fs.writeFileSync(path.join(approvalDir, `${hash(malformed)}.json`), malformed);
  fail("malformed approval", compare, /malformed approval/);

  clearApprovals();
  const firstDuplicate = writeApproval(approved);
  writeApproval({ ...approved, id: "another-exact-approval" });
  fail("duplicate ambiguous approvals", compare, /ambiguous exact approvals/);
  fail("override cannot hide ambiguity", { ...compare, UI_APPROVED_CHANGE_MANIFEST: firstDuplicate.file }, /ambiguous exact approvals/);
  clearApprovals();
  fail("empty approval set", compare, /no approval records/);

  writeApproval({ ...approved, allowedFiles: ["public/*"] });
  fail("wildcard approval", compare, /incomplete or unsafe approval/);
  clearApprovals();
  fs.symlinkSync(appPath, path.join(approvalDir, `${"a".repeat(64)}.json`));
  fail("unsafe symlink approval", compare);
  clearApprovals();

  fs.writeFileSync(legacyPath, `${JSON.stringify(makeManifest(base, "", diff), null, 2)}\n`);
  pass("existing explicit manifest override", { ...compare, UI_APPROVED_CHANGE_MANIFEST: legacyPath });
  fail("unsafe override path", { ...compare, UI_APPROVED_CHANGE_MANIFEST: appPath }, /unsafe approval path/);

  fs.unlinkSync(legacyPath);
  const committedApproval = writeApproval(approved);
  git("add", path.relative(fixture, committedApproval.file));
  git("commit", "-qm", "append exact approval record");
  pass("committed approval auto-discovery", compare);
  fs.unlinkSync(committedApproval.file);
  fs.writeFileSync(path.join(fixture, "server.js"), "extra target change\n");
  git("add", "server.js");
  git("commit", "-qm", "unapproved target file");
  writeApproval({ ...approved, target: { sourceCommit: git("rev-parse", "HEAD") } });
  fail("target commit with an extra file", compare, /target commit contains unapproved files/);

  console.log("Multi-approval guard tests passed: legacy, exact second record, and all rejection cases.");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
