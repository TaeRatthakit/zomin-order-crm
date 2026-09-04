"use strict";

const fs = require("fs");
const path = require("path");
const {
  authorizePlatformAdmin,
  clearPlatformAdminCookie,
  platformAdminCookie,
  platformAdminLoginResult,
  changePlatformAdminPassword,
  platformAdminSnapshot,
  platformAdminPromoAudit,
  platformAdminPromoList,
  platformAdminPromoStorageLabel,
  platformAdminPromoWriteStatus,
  platformAdminSavePromo,
  platformAdminSetPromoActive,
  assertSameOrigin,
  TIME_ZONE
} = require("./platform-admin");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PLATFORM_ADMIN_ROOT = path.join(PUBLIC_DIR, "platform-admin");
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function staticHeaders(filePath) {
  const ext = path.extname(filePath);
  return ext === ".html"
    ? { "Cache-Control": "no-store" }
    : { "Cache-Control": "public, max-age=0, must-revalidate" };
}

function servePlatformAdminStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let relative = "";
  try { relative = decodeURIComponent(url.pathname.replace(/^\/platform-admin\/?/, "")); }
  catch { return text(res, 400, "Bad request"); }
  const requestedPath = relative && !relative.includes("..") && /\.[a-z0-9]+$/i.test(relative)
    ? relative
    : "index.html";
  const filePath = path.join(PLATFORM_ADMIN_ROOT, requestedPath);
  if (!filePath.startsWith(PLATFORM_ADMIN_ROOT)) return text(res, 403, "Forbidden");
  fs.readFile(filePath, (error, file) => {
    if (error) return text(res, 404, "Not found");
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      ...staticHeaders(filePath)
    });
    res.end(file);
  });
}

function isModernPlatformAdminApi(pathname) {
  return [
    "/api/platform-admin/login",
    "/api/platform-admin/session",
    "/api/platform-admin/logout",
    "/api/platform-admin/password",
    "/api/platform-admin/dashboard",
    "/api/platform-admin/promos",
    "/api/platform-admin/settings"
  ].includes(pathname) || pathname.startsWith("/api/platform-admin/promos/");
}

async function requirePlatformAdmin(req, res) {
  const user = await authorizePlatformAdmin(req);
  if (!user) {
    json(res, 401, { ok: false, error: "ไม่มีสิทธิ์เข้าถึง Platform Admin" }, { "Set-Cookie": clearPlatformAdminCookie() });
    return null;
  }
  return user;
}

function promoError(res, error) {
  const detail = String(error?.message || "");
  if (error?.status === 403 || detail.includes("PLATFORM_ADMIN")) return json(res, 403, { ok: false, error: "ไม่มีสิทธิ์แก้ไข Promo" });
  if (error?.status === 409 || error?.code === "23505" || /duplicate|unique|PROMOTION_CODE_EXISTS/i.test(detail)) return json(res, 409, { ok: false, error: "Code นี้มีอยู่แล้ว" });
  if (/INVALID_PROMOTION|ไม่ถูกต้อง|ต้อง|เปอร์เซ็นต์|จำนวน|กรุณาระบุ|วันหมดอายุ/i.test(detail)) return json(res, 400, { ok: false, error: detail.includes("PLATFORM_ADMIN") ? "ข้อมูล Promo ไม่ถูกต้อง" : detail });
  return json(res, 502, { ok: false, error: "ไม่สามารถบันทึก Promo ได้" });
}

function promoPagination(url, defaultLimit, maxLimit) {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const parsedLimit = rawLimit === null ? null : Number(rawLimit);
  const parsedOffset = rawOffset === null ? null : Number(rawOffset);
  return {
    limit: Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), maxLimit) : defaultLimit,
    offset: Number.isInteger(parsedOffset) ? Math.max(parsedOffset, 0) : 0
  };
}

