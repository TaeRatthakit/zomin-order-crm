#!/usr/bin/env node
"use strict";

const { Readable } = require("stream");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "development";
process.env.DATABASE_PROVIDER = "json";
process.env.JSON_DB_PATH = path.join(os.tmpdir(), `zomin-opportunity-cycle-${process.pid}.json`);
fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), process.env.JSON_DB_PATH);

const appHandler = require("../server");

function makeRequest(pathname, options = {}) {
  const body = options.body || "";
  const req = Readable.from(body ? [body] : []);
  req.method = options.method || "GET";
  req.url = pathname;
  req.headers = { host: "127.0.0.1", ...(options.headers || {}) };
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
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolve({ status: this.statusCode, headers: this.headers, text: Buffer.concat(chunks).toString("utf8") });
    }
  };
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    Promise.resolve(appHandler(makeRequest(pathname, options), makeResponse(resolve))).catch(reject);
  });
}

function header(headers, name) {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] || "";
}

function fail(message) {
  throw new Error(`Opportunity cycle test failed: ${message}`);
}

function readTempDb() {
  return JSON.parse(fs.readFileSync(process.env.JSON_DB_PATH, "utf8"));
}

function writeTempDb(db) {
  fs.writeFileSync(process.env.JSON_DB_PATH, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function postLog(cookie, body) {
  const response = await request("/api/contact-log", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status !== 200) fail(`contact log returned ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

async function main() {
  const login = await request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (login.status !== 200) fail(`login returned ${login.status}`);
  const cookie = header(login.headers, "set-cookie");
  const stateResponse = await request("/api/state", { headers: { cookie } });
  if (stateResponse.status !== 200) fail(`state returned ${stateResponse.status}`);
  const state = JSON.parse(stateResponse.text);
  const customer = state.customers.find(item => Array.isArray(item.orders) && item.orders.length);
  if (!customer) fail("no customer with orders in fixture");
  const latestOrder = customer.orders[customer.orders.length - 1];
  const today = state.summary.selectedDate;
  const laterDate = "2099-01-02";

  const chat = await postLog(cookie, {
    customerId: customer.id,
    orderId: latestOrder.id,
    date: today,
    result: "แชทหาลูกค้าแล้ว",
    note: "Opportunity chat completed",
    staff: "cycle-test"
  });
  if (!chat.log?.id || chat.log.orderId !== latestOrder.id) fail("chat log did not persist latest order cycle");
  if (!String(chat.log.note || "").includes(`orderId=${encodeURIComponent(latestOrder.id)}`)) fail("chat note did not include cycle marker");

  const duplicateChat = await postLog(cookie, {
    customerId: customer.id,
    orderId: latestOrder.id,
    date: laterDate,
    result: "แชทหาลูกค้าแล้ว",
    note: "Opportunity chat completed",
    staff: "cycle-test"
  });
  if (!duplicateChat.duplicate || duplicateChat.log.id !== chat.log.id) {
    fail("chat duplicate was not scoped to customer + order cycle + result across dates");
  }

  const followUp = await postLog(cookie, {
    customerId: customer.id,
    date: laterDate,
    result: "โทรติด",
    note: "normal follow-up",
    staff: "cycle-test"
  });
  if (followUp.log.result === "CRMเรียบร้อยแล้ว") fail("normal follow-up completed CRM");

  const crm = await postLog(cookie, {
    customerId: customer.id,
    orderId: latestOrder.id,
    date: today,
    result: "CRMเรียบร้อยแล้ว",
    note: "manual CRM",
    staff: "cycle-test"
  });
  if (crm.log.orderId !== latestOrder.id) fail("CRM log did not persist latest order cycle");

  const db = readTempDb();
  const newOrder = {
    ...latestOrder,
    id: `o_cycle_${crypto.randomBytes(4).toString("hex")}`,
    orderNumber: `CYCLE-${crypto.randomBytes(3).toString("hex")}`,
    date: "2099-02-01",
    amount: Number(latestOrder.amount || 100) + 1,
    rawText: "",
    createdAt: new Date().toISOString()
  };
  db.orders.push(newOrder);
  writeTempDb(db);

  const freshCycleChat = await postLog(cookie, {
    customerId: customer.id,
    orderId: newOrder.id,
    date: "2099-02-02",
    result: "แชทหาลูกค้าแล้ว",
    note: "Opportunity chat completed",
    staff: "cycle-test"
  });
  if (freshCycleChat.duplicate || freshCycleChat.log.id === chat.log.id || freshCycleChat.log.orderId !== newOrder.id) {
    fail("new order did not start a fresh chat cycle");
  }

  const sameOrderCrmAgain = await postLog(cookie, {
    customerId: customer.id,
    orderId: latestOrder.id,
    date: "2099-03-01",
    result: "CRMเรียบร้อยแล้ว",
    note: "manual CRM duplicate",
    staff: "cycle-test"
  });
  if (!sameOrderCrmAgain.duplicate || sameOrderCrmAgain.log.id !== crm.log.id) {
    fail("CRM duplicate was not scoped to the same order cycle");
  }

  console.log("Opportunity cycle test passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
