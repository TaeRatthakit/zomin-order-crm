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

const binaryFixture = fs.mkdtempSync(path.join(os.tmpdir(), "growup-binary-approval-"));
try {
  const runBinaryGit = (...args) => execFileSync("git", args, { cwd: binaryFixture, encoding: "utf8" }).trim();
  const binaryApprovalDir = path.join(binaryFixture, "ui-baselines", "approved-changes");
  const binaryAppPath = path.join(binaryFixture, "public", "app.js");
  const binaryAssetRelative = "public/assets/pricing/starter-storefront.webp";
  const binaryAssetPath = path.join(binaryFixture, binaryAssetRelative);
  const originalAsset = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);
  const guardPath = path.join(binaryFixture, "scripts", "ui-regression-guard.js");
  const testPath = path.join(binaryFixture, "scripts", "multi-approved-change-manifest-test.js");
  fs.mkdirSync(path.dirname(binaryAssetPath), { recursive: true });
  fs.mkdirSync(binaryApprovalDir, { recursive: true });
  fs.mkdirSync(path.dirname(guardPath), { recursive: true });
  fs.writeFileSync(binaryAppPath, baseText);
  fs.writeFileSync(guardPath, "// guard before binary support\n");
  fs.writeFileSync(testPath, "// tests before binary support\n");
  runBinaryGit("init", "-q");
  runBinaryGit("config", "user.email", "guard-test@example.com");
  runBinaryGit("config", "user.name", "Guard Test");
  runBinaryGit("add", "public/app.js", "scripts/ui-regression-guard.js", "scripts/multi-approved-change-manifest-test.js");
  runBinaryGit("commit", "-qm", "base");
  const binaryBase = runBinaryGit("rev-parse", "HEAD");

  fs.writeFileSync(binaryAppPath, targetText);
  fs.writeFileSync(binaryAssetPath, originalAsset);
  runBinaryGit("add", "public/app.js", binaryAssetRelative);
  runBinaryGit("commit", "-qm", "product patch");
  const binaryTarget = runBinaryGit("rev-parse", "HEAD");
  const binaryDiff = runBinaryGit("diff", "--unified=0", binaryBase, binaryTarget, "--", "public/app.js");

  fs.copyFileSync(path.join(__dirname, "ui-regression-guard.js"), guardPath);
  fs.copyFileSync(__filename, testPath);
  runBinaryGit("add", "scripts/ui-regression-guard.js", "scripts/multi-approved-change-manifest-test.js");
  runBinaryGit("commit", "-qm", "exact binary approval tooling");
  const binaryTooling = runBinaryGit("rev-parse", "HEAD");

  const binaryManifest = {
    ...makeManifest(binaryBase, binaryTarget, binaryDiff),
    id: "binary-pricing-fixture",
    allowedFiles: ["public/app.js", binaryAssetRelative],
    expectedBinaryAssets: [{ path: binaryAssetRelative, status: "added", sha256: hash(originalAsset) }],
    tooling: {
      sourceCommit: binaryTooling,
      allowedFiles: ["scripts/ui-regression-guard.js", "scripts/multi-approved-change-manifest-test.js"]
    }
  };
  const binaryGuard = () => spawnSync(process.execPath, ["scripts/ui-regression-guard.js"], {
    cwd: binaryFixture,
    encoding: "utf8",
    env: { ...process.env, UI_CHANGE_SCOPE: "pricing", UI_SOURCE_COMPARE_REF: binaryBase, UI_APPROVED_CHANGE_MANIFEST: "" }
  });
  const binaryPass = label => {
    const result = binaryGuard();
    assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  };
  const binaryFail = (label, reason) => {
    const result = binaryGuard();
    assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
    if (reason) assert.match(result.stderr, reason, `${label}: ${result.stderr}`);
  };
  const clearBinaryApprovals = () => {
    for (const name of fs.readdirSync(binaryApprovalDir)) fs.unlinkSync(path.join(binaryApprovalDir, name));
  };
  const approveBinary = manifest => {
    clearBinaryApprovals();
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(binaryApprovalDir, `${hash(bytes)}.json`), bytes);
  };

  approveBinary(binaryManifest);
  binaryPass("exact added binary asset and tooling commit");

  const changedAsset = Buffer.from(originalAsset);
  changedAsset[changedAsset.length - 1] ^= 1;
  fs.writeFileSync(binaryAssetPath, changedAsset);
  binaryFail("one-byte asset mutation", /binary asset hash mismatch/);
  fs.writeFileSync(binaryAssetPath, originalAsset);

  const renamedAsset = path.join(path.dirname(binaryAssetPath), "renamed.webp");
  fs.renameSync(binaryAssetPath, renamedAsset);
  binaryFail("binary asset path change");
  fs.renameSync(renamedAsset, binaryAssetPath);

  const extraAsset = path.join(path.dirname(binaryAssetPath), "extra.webp");
  fs.writeFileSync(extraAsset, originalAsset);
  binaryFail("extra unapproved binary asset");
  fs.unlinkSync(extraAsset);

  fs.unlinkSync(binaryAssetPath);
  binaryFail("missing approved binary asset");
  fs.writeFileSync(binaryAssetPath, originalAsset);

  approveBinary({ ...binaryManifest, expectedBinaryAssets: [{ ...binaryManifest.expectedBinaryAssets[0], status: "modified" }] });
  binaryFail("binary asset status differs", /exact target, binary assets, and tooling/);
  approveBinary({ ...binaryManifest, expectedBinaryAssets: [{ ...binaryManifest.expectedBinaryAssets[0], sha256: "0".repeat(64) }] });
  binaryFail("target bytes differ from approval", /binary asset hash mismatch/);
  approveBinary({ ...binaryManifest, target: { sourceCommit: binaryTooling } });
  binaryFail("target commit differs");
  approveBinary({ ...binaryManifest, base: { sourceCommit: binaryTarget } });
  binaryFail("base commit differs");
  approveBinary(binaryManifest);

  const unrelatedText = path.join(binaryFixture, "public", "styles.css");
  fs.writeFileSync(unrelatedText, ".unapproved {}\n");
  binaryFail("unrelated protected text UI line");
  fs.unlinkSync(unrelatedText);
  fs.writeFileSync(binaryAppPath, `${targetText}// extra approved-file mutation\n`);
  binaryFail("approved text file mutated beyond exact diff");
  fs.writeFileSync(binaryAppPath, targetText);

  fs.appendFileSync(testPath, "// unapproved tooling mutation\n");
  binaryFail("tooling bytes mutated", /approved tooling commit or working files differ/);
  fs.copyFileSync(__filename, testPath);
  binaryPass("exact state restored after disposable mutations");

  console.log("Binary approval guard tests passed: exact bytes, path, status, commits, tooling, and mutation rejection.");
} finally {
  fs.rmSync(binaryFixture, { recursive: true, force: true });
}
