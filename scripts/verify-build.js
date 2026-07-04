const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const checkFiles = [
  "server.js",
  "public/app.js",
  "public/service-worker.js",
  "lib/env.js",
  "lib/auth.js",
  "lib/advertising.js",
  "lib/db/index.js",
  "lib/db/json-adapter.js",
  "lib/db/supabase-adapter.js",
  "scripts/smoke-test.js",
  "scripts/seed.js",
  "scripts/seed-admin.js",
  "scripts/migrate-json-to-supabase.js"
];

const requiredFiles = [
  "data/db.json",
  ".env.example",
  "supabase/schema.sql",
  "README_DEPLOY.md",
  "PROGRESS_REPORT.md",
  "public/manifest.webmanifest",
  "public/icons/apple-touch-icon.png",
  "public/icons/icon-192.png",
  "public/icons/icon-512.png",
  "public/icons/maskable-icon-192.png",
  "public/icons/maskable-icon-512.png",
  "vercel.json",
  "render.yaml"
];

function runNodeCheck(file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${file} failed syntax check:\n${result.stderr || result.stdout}`);
  }
}

for (const file of checkFiles) runNodeCheck(file);

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const db = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "db.json"), "utf8"));
const unsafeUser = (db.users || []).find(user => user.password || user.pin || !user.passwordHash);
if (unsafeUser) {
  throw new Error(`User ${unsafeUser.username || unsafeUser.id} must use passwordHash only.`);
}

for (const key of ["settings", "followUpRules", "users", "customers", "orders", "tags"]) {
  if (!db[key]) throw new Error(`data/db.json missing ${key}`);
}

console.log("Production verification passed.");
