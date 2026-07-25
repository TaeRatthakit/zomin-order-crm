"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE_URL = process.env.GROWUP_BASELINE_URL || "https://www.growuppilot.com";
const OUT_DIR = path.resolve(process.env.UI_BASELINE_DIR || "ui-baselines/current");
const USERNAME = process.env.GROWUP_BASELINE_USERNAME || process.env.ADMIN_USERNAME;
const PASSWORD = process.env.GROWUP_BASELINE_PASSWORD || process.env.ADMIN_PASSWORD;

const VIEWPORTS = {
  desktop: { width: 1440, height: 1100, isMobile: false },
  mobile: { width: 390, height: 844, isMobile: true }
};

const THEMES = ["light", "dark"];

const PAGES = [
  { key: "login", path: "/login", auth: false },
  { key: "dashboard", path: "/dashboard", auth: true },
  { key: "customers", path: "/customers", auth: true },
  { key: "orders", path: "/orders", auth: true },
  { key: "opportunities", path: "/opportunities", auth: true },
  { key: "follow-up", path: "/follow-up", auth: true },
  { key: "vip", path: "/vip", auth: true },
  { key: "tags", path: "/tags", auth: true },
  { key: "import", path: "/import", auth: true },
  { key: "reports", path: "/reports", auth: true },
  { key: "settings", path: "/settings", auth: true },
  { key: "finance", path: "/settings/finance", auth: true },
  { key: "team", path: "/team", auth: true },
  { key: "export-backup", path: "/settings/import-export", auth: true }
];

const ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=20260724-desktop-home-hero-v4",
  "/app.js?v=20260724-desktop-home-hero-v4",
  "/service-worker.js"
];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fetchAsset(urlPath) {
  const url = new URL(urlPath, BASE_URL);
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  return {
    path: urlPath,
    url: url.toString(),
    status: response.status,
    bytes: body.length,
    sha256: sha256(body),
    etag: response.headers.get("etag") || null,
    contentType: response.headers.get("content-type") || null
  };
}

function inspectDeployment() {
  try {
    const output = execFileSync("npx", ["vercel", "inspect", BASE_URL, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return JSON.parse(output.slice(output.indexOf("{")));
  } catch (error) {
    return { error: error.message };
  }
}

async function login(page) {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Set GROWUP_BASELINE_USERNAME/GROWUP_BASELINE_PASSWORD or ADMIN_USERNAME/ADMIN_PASSWORD.");
  }
  await page.goto(new URL("/login", BASE_URL).toString(), { waitUntil: "networkidle" });
  await page.fill('input[name="username"], input[type="text"]', USERNAME);
  await page.fill('input[name="password"], input[name="pin"], input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    page.click('button[type="submit"], button:has-text("เข้าสู่ระบบ"), button:has-text("Login")')
  ]);
  await page.waitForTimeout(800);
  if (page.url().includes("/login")) {
    throw new Error("Production login did not leave /login.");
  }
}

async function forceTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(selectedTheme => {
    document.documentElement.dataset.themePreference = selectedTheme;
    document.documentElement.dataset.theme = selectedTheme;
    document.body?.setAttribute("data-ui-baseline-theme", selectedTheme);
    window.dispatchEvent(new Event("resize"));
  }, theme);
  await page.waitForTimeout(300);
}

async function capturePage(browser, pageSpec, viewportName, viewport, theme, screenshotDir) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    deviceScaleFactor: viewport.isMobile ? 2 : 1,
    colorScheme: theme,
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  try {
    if (pageSpec.auth) await login(page);
    await page.goto(new URL(pageSpec.path, BASE_URL).toString(), { waitUntil: "networkidle" });
    await forceTheme(page, theme);
    await page.screenshot({
      path: path.join(screenshotDir, `${pageSpec.key}-${viewportName}-${theme}.png`),
      fullPage: true
    });
    return {
      page: pageSpec.key,
      path: pageSpec.path,
      viewport: viewportName,
      theme,
      finalUrl: page.url(),
      errors
    };
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const screenshotDir = path.join(OUT_DIR, "screenshots");
  fs.mkdirSync(screenshotDir, { recursive: true });

  const assets = [];
  for (const asset of ASSETS) assets.push(await fetchAsset(asset));

  const git = {
    tag: "ui-baseline-current",
    taggedCommit: execFileSync("git", ["rev-parse", "ui-baseline-current^{commit}"], { encoding: "utf8" }).trim(),
    currentHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    originMain: execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim()
  };

  const browser = await chromium.launch();
  const screenshots = [];
  try {
    for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
      for (const theme of THEMES) {
        for (const pageSpec of PAGES) {
          screenshots.push(await capturePage(browser, pageSpec, viewportName, viewport, theme, screenshotDir));
        }
      }
    }
  } finally {
    await browser.close();
  }

  const manifest = {
    name: "ui-baseline-current",
    capturedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    deployment: inspectDeployment(),
    git,
    rule: "Do not restore, copy, cherry-pick, deploy, or reintroduce UI code, CSS, HTML, components, or assets older than this baseline without explicit user approval.",
    pages: PAGES,
    viewports: VIEWPORTS,
    themes: THEMES,
    assets,
    screenshots
  };

  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Captured ${screenshots.length} screenshots in ${screenshotDir}`);
  console.log(`Wrote ${path.join(OUT_DIR, "manifest.json")}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
