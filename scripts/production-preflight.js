"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const UI_PATH = /^public\//;
const BACKEND_PATH = /^(server\.js|lib\/db\/|lib\/auth\.js|lib\/env\.js|lib\/stripe-promptpay\.js|lib\/customer-sync\.js)/;
const TOOLING_PATH = /^(scripts\/|package\.json$|package-lock\.json$)/;
const BACKEND_CONTRACT = {
  "server.js": [
    "diagnoseLineWebhookTenantRejection",
    "LINE webhook persistence failed",
    "async function handleLineWebhookEvents(db, settings, events, options = {})"
  ],
  "lib/db/supabase-adapter.js": [
    "resolveTenantForLineWebhook",
    "diagnoseLineWebhookTenantRejection",
    "MAX_SUPABASE_FILTER_QUERY_LENGTH",
    "selectWhereInChunks",
    "upsertSettings",
    "upsertFollowUpRules",
    "upsertTags",
    "lineGroupIds"
  ]
};

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitMaybe(args, cwd = ROOT) {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

function fileAt(ref, file, cwd = ROOT) {
  return gitMaybe(["show", `${ref}:${file}`], cwd);
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function changedFiles(baseline, candidate, cwd = ROOT) {
  return git(["diff", "--name-only", `${baseline}..${candidate}`], cwd)
    .split("\n")
    .filter(Boolean)
    .sort();
}

function workingTreeDirty(cwd = ROOT) {
  return gitMaybe(["status", "--porcelain", "--untracked-files=all"], cwd)
    .split("\n")
    .filter(Boolean);
}

function isAncestor(baseline, candidate, cwd = ROOT) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", baseline, candidate], {
      cwd,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function uiFiles(ref, cwd = ROOT) {
  return git(["ls-tree", "-r", "--name-only", ref, "public"], cwd)
    .split("\n")
    .filter(Boolean);
}

function uiSnapshotEqual(baseline, candidate, cwd = ROOT) {
  const files = new Set([...uiFiles(baseline, cwd), ...uiFiles(candidate, cwd)]);
  for (const file of files) {
    if (fileAt(baseline, file, cwd) !== fileAt(candidate, file, cwd)) return false;
  }
  return true;
}

function missingBackendContract(candidate, cwd = ROOT) {
  const missing = [];
  for (const [file, symbols] of Object.entries(BACKEND_CONTRACT)) {
    const contents = fileAt(candidate, file, cwd);
    if (!contents) {
      missing.push(`${file}:file`);
      continue;
    }
    for (const symbol of symbols) {
      if (!contents.includes(symbol)) missing.push(`${file}:${symbol}`);
    }
  }
  return missing;
}

function releaseScope(env) {
  return String(env.RELEASE_SCOPE || "ui-only").trim().toLowerCase();
}

function check(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || ROOT;
  const baseline = String(env.PRODUCTION_BASELINE_COMMIT || "").trim();
  const deployment = String(env.PRODUCTION_BASELINE_DEPLOYMENT || "").trim();
  const candidate = String(env.CANDIDATE_COMMIT || git(["rev-parse", "HEAD"], cwd)).trim();
  const scope = releaseScope(env);
  const errors = [];

  if (!baseline || !deployment) errors.push("Production baseline deployment and commit are required.");
  if (!candidate || !gitMaybe(["rev-parse", "--verify", `${candidate}^{commit}`], cwd)) errors.push("Candidate commit cannot be verified.");
  if (baseline && candidate && !isAncestor(baseline, candidate, cwd)) {
    errors.push("Candidate is not based on the verified Production baseline.");
  }

  const dirty = workingTreeDirty(cwd);
  if (dirty.length) errors.push(`Working tree is not clean: ${dirty.join(", ")}`);

  const files = baseline && candidate ? changedFiles(baseline, candidate, cwd) : [];
  const uiChanged = files.filter(file => UI_PATH.test(file));
  const backendChanged = files.filter(file => BACKEND_PATH.test(file));
  const unexpectedFiles = files.filter(file => !UI_PATH.test(file) && !BACKEND_PATH.test(file) && !TOOLING_PATH.test(file));
  const approvedBackendChange = env.BACKEND_CHANGE_APPROVED === "true";
  const requiredTestsPassed = env.REQUIRED_BACKEND_TESTS_PASSED === "true";

  if (scope === "ui-only") {
    if (backendChanged.length) errors.push(`UI-only scope changed backend-critical files: ${backendChanged.join(", ")}`);
    if (unexpectedFiles.length) errors.push(`UI-only scope changed unrelated files: ${unexpectedFiles.join(", ")}`);
  } else if (scope === "line-backend-recovery" || scope === "backend") {
    if (uiChanged.length) errors.push(`Backend recovery changed UI files: ${uiChanged.join(", ")}`);
    if (unexpectedFiles.length) errors.push(`Backend recovery changed unrelated files: ${unexpectedFiles.join(", ")}`);
    if (!approvedBackendChange) errors.push("Backend change is not explicitly approved.");
    if (!requiredTestsPassed) errors.push("Required backend regression tests are not recorded as passed.");
  } else {
    errors.push(`Unknown release scope: ${scope || "(empty)"}`);
  }

  const missingContract = candidate ? missingBackendContract(candidate, cwd) : ["candidate"];
  if (missingContract.length) errors.push(`Backend critical contract is incomplete: ${missingContract.join(", ")}`);
  if ((scope === "line-backend-recovery" || scope === "backend") && baseline && candidate && !uiSnapshotEqual(baseline, candidate, cwd)) {
    errors.push("Candidate UI snapshot differs from the Production baseline.");
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidateCommit: candidate,
    productionBaseline: { deployment, commit: baseline },
    ancestryAligned: Boolean(baseline && candidate && isAncestor(baseline, candidate, cwd)),
    changedFiles: files,
    backendCriticalFiles: { changed: backendChanged, contractMissing: missingContract },
    intendedReleaseScope: scope,
    uiSnapshotUnchanged: baseline && candidate ? uiSnapshotEqual(baseline, candidate, cwd) : false,
    tests: {
      requiredBackendTestsPassed: requiredTestsPassed,
      previewDeployment: String(env.PREVIEW_DEPLOYMENT || "")
    },
    rollbackTarget: deployment,
    result: errors.length ? "blocked" : "passed"
  };
  return { ok: errors.length === 0, errors, manifest };
}

function main() {
  const result = check();
  const output = process.env.DEPLOYMENT_MANIFEST_PATH || path.join(ROOT, "artifacts", "deployment-manifest.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  if (!result.ok) {
    console.error("BLOCKED / PRODUCTION SOURCE NOT ALIGNED");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Production preflight passed. Manifest: ${output}`);
}

if (require.main === module) main();

module.exports = {
  BACKEND_CONTRACT,
  check,
  changedFiles,
  missingBackendContract,
  uiSnapshotEqual
};
