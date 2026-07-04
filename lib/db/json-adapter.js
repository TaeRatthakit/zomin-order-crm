const fs = require("fs");
const path = require("path");
const { synchronizeCustomers } = require("../customer-sync");

const ROOT = path.join(__dirname, "..", "..");
const DATA_FILE = process.env.JSON_DB_PATH || path.join(ROOT, "data", "db.json");

function readDb() {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const before = JSON.stringify({
    customers: db.customers || [],
    orders: db.orders || [],
    contactLogs: db.contactLogs || [],
    tags: db.tags || []
  });
  const synced = synchronizeCustomers(db);
  const after = JSON.stringify({
    customers: synced.customers || [],
    orders: synced.orders || [],
    contactLogs: synced.contactLogs || [],
    tags: synced.tags || []
  });
  if (before !== after) {
    fs.writeFileSync(DATA_FILE, `${JSON.stringify(synced, null, 2)}\n`, "utf8");
  }
  return synced;
}

function writeDb(db) {
  const synced = synchronizeCustomers(db);
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(synced, null, 2)}\n`, "utf8");
}

function persistOrderProfitSnapshots(orders = []) {
  if (!orders.length) return;
  const db = readDb();
  const snapshotFields = [
    "revenueSnapshot",
    "productCostSnapshot",
    "packageExpenseSnapshot",
    "globalExpenseSnapshot",
    "profitBeforeAdsSnapshot",
    "profitAfterAdsSnapshot",
    "profitSnapshotVersion",
    "profitSnapshotCreatedAt",
    "profitSnapshotUpdatedAt",
    "profitSnapshotSource"
  ];
  const snapshotsById = new Map(orders.map(order => [order.id, order]));
  for (const storedOrder of db.orders || []) {
    const snapshot = snapshotsById.get(storedOrder.id);
    if (!snapshot) continue;
    for (const field of snapshotFields) storedOrder[field] = snapshot[field];
  }
  writeDb(db);
}

function persistUserProfile(userId, { displayName, avatar }) {
  const db = readDb();
  const user = (db.users || []).find(item => item.id === userId);
  if (!user) return null;
  user.name = displayName;
  user.avatar = avatar;
  writeDb(db);
  return user;
}

function deleteOrder(id) {
  const db = readDb();
  const orderIndex = db.orders.findIndex(order => order.id === id);
  if (orderIndex === -1) return false;
  db.orders.splice(orderIndex, 1);
  writeDb(db);
  return true;
}

function deleteCustomer(id) {
  const db = readDb();
  const customerIndex = db.customers.findIndex(customer => customer.id === id);
  if (customerIndex === -1) return false;
  if ((db.orders || []).some(order => order.customerId === id)) return false;
  db.customers.splice(customerIndex, 1);
  db.contactLogs = (db.contactLogs || []).filter(log => log.customerId !== id);
  writeDb(db);
  return true;
}

function getImportJob(id) {
  const db = readDb();
  return db.importJobs?.find(job => job.id === id) || null;
}

function getActiveImportJob(type) {
  const db = readDb();
  return db.importJobs?.find(job => job.type === type && ["queued", "running", "paused"].includes(job.status)) || null;
}

function getLatestImportJob(type) {
  const db = readDb();
  return (db.importJobs || [])
    .filter(job => job.type === type)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function saveImportJob(job) {
  const db = readDb();
  db.importJobs = db.importJobs || [];
  const index = db.importJobs.findIndex(item => item.id === job.id);
  if (index === -1) db.importJobs.push(job);
  else db.importJobs[index] = job;
  writeDb(db);
  return job;
}

function importOrdersBatch(rows) {
  const db = readDb();
  const imported = [];
  const importedCustomerIds = [];
  const failed = [];
  let skipped = 0;
  const existingKeys = new Set((db.orders || []).map(order => {
    const orderNumber = String(order.orderNumber || "").trim().toLowerCase();
    return orderNumber
      ? `order:${orderNumber}`
      : `fallback:${order.date}|${String(order.phone || "").replace(/[^\d]/g, "")}|${Number(order.amount || 0)}`;
  }));

  for (const row of rows) {
    try {
      const phone = String(row.phone || "").replace(/[^\d]/g, "");
      if (!phone || !row.name || !row.date) throw new Error("ข้อมูลชื่อ เบอร์โทร หรือวันที่ไม่ครบ");
      const orderNumber = String(row.orderNumber || "").trim().toLowerCase();
      const key = orderNumber
        ? `order:${orderNumber}`
        : `fallback:${row.date}|${phone}|${Number(row.amount || 0)}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }

      let customer = db.customers.find(item => String(item.phone || "").replace(/[^\d]/g, "") === phone);
      if (!customer) {
        customer = {
          id: `c_${require("crypto").randomBytes(6).toString("hex")}`,
          name: String(row.name).trim(),
          phone,
          address: String(row.address || "").trim(),
          tags: Array.isArray(row.tags) ? row.tags : String(row.tags || "").split(",").map(tag => tag.trim()).filter(Boolean),
          note: "",
          createdAt: row.date,
          lastContactDate: "",
          lastContactNote: "",
          assignedTo: ""
        };
        db.customers.push(customer);
        importedCustomerIds.push(customer.id);
      }
      const order = {
        id: `o_${require("crypto").randomBytes(6).toString("hex")}`,
        customerId: customer.id,
        orderNumber: String(row.orderNumber || "").trim(),
        customerName: String(row.name).trim(),
        phone,
        address: String(row.address || "").trim(),
        date: row.date,
        time: row.time || "",
        items: row.items || "Growup",
        jars: Number(row.jars || 1),
        amount: Number(row.amount || 0),
        source: "Import",
        sourceChannel: row.sourceChannel || "Import",
        socialName: row.socialName || "",
        alternatePhone: row.alternatePhone || "",
        originSource: row.originSource || "",
        freeGift: row.freeGift || "",
        vipCardStatus: row.vipCardStatus || "",
        note: row.note || "",
        rawText: row.rawText || ""
      };
      db.orders.push(order);
      imported.push(order.id);
      existingKeys.add(key);
    } catch (error) {
      failed.push({ rowNumber: row.rowNumber, error: error.message, row });
    }
  }
  writeDb(db);
  return { imported: imported.length, skipped, failed, importedOrderIds: imported, importedCustomerIds };
}

