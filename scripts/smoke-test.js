const { Readable } = require("stream");
const appHandler = require("../server");

function makeRequest(path, options = {}) {
  const body = options.body || "";
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || "GET";
  req.url = path;
  req.headers = {
    host: "127.0.0.1",
    ...(options.headers || {})
  };
  return req;
}

function makeResponse(resolve) {
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
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
  return res;
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = makeRequest(path, options);
    const res = makeResponse(resolve);
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] || "";
}

function fail(message) {
  throw new Error(`Smoke test failed: ${message}`);
}

async function main() {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_PROVIDER = "json";
  process.env.JSON_DB_PATH = "./data/db.json";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "zomin-smoke-test-secret";

  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) fail(`admin login returned ${login.status}: ${login.text}`);
  const cookie = header(login.headers, "set-cookie");
  if (!cookie || !cookie.includes("HttpOnly")) fail("admin login did not set an HttpOnly session cookie");

  const adminState = await request("/api/state", { headers: { cookie } });
  if (adminState.status !== 200) fail(`admin state returned ${adminState.status}: ${adminState.text}`);
  const parsedAdminState = JSON.parse(adminState.text);
  if (!parsedAdminState.currentUser || parsedAdminState.currentUser.role !== "Admin") {
    fail("state did not return Admin session");
  }

  const staffLogin = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "staff", password: "staff123" })
  });
  if (staffLogin.status !== 200) fail(`staff login returned ${staffLogin.status}: ${staffLogin.text}`);
  const staffCookie = header(staffLogin.headers, "set-cookie");
  const staffTeam = await request("/api/state", { headers: { cookie: staffCookie } });
  if (staffTeam.status !== 200) fail(`staff state returned ${staffTeam.status}: ${staffTeam.text}`);
  const parsedStaffState = JSON.parse(staffTeam.text);
  if (!parsedStaffState.currentUser || parsedStaffState.currentUser.role !== "Staff") {
    fail("state did not return Staff session");
  }

  const customersCsv = await request("/api/export/customers", { headers: { cookie } });
  if (customersCsv.status !== 200) fail(`customers export returned ${customersCsv.status}`);
  if (!customersCsv.text.includes("vipLevel")) fail("customers CSV header is missing expected columns");

  const ordersCsv = await request("/api/export/orders", { headers: { cookie } });
  if (ordersCsv.status !== 200) fail(`orders export returned ${ordersCsv.status}`);
  if (!ordersCsv.text.includes("customerName")) fail("orders CSV header is missing expected columns");

  const backup = await request("/api/backup", { headers: { cookie } });
  if (backup.status !== 200) fail(`backup returned ${backup.status}`);
  const parsedBackup = JSON.parse(backup.text);
  if (!parsedBackup.data || !Array.isArray(parsedBackup.data.users)) fail("backup JSON is missing data.users");

  const webhookHealth = await request("/api/line/webhook");
  if (webhookHealth.status !== 200) fail(`LINE webhook health returned ${webhookHealth.status}`);

  console.log("Smoke test passed.");
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
