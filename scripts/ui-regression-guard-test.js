"use strict";

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GUARD_SOURCE = path.join(ROOT, "scripts", "ui-regression-guard.js");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "growup-ui-guard-"));
  write(path.join(dir, "scripts", "ui-regression-guard.js"), fs.readFileSync(GUARD_SOURCE, "utf8"));
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle">',
    '      <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '        <p>Starter</p>',
    '      </section>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button>`;',
    '}',
    ''
  ].join("\n"));
  write(path.join(dir, "public", "landing.html"), [
    '<main class="landing-page">',
    '  <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle">',
    '    <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '      <p>Starter</p>',
    '    </section>',
    '  </section>',
    '</main>',
    ''
  ].join("\n"));
  run("git", ["init"], { cwd: dir });
  run("git", ["config", "user.email", "guard-test@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Guard Test"], { cwd: dir });
  run("git", ["add", "."], { cwd: dir });
  run("git", ["commit", "-m", "baseline"], { cwd: dir });
  return dir;
}

function runGuard(dir) {
  try {
    run("node", ["scripts/ui-regression-guard.js"], {
      cwd: dir,
      env: { ...process.env, UI_CHANGE_SCOPE: "landing,global" }
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ""}${error.stderr || ""}`
    };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withRepo(mutator) {
  const dir = createRepo();
  mutator(dir);
  return runGuard(dir);
}

function approveExactPricingFixture(dir) {
  const base = run("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
  const diff = run("git", ["diff", "--unified=0", "--", "public/app.js"], { cwd: dir }).trim();
  const records = [];
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
    records.push({ file, sign, line: sign === "+" ? newLine : oldLine, text: line.slice(1) });
    if (sign === "+") newLine += 1;
    else oldLine += 1;
  }
  write(path.join(dir, "ui-baselines", "approved-change-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture-exact-pricing-approval",
    base: { sourceCommit: base },
    allowedFiles: ["public/app.js"],
    expectedTextChanges: [{ route: "Pricing", component: "pricing section", from: 'aria-labelledby="landingPricingTitle">', to: "data-landing-pricing" }],
    expectedDiffSha256: crypto.createHash("sha256").update(diff).digest("hex"),
    expectedDiffLines: records
  }, null, 2));
}

let result = withRepo(dir => {
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle" data-landing-pricing data-billing="monthly">',
    '      <div>',
    '        <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '          <p>Starter</p>',
    '        </section>',
    '      </div>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button>`;',
    '}',
    ''
  ].join("\n"));
  approveExactPricingFixture(dir);
});
assert(result.ok, "approved pricing structural diff should pass");

result = withRepo(dir => {
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <div>',
    '      </div>',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle">',
    '      <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '        <p>Starter</p>',
    '      </section>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button>`;',
    '}',
    ''
  ].join("\n"));
});
assert(!result.ok, "same structural diff outside pricing block should fail");

result = withRepo(dir => {
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle">',
    '      <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '        <p>Starter</p>',
    '      </section>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button><dialog id="adminUserDialog">Owner</dialog>`;',
    '}',
    ''
  ].join("\n"));
});
assert(!result.ok, "private-app UI changes should fail under landing scope");

result = withRepo(dir => {
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle">',
    '      <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '        <p>Starter</p>',
    '      </section>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <div>',
    '      </div>',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button>`;',
    '}',
    ''
  ].join("\n"));
});
assert(!result.ok, "unrelated landing-section structural changes should fail");

result = withRepo(dir => {
  write(path.join(dir, "public", "app.js"), [
    'function renderLanding() {',
    '  return `',
    '    <section class="landing-hero">',
    '      <h1>จัดการธุรกิจให้เติบโต</h1>',
    '    </section>',
    '    <section id="pricing" class="landing-section landing-pricing" aria-labelledby="landingPricingTitle" data-landing-pricing data-billing="monthly">',
    '      <div>',
    '        <section class="landing-price-card" aria-label="Starter ราคา 490 บาทต่อเดือน">',
    '          <p>Starter</p>',
    '        </section>',
    '      </div>',
    '    </section>',
    '    <section class="landing-section landing-features">',
    '      <div>',
    '      </div>',
    '      <h2>จุดเด่น</h2>',
    '    </section>',
    '  `;',
    '}',
    'function renderDashboard() {',
    '  return `<button id="orderSubmitButton">เพิ่มออเดอร์</button>`;',
    '}',
    ''
  ].join("\n"));
});
assert(!result.ok, "unrelated landing structural hunk should fail even when a pricing hunk also changes");

console.log("UI regression guard self-test passed.");
