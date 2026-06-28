"use strict";

function normalizePhone(value = "") {
  return String(value || "").replace(/[^\d]/g, "");
}

function toDateOnly(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function compareOrderMoment(a, b) {
  return [
    toDateOnly(a.date || a.order_date || ""),
    String(a.time || a.order_time || ""),
    String(a.id || "")
  ].join("|").localeCompare([
    toDateOnly(b.date || b.order_date || ""),
    String(b.time || b.order_time || ""),
    String(b.id || "")
  ].join("|"));
}

function diffDays(fromDateOnly, toDateOnlyValue) {
  if (!fromDateOnly || !toDateOnlyValue) return 0;
  const from = new Date(`${fromDateOnly}T00:00:00`);
  const to = new Date(`${toDateOnlyValue}T00:00:00`);
  return Math.floor((to - from) / 86_400_000);
}

function addDays(dateOnly, days) {
  if (!dateOnly) return "";
  const date = new Date(`${dateOnly}T00:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function vipLevel(totalSpent, settings = {}) {
  const thresholds = settings.vipThresholds || {};
  if (totalSpent >= Number(thresholds.superVip ?? 20000)) return "SUPER VIP";
  if (totalSpent >= Number(thresholds.vvip ?? 10000)) return "VVIP";
  if (totalSpent >= Number(thresholds.vip ?? 5000)) return "VIP";
  return "NORMAL";
}

function followUpDaysPerUnit(settings = {}, rules = []) {
  const configured = Number(settings.followUpDaysPerUnit);
  if (configured > 0) return configured;
  const firstRule = [...rules]
    .map(rule => ({ jars: Number(rule.jars), days: Number(rule.days) }))
    .filter(rule => rule.jars > 0 && rule.days > 0)
    .sort((a, b) => a.jars - b.jars)[0];
  if (firstRule) return Math.max(1, Math.round(firstRule.days / firstRule.jars));
  return 15;
}

function customerScore(totalSpent, purchaseCount, firstPurchaseDate, lastPurchaseDate) {
  if (!purchaseCount || !totalSpent) return 0;
  const activeDays = Math.max(30, diffDays(firstPurchaseDate, lastPurchaseDate) + 1);
  const frequencyPerMonth = purchaseCount / (activeDays / 30);
  return Math.round(totalSpent * purchaseCount * frequencyPerMonth);
}

function synchronizeCustomers(db, options = {}) {
  const createId = options.createCustomerId || (() => `c_sync_${Math.random().toString(16).slice(2, 10)}`);
  const existingCustomers = Array.isArray(db.customers) ? db.customers : [];
  const existingById = new Map(existingCustomers.map(customer => [String(customer.id || ""), customer]));
  const existingByPhone = new Map(
    existingCustomers
      .map(customer => [normalizePhone(customer.phone), customer])
      .filter(([phone]) => phone)
  );
  const grouped = new Map();
  const usedIds = new Set();
  const orders = Array.isArray(db.orders) ? db.orders : [];

  for (const order of orders) {
    order.phone = normalizePhone(order.phone || "");
    const requestedId = String(order.customerId || "").trim();
    const existingCustomer = existingById.get(requestedId) || existingByPhone.get(order.phone);
    const groupId = requestedId && !usedIds.has(requestedId)
      ? requestedId
      : existingCustomer?.id && !usedIds.has(existingCustomer.id)
        ? existingCustomer.id
        : requestedId || existingCustomer?.id || createId(order);
    if (!grouped.has(groupId)) {
      grouped.set(groupId, {
        id: groupId,
        existing: existingById.get(groupId) || existingByPhone.get(order.phone) || {},
        orders: []
      });
      usedIds.add(groupId);
    }
    const group = grouped.get(groupId);
    if (!group.existing?.id && order.phone && existingByPhone.has(order.phone)) {
      group.existing = existingByPhone.get(order.phone);
    }
    group.orders.push(order);
    order.customerId = groupId;
  }

  const preservedFieldNames = new Set([
    "id",
    "name",
    "phone",
    "address",
    "tags",
    "createdAt",
    "lastContactDate",
    "lastContactNote",
    "assignedTo",
    "note"
  ]);

  const customers = [...grouped.values()].map(group => {
    const sortedOrders = [...group.orders].sort(compareOrderMoment);
    const firstOrder = sortedOrders[0] || {};
    const lastOrder = sortedOrders[sortedOrders.length - 1] || {};
    const existing = group.existing || {};
    const preserved = Object.fromEntries(
      Object.entries(existing).filter(([key]) => !preservedFieldNames.has(key))
    );
    const firstPurchaseDate = toDateOnly(firstOrder.date || firstOrder.order_date || "");
    const lastPurchaseDate = toDateOnly(lastOrder.date || lastOrder.order_date || "");
    const purchaseCount = sortedOrders.length;
    const totalJars = sortedOrders.reduce((sum, order) => sum + Number(order.jars || order.quantity || 0), 0);
    const totalSpent = sortedOrders.reduce((sum, order) => sum + Number(order.amount || 0), 0);
    const lastJars = Number(lastOrder.jars || lastOrder.quantity || 0);
    const followUpDate = lastPurchaseDate
      ? addDays(lastPurchaseDate, Math.max(followUpDaysPerUnit(db.settings, db.followUpRules), lastJars * followUpDaysPerUnit(db.settings, db.followUpRules)))
      : "";
    const overdueDays = followUpDate ? diffDays(followUpDate, toDateOnly()) : 0;
    const nextVipLevel = vipLevel(totalSpent, db.settings);
    let status = purchaseCount <= 1 ? "NEW" : "NORMAL";
    if (nextVipLevel !== "NORMAL") status = nextVipLevel;
    if (overdueDays > 90) status = "LOST";
    else if (overdueDays > 30) status = "AT RISK";

    return {
      ...preserved,
      id: group.id,
      name: String(lastOrder.customerName || existing.name || `ลูกค้า ${normalizePhone(lastOrder.phone || existing.phone || "")}`).trim(),
      phone: normalizePhone(lastOrder.phone || existing.phone || ""),
      address: String(lastOrder.address || existing.address || "").trim(),
      tags: Array.isArray(existing.tags) ? [...new Set(existing.tags.map(tag => String(tag).trim()).filter(Boolean))] : [],
      note: String(existing.note || "").trim(),
      createdAt: existing.createdAt || toDateOnly(firstOrder.date || firstOrder.order_date || ""),
      lastContactDate: existing.lastContactDate || "",
      lastContactNote: existing.lastContactNote || "",
      assignedTo: existing.assignedTo || "",
      firstPurchaseDate,
      lastPurchaseDate,
      purchaseCount,
      totalJars,
      totalSpent,
      followUpDate,
      status,
      vipLevel: nextVipLevel,
      customerScore: customerScore(totalSpent, purchaseCount, firstPurchaseDate, lastPurchaseDate)
    };
  }).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "th"));

  db.customers = customers;
  db.tags = Array.from(new Set([
    ...(Array.isArray(db.tags) ? db.tags : []),
    ...customers.flatMap(customer => customer.tags || [])
  ])).sort((a, b) => String(a).localeCompare(String(b), "th"));
  const liveCustomerIds = new Set(customers.map(customer => customer.id));
  db.contactLogs = (db.contactLogs || []).filter(log => liveCustomerIds.has(log.customerId));
  return db;
}

module.exports = {
  synchronizeCustomers,
  normalizePhone,
  toDateOnly
};
