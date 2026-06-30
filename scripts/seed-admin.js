const { readDb, writeDb, provider } = require("../lib/db");
const { hashPassword } = require("../lib/auth");

const DEFAULT_FOLLOW_UP_RULES = [
  { jars: 1, days: 15 },
  { jars: 2, days: 30 },
  { jars: 3, days: 45 },
  { jars: 4, days: 60 },
  { jars: 6, days: 90 },
  { jars: 10, days: 150 },
  { jars: 20, days: 300 }
];

function defaultSettings(settings = {}) {
  return {
    businessName: settings.businessName || "Growup",
    defaultJarPrice: Number(settings.defaultJarPrice || 750),
    vipThresholds: settings.vipThresholds || {
      vip: 5000,
      vvip: 10000,
      superVip: 20000
    },
    messageTemplates: settings.messageTemplates || {
      normal: "สวัสดีค่ะ {{name}} จาก Growup นะคะ รอบก่อนสั่ง {{jars}} กระปุก ตอนนี้ถึงรอบดูแลต่อเนื่องแล้ว ต้องการให้จัดส่งเพิ่มไหมคะ",
      vip: "สวัสดีค่ะ {{name}} ลูกค้า VIP ของ Growup รอบดูแลต่อเนื่องมาถึงแล้ว ทีมงานเตรียมโปรพิเศษไว้ให้ค่ะ"
    },
    followUpDaysPerUnit: Number(settings.followUpDaysPerUnit || 15),
    lineChannelId: settings.lineChannelId || "",
    lineChannelSecret: settings.lineChannelSecret || "",
    lineChannelAccessToken: settings.lineChannelAccessToken || "",
    lineWebhookEnabled: Boolean(settings.lineWebhookEnabled),
    staffCanExport: Boolean(settings.staffCanExport)
  };
}

async function main() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "";
  const db = await readDb();
  db.settings = defaultSettings(db.settings || {});
  db.followUpRules = db.followUpRules?.length ? db.followUpRules : DEFAULT_FOLLOW_UP_RULES;
  db.tags = db.tags || [];
  db.users = db.users || [];
  db.customers = db.customers || [];
  db.orders = db.orders || [];
  db.lineMessages = db.lineMessages || [];
  db.contactLogs = db.contactLogs || [];

  let user = db.users.find(item => item.username === username || item.id === "u_admin");
  if (!user && !password) {
    throw new Error("ADMIN_PASSWORD is required when creating a new admin user.");
  }

  if (!user) {
    user = {
      id: "u_admin",
      username,
      name: process.env.ADMIN_NAME || "Growup Admin",
      role: "Admin",
      phone: process.env.ADMIN_PHONE || "",
      active: true
    };
    db.users.push(user);
  }

  user.username = username;
  user.name = process.env.ADMIN_NAME || user.name || "Growup Admin";
  user.role = "Admin";
  user.phone = process.env.ADMIN_PHONE || user.phone || "";
  user.active = true;
  if (password) user.passwordHash = hashPassword(password);
  delete user.password;
  delete user.pin;

  await writeDb(db);
  console.log(`Admin seed completed using ${provider} provider.`);
  console.log(`Admin username: ${username}`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
