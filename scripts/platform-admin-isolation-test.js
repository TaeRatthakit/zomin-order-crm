"use strict";

process.env.DATABASE_PROVIDER = "json";

const assert = require("assert");
const handler = require("../server");
const { loadPlatformAdmin, platformAdminSnapshot, platformAdminCookie } = require("../lib/platform-admin");

function request(method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const result = {};
    const res = {
      writeHead(status, responseHeaders) {
        result.status = status;
        result.headers = responseHeaders;
      },
      end(body) {
        result.body = String(body || "");
        resolve(result);
      }
    };
    Promise.resolve(handler({ method, url, headers: { host: "localhost", ...headers } }, res)).catch(reject);
  });
}

(async () => {
  assert.strictEqual(await loadPlatformAdmin("admin"), null, "customer Admin must not be a Platform Admin");
  const apiResponse = await request("GET", "/api/platform-admin/dashboard");
  assert.strictEqual(apiResponse.status, 401, "Platform Admin API must fail closed without its session");
  const pageResponse = await request("GET", "/platform-admin");
  assert.strictEqual(pageResponse.status, 302, "protected Platform Admin page must redirect without its session");
  const snapshot = await platformAdminSnapshot({ start: "2026-06-01", end: "2026-06-30" });
  assert.deepStrictEqual(snapshot.range, { start: "2026-06-01", end: "2026-06-30" }, "date range must be exact and inclusive");
  assert.ok(!JSON.stringify(snapshot).includes("passwordHash"), "Platform Admin snapshot must not expose password fields");
  assert.strictEqual(snapshot.revenue.gross, null, "missing authoritative payment source must remain unavailable");

  process.env.VERCEL_ENV = "preview";
  process.env.PLATFORM_ADMIN_PREVIEW_UI_BYPASS = "true";
  process.env.PLATFORM_ADMIN_PREVIEW_DATA_MODE = "mock";
  const previewPage = await request("GET", "/platform-admin");
  assert.strictEqual(previewPage.status, 302, "Platform Admin page must remain protected without a real session");
  const previewApi = await request("GET", "/api/platform-admin/settings");
  assert.strictEqual(previewApi.status, 401, "Platform Admin API must remain protected without a real session");
  const previewWrite = await request("POST", "/api/platform-admin/promos");
  assert.strictEqual(previewWrite.status, 401, "Platform Admin writes must remain protected without a real session");
  assert.ok(platformAdminCookie("token", Date.now() + 60000).includes("Path=/;"), "Platform Admin cookie must cover protected APIs");

  process.env.VERCEL_ENV = "production";
  const productionPage = await request("GET", "/platform-admin");
  assert.strictEqual(productionPage.status, 302, "Production must remain fail-closed even if the Preview flag is set");
  const productionApi = await request("GET", "/api/platform-admin/settings");
  assert.strictEqual(productionApi.status, 401, "Production Platform Admin API must remain protected");
  console.log("Platform Admin isolation test passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
