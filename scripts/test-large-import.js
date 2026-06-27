const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zomin-import-test-"));
const tempDb = path.join(tempDir, "db.json");
fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), tempDb);

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.JSON_DB_PATH = tempDb;
process.env.SESSION_SECRET = "large-import-test-secret";

const appHandler = require("../server");

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const req = Readable.from(body ? [body] : []);
    req.method = options.method || "GET";
    req.url = url;
    req.headers = { host: "127.0.0.1", ...(options.headers || {}) };
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
        if (chunk) chunks.push(Buffer.from(String(chunk)));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(String(chunk)));
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text: Buffer.concat(chunks).toString("utf8")
        });
      }
    };
    Promise.resolve(appHandler(req, res)).catch(reject);
  });
}

function cookieFrom(response) {
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === "set-cookie");
  return entry?.[1] || "";
}

async function runJob(cookie, rows, fingerprint) {
  const start = await request("/api/import-jobs", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      type: "orders",
      total: rows.length,
      fileName: "orders-10000.csv",
      fileSize: 1_500_000,
      fingerprint,
      batchSize: 300
    })
  });
  if (start.status !== 201) throw new Error(`start failed: ${start.status} ${start.text}`);
  let job = JSON.parse(start.text).job;
  for (let offset = 0; offset < rows.length; offset += 300) {
    const batch = await request(`/api/import-jobs/${job.id}/batches`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ offset, rows: rows.slice(offset, offset + 300) })
    });
    if (batch.status !== 200) throw new Error(`batch failed at ${offset}: ${batch.status} ${batch.text}`);
    job = JSON.parse(batch.text).job;
  }
  return job;
}

async function main() {
  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.text}`);
  const cookie = cookieFrom(login);
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    rowNumber: index + 2,
    orderNumber: `LOAD-${String(index + 1).padStart(6, "0")}`,
    name: `Load Test ${index % 100}`,
    phone: `089${String(index % 100).padStart(7, "0")}`,
    address: "Import load test",
    date: "2026-06-28",
    jars: 1,
    amount: 750,
    sourceChannel: "Import Test"
  }));

  const first = await runJob(cookie, rows, "load-test-first");
  if (first.status !== "completed" || first.imported !== 10_000 || first.failed !== 0) {
    throw new Error(`unexpected first import summary: ${JSON.stringify(first)}`);
  }
  const second = await runJob(cookie, rows, "load-test-second");
  if (second.status !== "completed" || second.imported !== 0 || second.skipped !== 10_000 || second.failed !== 0) {
    throw new Error(`duplicate protection failed: ${JSON.stringify(second)}`);
  }
  console.log(`Large import test passed: ${first.imported} imported, ${second.skipped} duplicates skipped.`);
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