function previewLatestImportCleanup(type = "orders") {
  const db = readDb();
  const job = getLatestImportJob(type);
  if (!job) return null;
  const orderIds = Array.isArray(job.importedOrderIds) ? job.importedOrderIds : [];
  const customerIds = Array.isArray(job.importedCustomerIds) ? job.importedCustomerIds : [];
  return {
    job,
    orderCount: orderIds.length,
    orderIds,
    customerCount: customerIds.length,
    customerIds,
    settingsKeys: [`import_job_${job.id}`],
    supported: true
  };
}

function cleanupImportJob(jobId) {
  const db = readDb();
  const job = db.importJobs?.find(item => item.id === jobId);
  if (!job) return null;
  const orderIds = Array.isArray(job.importedOrderIds) ? job.importedOrderIds : [];
  if (orderIds.length) {
    db.orders = (db.orders || []).filter(order => !orderIds.includes(order.id));
  }
  const remainingCustomerIds = new Set((db.orders || []).map(order => order.customerId));
  const removedCustomerIds = new Set();
  db.customers = (db.customers || []).filter(customer => {
    const shouldRemove = !remainingCustomerIds.has(customer.id);
    if (shouldRemove) removedCustomerIds.add(customer.id);
    return !shouldRemove;
  });
  db.contactLogs = (db.contactLogs || []).filter(log => !removedCustomerIds.has(log.customerId));
  db.importJobs = (db.importJobs || []).filter(item => item.id !== jobId);
  writeDb(db);
  return {
    job,
    deletedOrders: orderIds.length,
    deletedCustomers: removedCustomerIds.size,
    deletedImportRecords: 1,
    supported: true
  };
}

function verifyCustomerSync() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const projected = synchronizeCustomers(JSON.parse(JSON.stringify(raw)));
  const rawCustomerIds = new Set((raw.customers || []).map(customer => customer.id));
  const projectedCustomerIds = new Set((projected.customers || []).map(customer => customer.id));
  const orderCustomerIds = new Set((raw.orders || []).map(order => order.customerId).filter(Boolean));
  const orphanCustomerCount = [...rawCustomerIds].filter(id => !orderCustomerIds.has(id)).length;
  const missingCustomerCount = [...orderCustomerIds].filter(id => !rawCustomerIds.has(id)).length;
  const projectedOnlyCustomerCount = [...projectedCustomerIds].filter(id => !rawCustomerIds.has(id)).length;
  const staleCustomerCount = [...rawCustomerIds].filter(id => !projectedCustomerIds.has(id)).length;
  return {
    ok: orphanCustomerCount === 0 && missingCustomerCount === 0 && projectedOnlyCustomerCount === 0 && staleCustomerCount === 0,
    provider: "json",
    orderCount: (raw.orders || []).length,
    storedCustomerCount: (raw.customers || []).length,
    projectedCustomerCount: (projected.customers || []).length,
    orphanCustomerCount,
    missingCustomerCount,
    projectedOnlyCustomerCount,
    staleCustomerCount
  };
}

module.exports = {
  provider: "json",
  readDb,
  writeDb,
  deleteOrder,
  deleteCustomer,
  getImportJob,
  getActiveImportJob,
  getLatestImportJob,
  previewLatestImportCleanup,
  cleanupImportJob,
  saveImportJob,
  importOrdersBatch,
  persistOrderProfitSnapshots,
  persistUserProfile,
  verifyCustomerSync,
  DATA_FILE
};
