const fs = require("fs");
const path = require("path");
const { hashPassword } = require("../lib/auth");
const supabase = require("../lib/db/supabase-adapter");

const DATA_FILE = process.env.JSON_DB_PATH || path.join(__dirname, "..", "data", "db.json");

function normalizeUsers(users = []) {
  return users.map(user => {
    if (user.passwordHash) return user;
    const password = user.password || user.pin;
    if (!password) return user;
    const nextUser = { ...user, passwordHash: hashPassword(password) };
    delete nextUser.password;
    delete nextUser.pin;
    return nextUser;
  });
}

async function main() {
  supabase.assertEnv();
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  db.users = normalizeUsers(db.users);
  await supabase.writeDb(db);
  console.log("Migrated JSON data to Supabase.");
  console.log(`Customers: ${(db.customers || []).length}`);
  console.log(`Orders: ${(db.orders || []).length}`);
  console.log(`Users: ${(db.users || []).length}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
