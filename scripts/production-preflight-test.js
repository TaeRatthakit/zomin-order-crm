"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { check } = require("./production-preflight");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(cwd, file, contents) {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function fail(message) {
  throw new Error(`Production preflight guard test failed: ${message}`);
}

function createRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "growup-production-preflight-"));
  run("git", ["init", "-q"], cwd);
  run("git", ["config", "user.email", "preflight-test@example.com"], cwd);
  run("git", ["config", "user.name", "Production Preflight Test"], cwd);
  write(cwd, "server.js", "async function handleLineWebhookEvents(db, settings, events, options = {}) {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst persistenceLog = 'LINE webhook persistence failed';\\n");
  write(cwd, "lib/db/supabase-adapter.js", "function resolveTenantForLineWebhook() {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst MAX_SUPABASE_FILTER_QUERY_LENGTH = 3500;\\nasync function selectWhereInChunks() {}\\nasync function upsertSettings() {}\\nasync function upsertFollowUpRules() {}\\nasync function upsertTags() {}\\nconst trusted = 'lineGroupIds';\\n");
  write(cwd, "public/styles.css", "body { color: black; }\\n");
  run("git", ["add", "."], cwd);
  run("git", ["commit", "-qm", "baseline"], cwd);
  return cwd;
}

function commitCandidate(cwd, message) {
  run("git", ["add", "."], cwd);
  run("git", ["commit", "-qm", message], cwd);
  return run("git", ["rev-parse", "HEAD"], cwd);
}

function result(cwd, candidate, scope, extra = {}) {
  const baseline = run("git", ["rev-list", "--max-parents=0", "HEAD"], cwd);
  return check({
    cwd,
    env: {
      PRODUCTION_BASELINE_COMMIT: baseline,
      PRODUCTION_BASELINE_DEPLOYMENT: "dpl_test_baseline",
      CANDIDATE_COMMIT: candidate,
      RELEASE_SCOPE: scope,
      ...extra
    }
  });
}

let cwd = createRepo();
let baseline = run("git", ["rev-list", "--max-parents=0", "HEAD"], cwd);
write(cwd, "public/styles.css", "body { color: white; }\\n");
let candidate = commitCandidate(cwd, "css-only change");
let checkResult = check({ cwd, env: {
  PRODUCTION_BASELINE_COMMIT: baseline,
  PRODUCTION_BASELINE_DEPLOYMENT: "dpl_test_baseline",
  CANDIDATE_COMMIT: candidate,
  RELEASE_SCOPE: "ui-only"
} });
if (!checkResult.ok) fail("CSS-only change should pass");

cwd = createRepo();
baseline = run("git", ["rev-list", "--max-parents=0", "HEAD"], cwd);
write(cwd, "server.js", "console.log('stale backend');\\n");
write(cwd, "public/styles.css", "body { color: white; }\\n");
candidate = commitCandidate(cwd, "stale backend with css-only message");
checkResult = result(cwd, candidate, "ui-only");
if (checkResult.ok) fail("stale backend tree should fail UI-only scope");

cwd = createRepo();
write(cwd, "lib/db/supabase-adapter.js", "function resolveTenantForLineWebhook() {}\\nconst lineGroupIds = [];\\n");
candidate = commitCandidate(cwd, "missing backend contract");
checkResult = result(cwd, candidate, "line-backend-recovery", {
  BACKEND_CHANGE_APPROVED: "true",
  REQUIRED_BACKEND_TESTS_PASSED: "true"
});
if (checkResult.ok) fail("missing backend fix should fail contract check");

cwd = createRepo();
write(cwd, "server.js", "async function handleLineWebhookEvents(db, settings, events, options = {}) {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst persistenceLog = 'LINE webhook persistence failed';\\n// approved backend change\\n");
candidate = commitCandidate(cwd, "approved backend change");
checkResult = result(cwd, candidate, "backend", {
  BACKEND_CHANGE_APPROVED: "true",
  REQUIRED_BACKEND_TESTS_PASSED: "true"
});
if (!checkResult.ok) fail("approved backend change should be eligible");

cwd = createRepo();
write(cwd, "server.js", "async function handleLineWebhookEvents(db, settings, events, options = {}) {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst persistenceLog = 'LINE webhook persistence failed';\\n// unrelated mutation\\n");
candidate = commitCandidate(cwd, "unrelated backend mutation");
checkResult = result(cwd, candidate, "ui-only");
if (checkResult.ok) fail("unrelated backend mutation should fail UI-only scope");

cwd = createRepo();
write(cwd, "server.js", "async function handleLineWebhookEvents(db, settings, events, options = {}) {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst persistenceLog = 'LINE webhook persistence failed';\\n// backend recovery\\n");
candidate = commitCandidate(cwd, "backend recovery preserving ui");
checkResult = result(cwd, candidate, "line-backend-recovery", {
  BACKEND_CHANGE_APPROVED: "true",
  REQUIRED_BACKEND_TESTS_PASSED: "true"
});
if (!checkResult.ok || !checkResult.manifest.uiSnapshotUnchanged) fail("backend recovery changed the approved UI snapshot");

cwd = createRepo();
write(cwd, "server.js", "async function handleLineWebhookEvents(db, settings, events, options = {}) {}\\nfunction diagnoseLineWebhookTenantRejection() {}\\nconst persistenceLog = 'LINE webhook persistence failed';\\n// pricing payment backend\\n");
write(cwd, "public/styles.css", "body { color: white; }\\n/* pricing payment ui */\\n");
write(cwd, "supabase/migrations/20260818000000_platform_admin_audit_read.sql", "create or replace function public.growup_platform_admin_audit_log() returns void language sql as $$ select $$;\\n");
write(cwd, "supabase/migrations/20260822010000_subscription_upgrade.sql", "create table if not exists public.subscription_upgrade_attempts ();\\n");
write(cwd, "supabase/migrations/20260826010000_legacy_subscription_compatibility.sql", "alter table public.subscriptions add column if not exists source text;\\n");
candidate = commitCandidate(cwd, "approved pricing payment release");
checkResult = result(cwd, candidate, "pricing-payment", {
  BACKEND_CHANGE_APPROVED: "true",
  REQUIRED_BACKEND_TESTS_PASSED: "true"
});
if (!checkResult.ok) fail("approved pricing/payment release should be eligible");

cwd = createRepo();
write(cwd, "public/customers.html", "unrelated customer ui\\n");
candidate = commitCandidate(cwd, "pricing payment release with unrelated file");
checkResult = result(cwd, candidate, "pricing-payment", {
  BACKEND_CHANGE_APPROVED: "true",
  REQUIRED_BACKEND_TESTS_PASSED: "true"
});
if (checkResult.ok) fail("pricing/payment release should reject unrelated files");

console.log("Production preflight guard tests passed.");
