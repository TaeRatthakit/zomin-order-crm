"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverJs = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const landingHtml = fs.readFileSync(path.join(ROOT, "public", "landing.html"), "utf8");
const loginHtml = fs.readFileSync(path.join(ROOT, "public", "login.html"), "utf8");
const signupHtml = fs.readFileSync(path.join(ROOT, "public", "signup.html"), "utf8");
const landingStart = appJs.indexOf("function renderLanding()");
const landingEnd = appJs.indexOf("function customerRow", landingStart);
const landingBlock = appJs.slice(landingStart, landingEnd);
const starterPlanBlock = landingBlock.slice(
  landingBlock.indexOf("<p>Starter</p>"),
  landingBlock.indexOf("<p>Business</p>")
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(appJs.includes('"/": "landing"'), "root route must render the public landing view");
assert(appJs.includes('"/dashboard": "dashboard"'), "dashboard route must remain a private app route");
assert(landingStart !== -1 && landingEnd !== -1, "landing renderer missing");
assert(landingBlock.includes('href="/signup"') && landingBlock.includes("เริ่มใช้ฟรี 30 วัน"), "landing signup CTA missing");
assert(landingBlock.includes('href="/login"') && landingBlock.includes("เข้าสู่ระบบ"), "landing login link missing");
assert(landingBlock.includes("฿490") && landingBlock.includes("฿990") && landingBlock.includes("฿1,990"), "monthly pricing must include Starter, Business, and Enterprise");
assert(landingBlock.includes("฿4,900") && landingBlock.includes("฿9,900") && landingBlock.includes("฿19,900"), "annual pricing must include Starter, Business, and Enterprise");
assert(landingBlock.includes("฿5,880") && landingBlock.includes("฿11,880") && landingBlock.includes("฿23,880"), "annual comparison prices must be mathematically correct");
assert(landingBlock.includes("ผู้ใช้งานสูงสุด 3 คน") && landingBlock.includes("ผู้ใช้งานสูงสุด 10 คน") && landingBlock.includes("ผู้ใช้งานไม่จำกัด"), "pricing must include approved user limits");
assert(landingBlock.includes("บริการช่วยตั้งค่าระบบโดยทีมงาน") && landingBlock.includes("บริการช่วยนำเข้าข้อมูลเดิมโดยทีมงาน"), "Enterprise team-assisted service labels missing");
assert(landingBlock.includes("data-landing-billing") && landingBlock.includes("data-billing=\"monthly\""), "billing toggle must default to monthly");
assert(landingBlock.includes("hidden aria-hidden=\"true\"") && landingBlock.includes("landing-price-value"), "pricing must use semantic hidden price options");
assert(appJs.includes("element.hidden = !isVisible") && appJs.includes("element.setAttribute(\"aria-hidden\""), "pricing toggle must update hidden and aria-hidden state");
assert(landingBlock.includes("ต้นทุนและกำไร"), "pricing must include cost/profit");
assert(landingBlock.includes("ช่วยให้เห็นยอดขาย ต้นทุน และกำไรชัดขึ้น และบริหารธุรกิจได้ง่ายขึ้น"), "landing must use safer business visibility copy");
assert(starterPlanBlock.includes("ผู้ใช้งานสูงสุด 3 คน") && !starterPlanBlock.includes("ผู้ใช้งานสูงสุด 10 คน"), "Starter plan must use only the approved 3-user limit");
assert(!/broadcast| ai |ปัญญาประดิษฐ์/i.test(landingBlock), "landing must not market AI or Broadcast features");
assert(appJs.includes('app.view === "landing"') && appJs.includes("Growup Pilot | จัดการธุรกิจให้เติบโต"), "landing route must keep an SEO-specific page title after JS renders");
assert(serverJs.includes('["/", "/login", "/signup"].includes(pathname)'), "server public routing must expose root, login, and signup");
assert(serverJs.includes('"/landing.html"') && serverJs.includes('"/login.html"') && serverJs.includes('"/signup.html"'), "public routes must serve crawlable public HTML shells");
assert(landingHtml.includes("จัดการธุรกิจ ให้เติบโต ไปกับ Growup Pilot"), "root HTML must include crawlable landing H1");
assert(landingHtml.includes('meta name="description"'), "root HTML must include an SEO description");
assert(landingHtml.includes("ช่วยให้เห็นยอดขาย ต้นทุน และกำไรชัดขึ้น และบริหารธุรกิจได้ง่ายขึ้น"), "root HTML must use safer business visibility copy");
assert(landingHtml.includes("฿490") && landingHtml.includes("฿990") && landingHtml.includes("฿1,990"), "root HTML must include all monthly plans");
assert(landingHtml.includes("฿4,900") && landingHtml.includes("฿9,900") && landingHtml.includes("฿19,900"), "root HTML must include all annual plans");
assert(landingHtml.includes("landing-price-value") && landingHtml.includes("hidden aria-hidden=\"true\""), "root pricing HTML must expose active/inactive prices semantically");
assert(landingHtml.includes("ผู้ใช้งานสูงสุด 3 คน") && landingHtml.includes("ผู้ใช้งานสูงสุด 10 คน") && landingHtml.includes("ผู้ใช้งานไม่จำกัด"), "root HTML must include approved user limits");
assert(landingHtml.includes("บริการช่วยตั้งค่าระบบโดยทีมงาน") && landingHtml.includes("บริการช่วยนำเข้าข้อมูลเดิมโดยทีมงาน"), "root HTML must include Enterprise team-assisted services");
assert(!landingHtml.includes("เพิ่มออเดอร์") && !landingHtml.includes("แก้ไขโปรไฟล์"), "root HTML must not include private app modal copy");
assert(!landingHtml.includes("orderDialog") && !landingHtml.includes("productDialog"), "root HTML must not include private app modal shells");
assert(loginHtml.includes('id="loginForm"') && loginHtml.includes("เข้าสู่ระบบ"), "login HTML shell must contain login content");
assert(signupHtml.includes('id="signupForm"') && signupHtml.includes("สมัครใช้งาน"), "signup HTML shell must contain signup content");
assert(!loginHtml.includes("orderDialog") && !loginHtml.includes("productDialog") && !loginHtml.includes("เพิ่มออเดอร์"), "login HTML shell must not contain private app shell");
assert(!signupHtml.includes("orderDialog") && !signupHtml.includes("productDialog") && !signupHtml.includes("เพิ่มออเดอร์"), "signup HTML shell must not contain private app shell");
assert(css.includes("body.landing-view") && css.includes(".landing-page"), "landing CSS must be scoped");

console.log("Landing page route/content checks passed.");
