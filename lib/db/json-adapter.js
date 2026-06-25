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

module.exports = {
  provider: "json",
  readDb,
  writeDb,
  deleteOrder,
  deleteCustomer,
  DATA_FILE
};
