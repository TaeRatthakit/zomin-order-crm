const { readDb, writeDb, provider } = require("../lib/db");
const { hashPassword } = require("../lib/auth");

async function main() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "";
  const db = await readDb();
  const users = db.users || [];
  const existing = users.find(user => user.username === username || user.id === "u_admin");

  console.log(`Provider: ${provider}`);
  console.log(`Users found: ${users.length}`);
  console.log(`Admin found: ${existing ? "yes" : "no"}`);

  if (!existing && !password) {
    throw new Error("ADMIN_PASSWORD is required to create the production admin user.");
  }

  const admin = existing || {
    id: "u_admin",
    username,
    name: process.env.ADMIN_NAME || "Zomin Admin",
    role: "Admin",
    phone: process.env.ADMIN_PHONE || "",
    active: true
  };

  admin.username = username;
  admin.name = process.env.ADMIN_NAME || admin.name || "Zomin Admin";
  admin.role = "Admin";
  admin.phone = process.env.ADMIN_PHONE || admin.phone || "";
  admin.active = true;
  if (password) admin.passwordHash = hashPassword(password);
  delete admin.password;
  delete admin.pin;

  if (!existing) users.push(admin);
  db.users = users;
  await writeDb(db);
  console.log(`Production admin ready: ${username}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
