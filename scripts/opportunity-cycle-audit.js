#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadEnvFile(path.join(__dirname, "..", ".env.local"));
loadEnvFile(path.join(process.cwd(), ".env.local"));
process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.DATABASE_PROVIDER = process.env.DATABASE_PROVIDER || "supabase";

const { readDb } = require("../lib/db");
const { toDateOnly } = require("../lib/customer-sync");

const CHAT_RESULT = "แชทหาลูกค้าแล้ว";
const CRM_RESULT = "CRMเรียบร้อยแล้ว";
const CYCLE_NOTE_RE = /\n?\[\[opportunityCycle:orderId=([^\]]+)\]\]/g;

function bangkokDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function diffDays(fromDateOnly, toDateOnlyValue) {
  if (!fromDateOnly || !toDateOnlyValue) return 0;
  const from = new Date(`${fromDateOnly}T00:00:00`);
  const to = new Date(`${toDateOnlyValue}T00:00:00`);
  return Math.floor((to - from) / 86_400_000);
}

function sortedOrders(customer = {}, db = {}) {
  const orders = Array.isArray(customer.orders) && customer.orders.length
    ? customer.orders
    : (db.orders || []).filter(order => order.customerId === customer.id);
  return [...orders].sort((a, b) => [
    String(a.date || ""),
    String(a.time || ""),
    String(a.id || "")
  ].join("|").localeCompare([
    String(b.date || ""),
    String(b.time || ""),
    String(b.id || "")
  ].join("|")));
}

function latestOrder(customer, db) {
  const orders = sortedOrders(customer, db);
  return orders[orders.length - 1] || null;
}

function markerOrderId(note = "") {
  CYCLE_NOTE_RE.lastIndex = 0;
  const match = CYCLE_NOTE_RE.exec(String(note || ""));
  CYCLE_NOTE_RE.lastIndex = 0;
  return match ? decodeURIComponent(match[1]) : "";
}

function stripMarker(note = "") {
  return String(note || "").replace(CYCLE_NOTE_RE, "").trim();
}

function cycleMarker(orderId = "") {
  return `[[opportunityCycle:orderId=${encodeURIComponent(String(orderId || "").trim())}]]`;
}

function noteWithMarker(note = "", orderId = "") {
  return [stripMarker(note), cycleMarker(orderId)].filter(Boolean).join("\n");
}

function supabaseRestBase() {
  const url = new URL(process.env.SUPABASE_URL);
  return `${url.origin}/rest/v1`;
}

async function patchContactLog(logId, patch) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${supabaseRestBase()}/contact_logs?id=eq.${encodeURIComponent(logId)}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`PATCH contact_logs ${logId} failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteContactLog(logId) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${supabaseRestBase()}/contact_logs?id=eq.${encodeURIComponent(logId)}`, {
    method: "DELETE",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "return=minimal"
    }
  });
  if (!res.ok) throw new Error(`DELETE contact_logs ${logId} failed ${res.status}: ${await res.text()}`);
}

function inferOrderForLog(customer, log, db) {
  const direct = String(log.orderId || log.order_id || markerOrderId(log.note) || "").trim();
  const orders = sortedOrders(customer, db);
  if (direct) {
    const order = orders.find(item => item.id === direct);
    return order
      ? { status: "mapped", order, reason: "existing-cycle-key" }
      : { status: "ambiguous", order: null, reason: "cycle-key-not-found" };
  }
  if (orders.length === 1) return { status: "mapped", order: orders[0], reason: "single-order" };
  const logDate = toDateOnly(log.date || log.contact_date || "");
  const previousOrders = orders.filter(order => String(order.date || "") <= logDate);
  if (previousOrders.length === 1) return { status: "mapped", order: previousOrders[0], reason: "only-prior-order" };
  if (previousOrders.length > 1) {
    const order = previousOrders[previousOrders.length - 1];
    const nextOrder = orders[orders.indexOf(order) + 1] || null;
    if (!nextOrder || logDate < String(nextOrder.date || "")) return { status: "mapped", order, reason: "latest-prior-order" };
  }
  return { status: "ambiguous", order: null, reason: "no-unambiguous-order" };
}

