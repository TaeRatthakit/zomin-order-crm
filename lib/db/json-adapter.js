const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DATA_FILE = process.env.JSON_DB_PATH || path.join(ROOT, "data", "db.json");

function readDb() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(db, null, 2)}\n`, "utf8");
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
        items: row.items || "Zomin",
        jars: Number(row.jars || 1),
        amount: Number(row.amount || 0),
        source: "Import",
        sourceChannel: row.sourceChannel || "Import",
        socialName: row.socialName || "",
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
  return { imported: imported.length, skipped, failed };
}

module.exports = {
  provider: "json",
  readDb,
  writeDb,
  deleteOrder,
  deleteCustomer,
  getImportJob,
  getActiveImportJob,
  saveImportJob,
  importOrdersBatch,
  DATA_FILE
};
