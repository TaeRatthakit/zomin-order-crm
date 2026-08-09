"use strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_PROVIDER = "json";
process.env.SESSION_SECRET = "public-auth-shell-test-secret";

const { Readable } = require("stream");
const appHandler = require("../server");
const { createSession, sessionCookie } = require("../lib/auth");

function fail(message) {
  throw new Error(message);
}

function makeRequest(path, options = {}) {
  const body = options.body || "";
  const req = new Readable({ read() {} });
  req.url = path;
  req.method = options.method || "GET";
  req.headers = {
    host: "localhost",
    ...(options.headers || {})
  };
  if (body) req.headers["content-length"] = Buffer.byteLength(body);
  req.push(body || null);
  req.push(null);
  return req;
}

function makeResponse(resolve) {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolve({
        status: this.statusCode,
        headers: this.headers,
        text: Buffer.concat(chunks).toString("utf8")
      });
    }
  };
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, options);
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) fail(`${label} missing ${expected}`);
}

function assertCleanPublicHtml(html, label) {
  const forbidden = [
    "Dashboard",
    "เพิ่มออเดอร์",
    "orderDialog",
    "customerDialog",
    "productDialog",
    "deleteOrderDialog",
    "แก้ไขโปรไฟล์",
    "ข้อมูลสินค้า ลูกค้า การจัดส่ง และยอดซื้อ"
  ];
  for (const item of forbidden) {
    if (html.includes(item)) fail(`${label} exposed private shell marker: ${item}`);
  }
}

function stripHiddenElements(html) {
  return html
    .replace(/<([a-z0-9-]+)\b(?=[^>]*\shidden\b)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

(async () => {
  const root = await request("/");
  if (root.status !== 200) fail(`raw / returned ${root.status}`);
  assertIncludes(root.text, "จัดการธุรกิจ ให้เติบโต ไปกับ Growup Pilot", "raw /");
  assertIncludes(root.text, "เลือกแพ็กเกจที่ใช่ สำหรับธุรกิจของคุณ", "raw /");
  assertCleanPublicHtml(root.text, "raw /");

  const login = await request("/login");
  if (login.status !== 200) fail(`raw /login returned ${login.status}`);
  assertIncludes(login.text, "<title>เข้าสู่ระบบ | Growup Pilot</title>", "raw /login");
  assertIncludes(login.text, 'id="loginForm"', "raw /login");
  assertIncludes(login.text, "ชื่อผู้ใช้งาน", "raw /login");
  assertCleanPublicHtml(login.text, "raw /login");

  const signup = await request("/signup");
  if (signup.status !== 200) fail(`raw /signup returned ${signup.status}`);
  assertIncludes(signup.text, "<title>สมัครใช้งาน | Growup Pilot</title>", "raw /signup");
  assertIncludes(signup.text, 'id="signupForm"', "raw /signup");
  assertIncludes(signup.text, "ชื่อธุรกิจ", "raw /signup");
  assertCleanPublicHtml(signup.text, "raw /signup");
  if (/(name="(?:card|credit|payment)"|บัตรเครดิต|checkout|payment method|subscription)/i.test(signup.text)) {
    fail("signup raw HTML unexpectedly asks for payment or credit card details");
  }

  const prices = ["฿490", "฿4,900", "฿990", "฿9,900", "฿1,990", "฿19,900"];
  for (const price of prices) assertIncludes(root.text, price, "raw pricing");
  for (const label of ["ผู้ใช้งานสูงสุด 3 คน", "ผู้ใช้งานสูงสุด 10 คน", "ผู้ใช้งานไม่จำกัด"]) {
    assertIncludes(root.text, label, "raw pricing");
  }
  assertIncludes(root.text, "บริการช่วยตั้งค่าระบบโดยทีมงาน", "raw pricing");
  assertIncludes(root.text, "บริการช่วยนำเข้าข้อมูลเดิมโดยทีมงาน", "raw pricing");
  if (/broadcast| ai |ปัญญาประดิษฐ์/i.test(root.text)) fail("landing raw HTML contains AI or Broadcast copy");

  const accessibleMonthly = stripHiddenElements(root.text);
  if (/฿490\s*฿4,900|฿990\s*฿9,900|฿1,990\s*฿19,900|\/ เดือน\s*\/ ปี/.test(accessibleMonthly)) {
    fail("monthly accessible pricing text is malformed or concatenated");
  }
  for (const text of ["฿490 / เดือน", "฿990 / เดือน", "฿1,990 / เดือน"]) {
    if (!accessibleMonthly.includes(text)) fail(`monthly accessible pricing missing ${text}`);
  }

  const dashboardGuest = await request("/dashboard");
  if (dashboardGuest.status !== 302) fail(`guest /dashboard returned ${dashboardGuest.status}`);

  const session = createSession({ id: "public-auth-shell-private-route", username: "private-route@example.com", name: "Private Route", role: "Owner" });
  const cookie = sessionCookie(session.token, session.expiresAt);
  const dashboardAuthed = await request("/dashboard", { headers: { cookie } });
  if (dashboardAuthed.status !== 200) fail(`authenticated /dashboard returned ${dashboardAuthed.status}`);
  assertIncludes(dashboardAuthed.text, "orderDialog", "authenticated private shell");
  assertIncludes(dashboardAuthed.text, "productDialog", "authenticated private shell");

  console.log("Public auth shell and pricing accessibility checks passed.");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
