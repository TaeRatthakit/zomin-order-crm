"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverJs = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const landingStart = appJs.indexOf("function renderLanding()");
const landingEnd = appJs.indexOf("function customerRow", landingStart);
const landingBlock = appJs.slice(landingStart, landingEnd);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(appJs.includes('"/": "landing"'), "root route must render the public landing view");
assert(appJs.includes('"/dashboard": "dashboard"'), "dashboard route must remain a private app route");
assert(landingStart !== -1 && landingEnd !== -1, "landing renderer missing");
assert(landingBlock.includes('href="/signup"') && landingBlock.includes("เริ่มใช้ฟรี 30 วัน"), "landing signup CTA missing");
assert(landingBlock.includes('href="/login"') && landingBlock.includes("เข้าสู่ระบบ"), "landing login link missing");
assert(landingBlock.includes("฿490") && landingBlock.includes("ต้นทุนและกำไร"), "pricing must include 490 baht plan with cost/profit");
assert(!/broadcast| ai |ปัญญาประดิษฐ์/i.test(landingBlock), "landing must not market AI or Broadcast features");
assert(serverJs.includes('["/", "/login", "/signup"].includes(pathname)'), "server public routing must expose root, login, and signup");
assert(css.includes("body.landing-view") && css.includes(".landing-page"), "landing CSS must be scoped");

console.log("Landing page route/content checks passed.");