function tabForCustomer(customer, selectedDate, crmComplete) {
  if (crmComplete) return "CRMเรียบร้อยแล้ว";
  const days = diffDays(customer.followUpDate, selectedDate);
  if (days === 0) return "ควรโทรวันนี้";
  if (days < 0) return "เลยกำหนดแล้ว";
  if (customer.vipLevel && customer.vipLevel !== "NORMAL") return "ลูกค้า VIP";
  return "not-visible";
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const selectedDateArg = [...args].find(arg => arg.startsWith("--date="));
  const selectedDate = selectedDateArg ? selectedDateArg.split("=").slice(1).join("=") : bangkokDate();
  const db = await readDb();
  const relevantLogs = (db.contactLogs || []).filter(log => [CHAT_RESULT, CRM_RESULT].includes(log.result));
  const logsByCustomer = new Map();
  for (const log of db.contactLogs || []) {
    if (!logsByCustomer.has(log.customerId)) logsByCustomer.set(log.customerId, []);
    logsByCustomer.get(log.customerId).push(log);
  }

  const rows = (db.customers || [])
    .filter(customer => customer.followUpDate)
    .map(customer => {
      const order = latestOrder(customer, db);
      const cycleKey = order?.id || "";
      const logs = logsByCustomer.get(customer.id) || [];
      const crmForLatest = logs.some(log => log.result === CRM_RESULT && inferOrderForLog(customer, log, db).order?.id === cycleKey);
      const currentCrm = logs.some(log => log.result === CRM_RESULT && log.date === selectedDate);
      return {
        customerId: customer.id,
        customerName: customer.name,
        orderId: cycleKey,
        orderDate: order?.date || "",
        followUpDate: customer.followUpDate,
        currentTab: tabForCustomer(customer, selectedDate, currentCrm),
        expectedTab: tabForCustomer(customer, selectedDate, crmForLatest)
      };
    });

  const logRows = relevantLogs.map(log => {
    const customer = (db.customers || []).find(item => item.id === log.customerId);
    const mapping = customer ? inferOrderForLog(customer, log, db) : { status: "ambiguous", order: null, reason: "missing-customer" };
    return {
      customerId: log.customerId,
      customerName: customer?.name || "",
      orderId: mapping.order?.id || "",
      cycleKey: mapping.order?.id || "",
      orderDate: mapping.order?.date || "",
      followUpDate: customer?.followUpDate || "",
      logId: log.id,
      result: log.result,
      createdAt: log.createdAt || "",
      contactDate: log.date || "",
      mappingStatus: mapping.status,
      mappingReason: mapping.reason,
      hasCycleKey: Boolean(log.orderId || markerOrderId(log.note))
    };
  });

  const mappedGroups = new Map();
  for (const row of logRows.filter(item => item.mappingStatus === "mapped")) {
    const key = `${row.customerId}:${row.orderId}:${row.result}`;
    if (!mappedGroups.has(key)) mappedGroups.set(key, []);
    mappedGroups.get(key).push(row);
  }
  const duplicateRows = [];
  const keeperIds = new Set();
  for (const rowsForGroup of mappedGroups.values()) {
    rowsForGroup.sort((a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      || String(a.logId || "").localeCompare(String(b.logId || ""))
    );
    if (rowsForGroup[0]) keeperIds.add(rowsForGroup[0].logId);
    duplicateRows.push(...rowsForGroup.slice(1));
  }
  const duplicateIds = new Set(duplicateRows.map(row => row.logId));
  const affected = logRows.filter(row => row.mappingStatus === "mapped" && !row.hasCycleKey && !duplicateIds.has(row.logId));
  const ambiguous = logRows.filter(row => row.mappingStatus !== "mapped");
  const report = {
    selectedDate,
    summary: {
      opportunityCustomers: rows.length,
      relevantLogs: logRows.length,
      mappedLegacyLogsNeedingCycleKey: affected.length,
      duplicateStatusLogsToRemove: duplicateRows.length,
      ambiguousLogs: ambiguous.length,
      currentCounts: rows.reduce((acc, row) => ({ ...acc, [row.currentTab]: (acc[row.currentTab] || 0) + 1 }), {}),
      expectedCounts: rows.reduce((acc, row) => ({ ...acc, [row.expectedTab]: (acc[row.expectedTab] || 0) + 1 }), {})
    },
    opportunities: rows,
    relevantLogs: logRows,
    affectedLogIds: affected.map(row => row.logId),
    duplicateLogIds: duplicateRows.map(row => row.logId),
    keeperLogIds: [...keeperIds],
    ambiguousLogIds: ambiguous.map(row => row.logId)
  };

  if (args.has("--backup")) {
    const backupDir = path.join(process.cwd(), "tmp");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `opportunity-cycle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const backupIds = new Set([...affected.map(row => row.logId), ...duplicateRows.map(row => row.logId)]);
    const backupLogs = (db.contactLogs || []).filter(log => backupIds.has(log.id));
    fs.writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), selectedDate, logs: backupLogs }, null, 2)}\n`, "utf8");
    report.backupPath = backupPath;
  }

  if (args.has("--apply")) {
    if (ambiguous.length) {
      report.apply = {
        ok: false,
        reason: "ambiguous-legacy-logs-present",
        ambiguousLogIds: ambiguous.map(row => row.logId)
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(2);
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --apply");
    }
    const backupDir = path.join(process.cwd(), "tmp");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = report.backupPath || path.join(backupDir, `opportunity-cycle-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const backupIds = new Set([...affected.map(row => row.logId), ...duplicateRows.map(row => row.logId)]);
    const affectedLogs = (db.contactLogs || []).filter(log => backupIds.has(log.id));
    if (!report.backupPath) {
      fs.writeFileSync(backupPath, `${JSON.stringify({ createdAt: new Date().toISOString(), selectedDate, logs: affectedLogs }, null, 2)}\n`, "utf8");
    }
    const affectedById = new Map(affected.map(row => [row.logId, row]));
    const updated = [];
    for (const log of affectedLogs.filter(item => affectedById.has(item.id))) {
      const row = affectedById.get(log.id);
      const note = noteWithMarker(log.note || "", row.orderId);
      await patchContactLog(log.id, { note });
      updated.push({ logId: log.id, orderId: row.orderId, result: log.result });
    }
    const deletedDuplicates = [];
    for (const row of duplicateRows) {
      await deleteContactLog(row.logId);
      deletedDuplicates.push({ logId: row.logId, orderId: row.orderId, result: row.result });
    }
    report.apply = {
      ok: true,
      backupPath,
      updated,
      deletedDuplicates
    };
  }

  if (args.has("--summary-only")) {
    console.log(JSON.stringify({
      selectedDate: report.selectedDate,
      summary: report.summary,
      affectedLogIds: report.affectedLogIds,
      duplicateLogIds: report.duplicateLogIds,
      keeperLogIds: report.keeperLogIds,
      ambiguousLogIds: report.ambiguousLogIds,
      backupPath: report.backupPath,
      apply: report.apply
    }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
