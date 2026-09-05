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
const signupStart = appJs.indexOf("function renderSignup()");
const signupEnd = appJs.indexOf("function renderLanding()", signupStart);
const signupBlock = appJs.slice(signupStart, signupEnd);
const starterPlanBlock = landingBlock.slice(
  landingBlock.indexOf("<p>Starter</p>"),
  landingBlock.indexOf("<p>Business</p>")
);
const businessSignupConfig = appJs.slice(
  appJs.indexOf("business: {"),
  appJs.indexOf("enterprise: {")
);
const enterpriseSignupConfig = appJs.slice(
  appJs.indexOf("enterprise: {"),
  appJs.indexOf("function selectedLandingSignupPlan")
);
const landingHeaderBlock = landingBlock.slice(
  landingBlock.indexOf("<header class=\"landing-header\">"),
  landingBlock.indexOf("</header>", landingBlock.indexOf("<header class=\"landing-header\">"))
);
const landingHeroActionsBlock = landingBlock.slice(
  landingBlock.indexOf("<div class=\"landing-hero-actions\">"),
  landingBlock.indexOf("</div>", landingBlock.indexOf("<div class=\"landing-hero-actions\">"))
);
const landingHtmlHeaderBlock = landingHtml.slice(
  landingHtml.indexOf("<header class=\"landing-header\">"),
  landingHtml.indexOf("</header>", landingHtml.indexOf("<header class=\"landing-header\">"))
);
const landingHtmlHeroActionsBlock = landingHtml.slice(
  landingHtml.indexOf("<div class=\"landing-hero-actions\">"),
  landingHtml.indexOf("</div>", landingHtml.indexOf("<div class=\"landing-hero-actions\">"))
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(appJs.includes('"/": "landing"'), "root route must render the public landing view");
assert(appJs.includes('"/dashboard": "dashboard"'), "dashboard route must remain a private app route");
assert(landingStart !== -1 && landingEnd !== -1, "landing renderer missing");
assert(signupStart !== -1 && signupEnd !== -1, "signup renderer missing");
assert(landingBlock.includes('href="${landingSignupPlanUrl("starter")}"') && landingBlock.includes("สมัครใช้งาน Starter"), "Starter landing signup CTA missing plan handoff");
assert(landingHeaderBlock.includes('href="/login"') && landingHeaderBlock.includes("เข้าสู่ระบบ"), "header login link must remain");
assert(landingHeroActionsBlock.includes('href="${landingSignupPlanUrl("starter")}"') && landingHeroActionsBlock.includes("สมัครใช้งาน Starter"), "hero primary signup CTA must remain");
assert(!landingHeroActionsBlock.includes('href="/login"') && !landingHeroActionsBlock.includes("เข้าสู่ระบบ"), "hero secondary login CTA must be removed");
assert(landingBlock.includes('data-landing-plan="starter"') && landingBlock.includes('data-landing-plan="business"') && landingBlock.includes('data-landing-plan="enterprise"'), "pricing CTA plan markers missing");
assert(landingBlock.includes('href="${landingSignupPlanUrl("business")}"') && landingBlock.includes("เลือก Business"), "Business CTA must hand off selected plan");
assert(landingBlock.includes('href="${landingSignupPlanUrl("enterprise")}"') && landingBlock.includes("เลือก Enterprise"), "Enterprise CTA must hand off selected plan");
assert(appJs.includes("updateLandingPlanCtas(pricing)") && appJs.includes("landingSignupPlanUrl(link.dataset.landingPlan, billing)"), "billing toggle must update pricing CTA plan URLs");
assert(landingBlock.includes('href="/login"') && landingBlock.includes("เข้าสู่ระบบ"), "landing login link missing");
assert(!landingBlock.includes('<a href="#features">จุดเด่น</a>'), "public header/footer must not include removed จุดเด่น navigation link");
assert(!landingBlock.includes('<a href="#how-it-works">วิธีใช้งาน</a>'), "public header/footer must not include removed วิธีใช้งาน navigation link");
assert(!landingBlock.includes('<a href="#pricing">ราคา</a>'), "public header/footer must not include removed ราคา navigation link");
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
assert(signupBlock.includes("selectedLandingSignupPlan()") && appJs.includes('name="landingSelectedPlan"') && appJs.includes('name="landingSelectedBilling"'), "signup must preserve selected plan and billing in the UI");
assert(appJs.includes('if (!Object.prototype.hasOwnProperty.call(LANDING_SIGNUP_PLAN_OPTIONS, landingSignupPlan)) return null') && appJs.includes('if (!["monthly", "yearly"].includes(landingSignupBilling)) return null'), "signup plan query values must be allowlisted");
assert(signupBlock.includes("signupPromotionHtml()") && appJs.includes('name="promotionCode"') && appJs.includes("มีโค้ดโปรโมชั่น?"), "signup promotion code area missing");
assert(
  signupBlock.indexOf("ยืนยันรหัสผ่าน") < signupBlock.indexOf("signupPromotionHtml()")
    && signupBlock.indexOf("signupPromotionHtml()") < signupBlock.indexOf("signupRequestId"),
  "signup promotion code area must appear after confirm password and before submit metadata"
);
assert(businessSignupConfig.includes("สมัครแพ็กเกจ Business") && businessSignupConfig.includes("฿990 / เดือน") && businessSignupConfig.includes("฿9,900 / ปี") && businessSignupConfig.includes("สมัครและเลือก Business"), "Business signup handoff copy missing");
assert(!businessSignupConfig.includes("เริ่มใช้ฟรี 30 วัน") && !businessSignupConfig.includes("ทดลองใช้ฟรี 30 วัน"), "Business signup must not use Starter free-trial copy");
assert(enterpriseSignupConfig.includes("สมัครแพ็กเกจ Enterprise") && enterpriseSignupConfig.includes("฿1,990 / เดือน") && enterpriseSignupConfig.includes("฿19,900 / ปี") && enterpriseSignupConfig.includes("สมัครและเลือก Enterprise"), "Enterprise signup handoff copy missing");
assert(!enterpriseSignupConfig.includes("เริ่มใช้ฟรี 30 วัน") && !enterpriseSignupConfig.includes("ทดลองใช้ฟรี 30 วัน"), "Enterprise signup must not use Starter free-trial copy");
assert(!landingBlock.includes("landing-button-light"), "final CTA must not contain the removed white button");
assert(landingBlock.includes("<footer class=\"landing-footer\">") && landingBlock.includes("© 2026 Growup Pilot"), "footer must keep the copyright-only strip");
assert(!landingBlock.includes("เมนูท้ายหน้า") && !landingBlock.includes("จัดการลูกค้า ออเดอร์ โอกาสขาย รายงาน ต้นทุนและกำไรในที่เดียว"), "rendered footer must not include nav columns or repeated brand copy");
assert(appJs.includes('app.view === "landing"') && appJs.includes("Growup Pilot | จัดการธุรกิจให้เติบโต"), "landing route must keep an SEO-specific page title after JS renders");
assert(serverJs.includes('["/", "/login", "/signup"].includes(pathname)'), "server public routing must expose root, login, and signup");
assert(serverJs.includes('"/landing.html"') && serverJs.includes('"/login.html"') && serverJs.includes('"/signup.html"'), "public routes must serve crawlable public HTML shells");
assert(landingHtml.includes("จัดการธุรกิจ ให้เติบโต ไปกับ Growup Pilot"), "root HTML must include crawlable landing H1");
assert(landingHtml.includes('meta name="description"'), "root HTML must include an SEO description");
assert(landingHtml.includes('href="/signup?plan=starter&amp;billing=monthly"'), "root HTML must include Starter CTA plan handoff");
assert(landingHtmlHeaderBlock.includes('href="/login"') && landingHtmlHeaderBlock.includes("เข้าสู่ระบบ"), "root HTML header login link must remain");
assert(landingHtmlHeroActionsBlock.includes('href="/signup?plan=starter&amp;billing=monthly"') && landingHtmlHeroActionsBlock.includes("สมัครใช้งาน Starter"), "root HTML hero primary CTA must remain");
assert(!landingHtmlHeroActionsBlock.includes('href="/login"') && !landingHtmlHeroActionsBlock.includes("เข้าสู่ระบบ"), "root HTML hero secondary login CTA must be removed");
assert(landingHtml.includes('href="/signup?plan=business&amp;billing=monthly"'), "root HTML must include Business CTA plan handoff");
assert(landingHtml.includes('href="/signup?plan=enterprise&amp;billing=monthly"'), "root HTML must include Enterprise CTA plan handoff");
assert(!landingHtml.includes('<a href="#features">จุดเด่น</a>') && !landingHtml.includes('<a href="#how-it-works">วิธีใช้งาน</a>') && !landingHtml.includes('<a href="#pricing">ราคา</a>'), "root HTML must not expose removed header/footer nav links");
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
assert(signupHtml.includes("มีโค้ดโปรโมชั่น?") && signupHtml.includes('name="promotionCode"') && signupHtml.includes("กรอกโค้ดโปรโมชั่น"), "signup HTML shell must contain optional promotion code area");
assert(
  signupHtml.indexOf("ยืนยันรหัสผ่าน") < signupHtml.indexOf("มีโค้ดโปรโมชั่น?")
    && signupHtml.indexOf("มีโค้ดโปรโมชั่น?") < signupHtml.indexOf("signup_shell_initial"),
  "signup HTML promotion code area must appear after confirm password and before submit metadata"
);
assert(!signupHtml.includes("เริ่มใช้ฟรี 30 วัน") && !signupHtml.includes("ทดลองใช้ฟรี 30 วัน"), "raw generic signup shell must not imply Starter trial before plan validation");
assert(!loginHtml.includes("orderDialog") && !loginHtml.includes("productDialog") && !loginHtml.includes("เพิ่มออเดอร์"), "login HTML shell must not contain private app shell");
assert(!signupHtml.includes("orderDialog") && !signupHtml.includes("productDialog") && !signupHtml.includes("เพิ่มออเดอร์"), "signup HTML shell must not contain private app shell");
assert(css.includes("body.landing-view") && css.includes(".landing-page"), "landing CSS must be scoped");
assert(css.includes("body.landing-view .landing-button-primary") && css.includes("color: #ffffff !important"), "public CTA text color must be locked to white");
assert(css.includes("body.landing-view .landing-nav") && css.includes("display: none !important"), "removed public header nav must stay hidden if stale markup appears");
assert(landingHtml.includes("<footer class=\"landing-footer\">\n              <small>© 2026 Growup Pilot</small>\n            </footer>"), "landing footer must be a minimal copyright-only strip");
assert(!landingHtml.includes("เมนูท้ายหน้า") && !landingHtml.includes("จัดการลูกค้า ออเดอร์ โอกาสขาย รายงาน ต้นทุนและกำไรในที่เดียว"), "landing footer must not include nav columns or repeated brand copy");
assert(css.includes("body.landing-view .landing-footer") && css.includes("min-height: 60px") && css.includes("justify-content: center"), "landing footer must stay compact and centered");

console.log("Landing page route/content checks passed.");
