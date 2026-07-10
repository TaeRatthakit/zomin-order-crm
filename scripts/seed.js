const { writeDb, provider } = require("../lib/db");
const { hashPassword } = require("../lib/auth");

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

const db = {
  settings: {
    businessName: "Growup",
    defaultJarPrice: 750,
    vipThresholds: {
      vip: 5000,
      vvip: 10000,
      superVip: 20000
    },
    messageTemplates: {
      normal: "สวัสดีค่ะ {{name}} จาก Growup นะคะ รอบก่อนสั่ง {{jars}} กระปุก ตอนนี้ถึงรอบดูแลต่อเนื่องแล้ว ต้องการให้จัดส่งเพิ่มไหมคะ",
      vip: "สวัสดีค่ะ {{name}} ลูกค้า VIP ของ Growup รอบดูแลต่อเนื่องมาถึงแล้ว ทีมงานเตรียมโปรพิเศษไว้ให้ค่ะ"
    },
    followUpDaysPerUnit: 15,
    lineChannelId: "",
    lineChannelSecret: "",
    lineChannelAccessToken: "",
    lineWebhookEnabled: false,
    staffCanExport: false
  },
  followUpRules: [
    { jars: 1, days: 15 },
    { jars: 2, days: 30 },
    { jars: 3, days: 45 },
    { jars: 4, days: 60 },
    { jars: 6, days: 90 },
    { jars: 10, days: 150 },
    { jars: 20, days: 300 }
  ],
  tags: [
    "ปวดเข่า",
    "ปวดข้อ",
    "ปวดหลัง",
    "ซื้อให้พ่อ",
    "ซื้อให้แม่",
    "โทรติดยาก",
    "จ่ายง่าย",
    "VIP ดูแลพิเศษ"
  ],
  users: [
    {
      id: "u_admin",
      username: "admin",
      passwordHash: hashPassword("admin123"),
      name: "แอดมินโซมิน",
      role: "Owner",
      phone: "0810000000",
      active: true
    },
    {
      id: "u_staff_1",
      username: "staff",
      passwordHash: hashPassword("staff123"),
      name: "ทีมขาย 1",
      role: "Staff",
      phone: "0820000000",
      active: true
    }
  ],
  customers: [
    {
      id: "c_pongsak",
      name: "คุณพงศ์ศักดิ์ ขำดี",
      phone: "0812345678",
      address: "99/8 ต.ในเมือง อ.เมือง จ.ขอนแก่น 40000",
      tags: ["ปวดเข่า", "ซื้อให้พ่อ", "VIP ดูแลพิเศษ"],
      note: "ดูแลพิเศษ ชอบให้โทรช่วงเย็น",
      createdAt: daysAgo(300),
      lastContactDate: daysAgo(19),
      lastContactNote: "ดูแลพิเศษ ชอบให้โทรช่วงเย็น",
      assignedTo: "u_staff_1"
    },
    {
      id: "c_malee",
      name: "คุณมาลี ทองดี",
      phone: "0895551122",
      address: "12/5 แขวงบางนา เขตบางนา กรุงเทพฯ 10260",
      tags: ["ปวดข้อ", "ซื้อให้แม่", "จ่ายง่าย"],
      note: "",
      createdAt: daysAgo(40),
      lastContactDate: "",
      lastContactNote: "",
      assignedTo: "u_staff_1"
    },
    {
      id: "c_wipa",
      name: "คุณวิภา",
      phone: "0891234567",
      address: "55/1 จ.เชียงใหม่",
      tags: ["ปวดหลัง"],
      note: "",
      createdAt: daysAgo(20),
      lastContactDate: daysAgo(5),
      lastContactNote: "สนใจโปร 6 กระปุก",
      assignedTo: "u_staff_1"
    }
  ],
  orders: [
    { id: "o_1001", customerId: "c_pongsak", date: daysAgo(260), time: "10:00", items: "Zomin", jars: 6, amount: 4500, source: "LINE", rawText: "" },
    { id: "o_1002", customerId: "c_pongsak", date: daysAgo(160), time: "13:00", items: "Zomin", jars: 13, amount: 9750, source: "โทรศัพท์", rawText: "" },
    { id: "o_1003", customerId: "c_pongsak", date: daysAgo(31), time: "18:20", items: "Zomin", jars: 12, amount: 9000, source: "LINE", rawText: "" },
    { id: "o_1004", customerId: "c_malee", date: daysAgo(30), time: "09:30", items: "Zomin", jars: 2, amount: 1500, source: "LINE", rawText: "" },
    { id: "o_1005", customerId: "c_wipa", date: daysAgo(15), time: "14:10", items: "Zomin", jars: 4, amount: 3000, source: "Import", rawText: "คุณวิภา โทร 0891234567 4 กระปุก รวม 3000 บาท" }
  ],
  lineMessages: [],
  contactLogs: [
    {
      id: "log_1",
      customerId: "c_pongsak",
      date: daysAgo(19),
      result: "โทรติด",
      note: "ดูแลพิเศษ ชอบให้โทรช่วงเย็น",
      staff: "ทีมขาย 1",
      nextFollowUpDate: daysAgo(5)
    }
  ]
};

Promise.resolve(writeDb(db))
  .then(() => {
    console.log(`Seeded Growup Pilot data using ${provider} provider.`);
    console.log("Demo login: owner admin / admin123, staff / staff123");
  })
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