async function handlePlatformAdminApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/platform-admin/login") {
    const body = await readBody(req);
    const result = await platformAdminLoginResult(String(body.username || body.userId || ""), String(body.password || ""));
    if (!result) return json(res, 401, { ok: false, error: "ข้อมูลเข้าสู่ระบบไม่ถูกต้องหรือบัญชีไม่ได้รับอนุญาต" });
    return json(res, 200, { ok: true, user: result.user }, { "Set-Cookie": platformAdminCookie(result.session.token, result.session.expiresAt) });
  }
  if (req.method === "GET" && url.pathname === "/api/platform-admin/session") {
    const user = await authorizePlatformAdmin(req);
    if (!user) return json(res, 200, { ok: true, user: null }, { "Set-Cookie": clearPlatformAdminCookie() });
    return json(res, 200, { ok: true, user });
  }
  if (req.method === "POST" && url.pathname === "/api/platform-admin/logout") {
    return json(res, 200, { ok: true }, { "Set-Cookie": clearPlatformAdminCookie() });
  }

  const currentUser = await requirePlatformAdmin(req, res);
  if (!currentUser) return;

  if (req.method === "POST" && url.pathname === "/api/platform-admin/password") {
    const body = await readBody(req);
    const result = await changePlatformAdminPassword(currentUser.id, body.currentPassword, body.newPassword, body.confirmPassword);
    if (!result.ok) return json(res, result.status || 400, { ok: false, error: result.error });
    return json(res, 200, { ok: true, userId: result.userId, username: result.username }, { "Set-Cookie": clearPlatformAdminCookie() });
  }

  if (req.method === "GET" && url.pathname === "/api/platform-admin/dashboard") {
    return json(res, 200, { ok: true, snapshot: await platformAdminSnapshot(Object.fromEntries(url.searchParams.entries())) });
  }
  if (req.method === "GET" && url.pathname === "/api/platform-admin/promos") {
    try {
      const result = await platformAdminPromoList(currentUser.id, promoPagination(url, 25, 200));
      return json(res, 200, { ok: true, ...result, storage: platformAdminPromoStorageLabel(), write: platformAdminPromoWriteStatus(currentUser.id) });
    } catch (error) {
      return promoError(res, error);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/platform-admin/promos/audit") {
    try {
      const result = await platformAdminPromoAudit(currentUser.id, promoPagination(url, 20, 100));
      return json(res, 200, { ok: true, ...result, storage: platformAdminPromoStorageLabel() });
    } catch (error) {
      return promoError(res, error);
    }
  }
  if (req.method === "POST" && url.pathname === "/api/platform-admin/promos") {
    if (!assertSameOrigin(req)) return json(res, 403, { ok: false, error: "คำขอข้ามต้นทางถูกปฏิเสธ" });
    try {
      const promo = await platformAdminSavePromo(currentUser.id, await readBody(req));
      return json(res, 201, { ok: true, promo });
    } catch (error) {
      return promoError(res, error);
    }
  }
  const promoEditMatch = url.pathname.match(/^\/api\/platform-admin\/promos\/([0-9a-f-]+)$/i);
  if (req.method === "PUT" && promoEditMatch) {
    if (!assertSameOrigin(req)) return json(res, 403, { ok: false, error: "คำขอข้ามต้นทางถูกปฏิเสธ" });
    try {
      const promo = await platformAdminSavePromo(currentUser.id, await readBody(req), promoEditMatch[1]);
      return json(res, 200, { ok: true, promo });
    } catch (error) {
      return promoError(res, error);
    }
  }
  const promoStatusMatch = url.pathname.match(/^\/api\/platform-admin\/promos\/([0-9a-f-]+)\/status$/i);
  if (req.method === "PUT" && promoStatusMatch) {
    if (!assertSameOrigin(req)) return json(res, 403, { ok: false, error: "คำขอข้ามต้นทางถูกปฏิเสธ" });
    try {
      const body = await readBody(req);
      if (typeof body.active !== "boolean") return json(res, 400, { ok: false, error: "สถานะ Promo ไม่ถูกต้อง" });
      const promo = await platformAdminSetPromoActive(currentUser.id, promoStatusMatch[1], body.active);
      return json(res, 200, { ok: true, promo });
    } catch (error) {
      return promoError(res, error);
    }
  }
  if (req.method === "GET" && url.pathname === "/api/platform-admin/settings") {
    return json(res, 200, {
      ok: true,
      settings: {
        timezone: TIME_ZONE,
        currency: "THB",
        language: "th",
        notificationPreferences: { paymentFailed: true, trialExpiring: true, lineDisconnected: true }
      },
      user: currentUser
    });
  }
  return json(res, 404, { ok: false, error: "Platform Admin API not found" });
}

async function handlePlatformAdminRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/platform-admin/") && isModernPlatformAdminApi(url.pathname)) {
    await handlePlatformAdminApi(req, res, url);
    return true;
  }
  if (url.pathname === "/platform-admin/login") {
    servePlatformAdminStatic(req, res);
    return true;
  }
  if (url.pathname === "/platform-admin" || url.pathname === "/platform-admin/" || url.pathname.startsWith("/platform-admin/")) {
    const relative = url.pathname.replace(/^\/platform-admin\/?/, "");
    if (relative && /\.(?:css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(relative)) {
      servePlatformAdminStatic(req, res);
      return true;
    }
    const user = await authorizePlatformAdmin(req);
    if (!user) {
      res.writeHead(302, { Location: "/platform-admin/login", "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    servePlatformAdminStatic(req, res);
    return true;
  }
  return false;
}

module.exports = { handlePlatformAdminRequest };
