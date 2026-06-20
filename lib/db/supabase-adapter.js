const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

function assertEnv() {
  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length) {
    const message = `Supabase mode needs ENV: ${missing.join(", ")}. Set DATABASE_PROVIDER=json for local JSON mode.`;
    const error = new Error(message);
    error.code = "SUPABASE_ENV_MISSING";
    throw error;
  }
}

function endpoint(table, query = "") {
  const url = new URL(process.env.SUPABASE_URL);
  const restBase = `${url.origin}/rest/v1`;
  return `${restBase}/${table}${query}`;
}

async function request(table, options = {}, query = "") {
  assertEnv();
  const res = await fetch(endpoint(table, query), {
    ...options,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Supabase ${table} request failed: ${res.status} ${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function select(table) {
  return request(table, { method: "GET" }, "?select=*");
}

async function upsert(table, rows) {
  if (!rows || !rows.length) return [];
  return request(table, {
    method: "POST",
    body: JSON.stringify(rows)
  }, "?on_conflict=id");
}

function mapSettings(rows) {
  const settings = {};
  for (const row of rows || []) {
    settings[row.key] = row.value;
  }
  return settings;
}

function settingsRows(settings = {}) {
  return Object.entries(settings).map(([key, value]) => ({ id: key, key, value }));
}

function fromSupabaseShape(data) {
  const customerTagMap = new Map();
  for (const row of data.customer_tags || []) {
    if (!customerTagMap.has(row.customer_id)) customerTagMap.set(row.customer_id, []);
    customerTagMap.get(row.customer_id).push(row.tag_name);
  }
  return {
    settings: mapSettings(data.settings),
    followUpRules: (data.follow_up_rules || []).map(rule => ({ jars: rule.jars, days: rule.days })),
    tags: (data.tags || []).map(tag => tag.name),
    users: (data.users || []).map(user => ({
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      name: user.name,
      role: user.role,
      phone: user.phone || "",
      active: user.is_active
    })),
    customers: (data.customers || []).map(customer => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.latest_address || "",
      tags: customerTagMap.get(customer.id) || [],
      note: customer.note || "",
      createdAt: customer.created_at?.slice(0, 10) || "",
      lastContactDate: "",
      lastContactNote: "",
      assignedTo: customer.assigned_to || ""
    })),
    orders: (data.orders || []).map(order => ({
      id: order.id,
      customerId: order.customer_id,
      date: order.order_date,
      time: order.order_time || "",
      items: order.items || "Zomin",
      jars: order.quantity,
      amount: order.amount,
      source: order.source || "Manual",
      rawText: order.raw_text || "",
      note: order.note || ""
    })),
    lineMessages: (data.line_messages || []).map(message => ({
      id: message.id,
      receivedAt: message.created_at,
      rawEvent: message.raw_event || {},
      text: message.raw_text || "",
      raw_text: message.raw_text || ""
    })),
    contactLogs: (data.contact_logs || []).map(log => ({
      id: log.id,
      customerId: log.customer_id,
      date: log.contact_date,
      result: log.result,
      note: log.note || "",
      staff: log.contacted_by || "",
      nextFollowUpDate: log.next_follow_up_date || ""
    }))
  };
}

async function readDb() {
  const [
    users,
    customers,
    orders,
    line_messages,
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs
  ] = await Promise.all([
    select("users"),
    select("customers"),
    select("orders"),
    select("line_messages"),
    select("follow_up_rules"),
    select("settings"),
    select("tags"),
    select("customer_tags"),
    select("contact_logs")
  ]);
  return fromSupabaseShape({ users, customers, orders, line_messages, follow_up_rules, settings, tags, customer_tags, contact_logs });
}

async function writeDb(db) {
  await upsert("settings", settingsRows(db.settings));
  await upsert("follow_up_rules", (db.followUpRules || []).map(rule => ({ id: String(rule.jars), jars: rule.jars, days: rule.days })));
  await upsert("tags", (db.tags || []).map(name => ({ id: name, name })));
  await upsert("users", (db.users || []).map(user => ({
    id: user.id,
    username: user.username,
    password_hash: user.passwordHash,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    is_active: user.active !== false
  })));
  await upsert("customers", (db.customers || []).map(customer => ({
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    latest_address: customer.address || "",
    note: customer.note || "",
    assigned_to: customer.assignedTo || null
  })));
  const customerTags = [];
  for (const customer of db.customers || []) {
    for (const tag of customer.tags || []) {
      customerTags.push({ id: `${customer.id}_${tag}`, customer_id: customer.id, tag_name: tag });
    }
  }
  await upsert("customer_tags", customerTags);
  await upsert("orders", (db.orders || []).map(order => ({
    id: order.id,
    customer_id: order.customerId,
    customer_name: order.customerName || "",
    phone: order.phone || "",
    address: order.address || "",
    quantity: order.jars,
    amount: order.amount,
    order_date: order.date,
    order_time: order.time || null,
    source: order.source || "",
    note: order.note || "",
    raw_text: order.rawText || "",
    created_by: order.createdBy || null
  })));
  await upsert("line_messages", (db.lineMessages || []).map(message => ({
    id: message.id,
    raw_text: message.text || message.raw_text || "",
    raw_event: message.rawEvent || {}
  })));
  await upsert("contact_logs", (db.contactLogs || []).map(log => ({
    id: log.id,
    customer_id: log.customerId,
    contact_date: log.date,
    contacted_by: log.staff || "",
    result: log.result,
    note: log.note || "",
    next_follow_up_date: log.nextFollowUpDate || null
  })));
}

module.exports = {
  provider: "supabase",
  readDb,
  writeDb,
  assertEnv
};
