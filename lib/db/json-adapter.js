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

module.exports = {
  provider: "json",
  readDb,
  writeDb,
  DATA_FILE
};
