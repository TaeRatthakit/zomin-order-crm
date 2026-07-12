const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const { synchronizeCustomers } = require("../customer-sync");

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

function supabaseOrigin() {
  return new URL(process.env.SUPABASE_URL).origin;
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function select(table) {
  return request(table, { method: "GET" }, "?select=*");
}

async function selectWhere(table, query) {
  return request(table, { method: "GET" }, `?select=*&${query}`);
}

async function upsert(table, rows) {
  if (!rows || !rows.length) return [];
  return request(table, {
    method: "POST",
    body: JSON.stringify(rows)
  }, "?on_conflict=id");
}

function productImageBucket() {
  return process.env.PRODUCT_IMAGE_BUCKET || "product-images";
}

function storageObjectPath(path = "") {
  return String(path)
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

function storageHeaders(headers = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...headers
  };
}

async function storageFetch(pathname, options = {}) {
  assertEnv();
  const res = await fetch(`${supabaseOrigin()}/storage/v1${pathname}`, {
    ...options,
    headers: storageHeaders(options.headers || {})
  });
  if (!res.ok && !(options.allowNotFound && res.status === 404)) {
    const detail = await res.text();
    throw new Error(`Supabase Storage request failed: ${res.status} ${detail}`);
  }
  return res;
}

async function ensureProductImageBucket() {
  const bucket = productImageBucket();
  const bucketPath = `/bucket/${encodeURIComponent(bucket)}`;
  const existing = await storageFetch(bucketPath, { method: "GET", allowNotFound: true });
  if (existing.status === 404) {
    await storageFetch("/bucket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: bucket,
        name: bucket,
        public: true,
        file_size_limit: 10_000_000,
        allowed_mime_types: ["image/webp", "image/jpeg", "image/png", "image/gif", "image/svg+xml"]
      })
    });
    return { bucket, created: true, public: true };
  }
  const bucketInfo = await existing.json().catch(() => ({}));
  if (bucketInfo.public !== true) {
    await storageFetch(bucketPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public: true, file_size_limit: 10_000_000 })
    });
  }
  return { bucket, created: false, public: true };
}

function productImagePublicUrl(objectPath) {
  const encodedPath = storageObjectPath(objectPath);
  return `${supabaseOrigin()}/storage/v1/object/public/${encodeURIComponent(productImageBucket())}/${encodedPath}`;
}

function productImagePublicBaseUrl() {
  return `${supabaseOrigin()}/storage/v1/object/public/${encodeURIComponent(productImageBucket())}/products/`;
}

async function uploadProductImageObject(objectPath, bytes, contentType) {
  await ensureProductImageBucket();
  const encodedPath = storageObjectPath(objectPath);
  await storageFetch(`/object/${encodeURIComponent(productImageBucket())}/${encodedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true",
      "Cache-Control": "31536000"
    },
    body: bytes
  });
  return productImagePublicUrl(objectPath);
}

async function verifyPublicProductImageUrl(url) {
  const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
  return res.ok;
}

async function deleteWhere(table, query) {
  await request(table, { method: "DELETE" }, `?${query}`);
}

async function deleteOrder(id) {
  await request("orders", { method: "DELETE" }, `?id=eq.${encodeURIComponent(id)}`);
}

async function deleteUser(id) {
  await request("users", { method: "DELETE" }, `?id=eq.${encodeURIComponent(id)}`);
}

function customerRowPayload(customer = {}) {
  return {
    id: customer.id,
    name: customer.name,
    phone: storedCustomerPhone(customer.phone, customer.id),
    latest_address: customer.address || "",
    note: customer.note || "",
    assigned_to: customer.assignedTo || null,
    first_purchase_date: customer.firstPurchaseDate || customer.createdAt || null,
    last_purchase_date: customer.lastPurchaseDate || null,
    purchase_count: Number(customer.purchaseCount || 0),
    total_quantity: Number(customer.totalJars || 0),
    total_amount: Number(customer.totalSpent || 0),
    status: customer.status || "NORMAL",
    vip_level: customer.vipLevel || "NORMAL",
    customer_score: Number(customer.customerScore || 0),
    follow_up_date: customer.followUpDate || null,
    last_contact_date: customer.lastContactDate || null,
    last_contact_note: customer.lastContactNote || ""
  };
}

function orderRowPayload(order = {}) {
  return {
    id: order.id,
    customer_id: order.customerId,
    order_number: normalizeOrderNumber(order.orderNumber),
    customer_name: order.customerName || "",
    phone: order.phone || "",
    address: order.address || "",
    items: order.items || order.product || "Growup",
    quantity: order.jars,
    amount: order.amount,
    order_date: order.date,
    order_time: order.time || null,
    source: order.source || "",
    source_channel: order.sourceChannel || order.source_channel || "",
    social_name: order.socialName || order.social_name || "",
    free_gift: order.freeGift || order.free_gift || "",
    vip_card_status: order.vipCardStatus || order.vip_card_status || "",
    note: order.note || "",
    raw_text: rawTextWithOrderMetadata(order),
    created_by: order.createdBy || null
  };
}

async function deleteCustomer(id) {
  const customerId = encodeURIComponent(id);
  await request("customer_tags", { method: "DELETE" }, `?customer_id=eq.${customerId}`);
  await request("contact_logs", { method: "DELETE" }, `?customer_id=eq.${customerId}`);
  await request("customers", { method: "DELETE" }, `?id=eq.${customerId}`);
}

async function getImportJob(id) {
  const rows = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_job_${id}`)}&limit=1`);
  return rows?.[0]?.value || null;
}

async function getActiveImportJob(type) {
  const rows = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_active_${type}`)}&limit=1`);
  const id = rows?.[0]?.value?.id;
  if (!id) return null;
  const job = await getImportJob(id);
  return job && ["queued", "running", "paused"].includes(job.status) ? job : null;
}

async function getLatestImportJob(type) {
  const rows = await selectWhere(
    "settings",
    `key=like.${encodeURIComponent("import_job_%")}&order=updated_at.desc&limit=10`
  );
  return (rows || []).map(row => row.value).find(job => job?.type === type) || null;
}

async function saveImportJob(job) {
  await upsert("settings", [{
    id: `import_job_${job.id}`,
    key: `import_job_${job.id}`,
    value: job
  }]);
  if (["queued", "running", "paused"].includes(job.status)) {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: job.id }
    }]);
  } else {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: "" }
    }]);
  }
  return job;
}

async function previewLatestImportCleanup(type = "orders") {
  const job = await getLatestImportJob(type);
  if (!job) return null;
  const startedAt = encodeURIComponent(job.startedAt || job.createdAt || "");
  const completedAt = encodeURIComponent(job.completedAt || job.startedAt || job.createdAt || "");
  const [orders, customers] = await Promise.all([
    selectWhere(
      "orders",
      `select=id,customer_id,created_at&created_at=gte.${startedAt}&created_at=lte.${completedAt}&limit=20000`
    ),
    selectWhere(
      "customers",
      `select=id,created_at&created_at=gte.${startedAt}&created_at=lte.${completedAt}&limit=20000`
    )
  ]);
  const orderIds = (orders || []).map(order => order.id);
  const customerIds = (customers || []).map(customer => customer.id);
  return {
    job,
    orderCount: orderIds.length,
    orderIds,
    customerCount: customerIds.length,
    customerIds,
    settingsKeys: [`import_job_${job.id}`]
  };
}

async function cleanupImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) return null;
  const preview = await previewLatestImportCleanup(job.type || "orders");
  if (!preview || preview.job.id !== jobId) {
    throw new Error("Cleanup is only allowed for the latest import job.");
  }

  const orderIds = Array.isArray(job.importedOrderIds) && job.importedOrderIds.length ? job.importedOrderIds : (preview.orderIds || []);

  if (orderIds.length) {
    await deleteWhere("orders", `id=in.${encodeURIComponent(inFilter(orderIds))}`);
  }

  const allCustomers = await selectWhere("customers", "select=id");
  const orphanCustomerIds = [];
  for (const customer of allCustomers || []) {
    const remaining = await selectWhere("orders", `select=id&customer_id=eq.${encodeURIComponent(customer.id)}&limit=1`);
    if (!remaining?.length) orphanCustomerIds.push(customer.id);
  }

  if (orphanCustomerIds.length) {
    await deleteIdsInChunks("customers", "id", orphanCustomerIds);
    await deleteIdsInChunks("contact_logs", "customer_id", orphanCustomerIds);
  }

  await deleteWhere("settings", `key=eq.${encodeURIComponent(`import_job_${jobId}`)}`);
  const active = await selectWhere("settings", `key=eq.${encodeURIComponent(`import_active_${job.type}`)}&limit=1`);
  if (active?.[0]?.value?.id === jobId) {
    await upsert("settings", [{
      id: `import_active_${job.type}`,
      key: `import_active_${job.type}`,
      value: { id: "" }
    }]);
  }

  return {
    job,
    deletedOrders: orderIds.length,
    deletedCustomers: orphanCustomerIds.length,
    deletedImportRecords: 1
  };
}

function inFilter(values) {
  return `(${values.map(value => `"${String(value).replace(/["\\]/g, "")}"`).join(",")})`;
}

async function deleteIdsInChunks(table, field, ids, chunkSize = 100) {
  for (let index = 0; index < ids.length; index += chunkSize) {
    const chunk = ids.slice(index, index + chunkSize);
    if (!chunk.length) continue;
    await deleteWhere(table, `${field}=in.${encodeURIComponent(inFilter(chunk))}`);
  }
}

function importOrderKey(order) {
  const orderNumber = String(order.order_number || order.orderNumber || "").trim().toLowerCase();
  return orderNumber
    ? `order:${orderNumber}`
    : `fallback:${String(order.order_date || order.date || "")}|${String(order.phone || "").replace(/[^\d]/g, "")}|${Number(order.amount || 0)}`;
}

function storedCustomerPhone(value, customerId) {
  const phone = String(value || "").trim();
  if (phone) return phone;
  return `missingphone${String(customerId || "customer").toLowerCase().replace(/[^a-z]/g, "x")}`;
}

async function importOrdersBatch(rows) {
  const validRows = [];
  const failed = [];
  for (const row of rows) {
    const phone = String(row.phone || "").replace(/[^\d]/g, "");
    if (!phone || !String(row.name || "").trim() || !String(row.date || "").trim()) {
      failed.push({ rowNumber: row.rowNumber, error: "ข้อมูลชื่อ เบอร์โทร หรือวันที่ไม่ครบ", row });
    } else if (!Number.isFinite(Number(row.jars)) || !Number.isFinite(Number(row.amount))) {
      failed.push({ rowNumber: row.rowNumber, error: "จำนวนหรือยอดซื้อไม่ถูกต้อง", row });
    } else {
      validRows.push({ ...row, phone });
    }
  }
  if (!validRows.length) return { imported: 0, skipped: 0, failed };

  const orderNumbers = [...new Set(validRows.map(row => String(row.orderNumber || "").trim()).filter(Boolean))];
  const dates = [...new Set(validRows.map(row => row.date).filter(Boolean))];
  const phones = [...new Set(validRows.map(row => row.phone))];
  const [numberMatches, dateMatches, customerMatches] = await Promise.all([
    orderNumbers.length
      ? selectWhere("orders", `order_number=in.${encodeURIComponent(inFilter(orderNumbers))}`)
      : [],
    dates.length
      ? selectWhere("orders", `order_date=in.${encodeURIComponent(inFilter(dates))}&phone=in.${encodeURIComponent(inFilter(phones))}`)
      : [],
    selectWhere("customers", `phone=in.${encodeURIComponent(inFilter(phones))}`)
  ]);
  const existingKeys = new Set([...(numberMatches || []), ...(dateMatches || [])].map(importOrderKey));
  const customersByPhone = new Map((customerMatches || []).map(customer => [String(customer.phone || "").replace(/[^\d]/g, ""), customer]));
  const customers = [];
  const orders = [];
  const tags = [];
  const customerTags = [];
  const importedCustomerIds = [];
  const importedOrderIds = [];
  let skipped = 0;

  for (const row of validRows) {
    const key = importOrderKey(row);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    let customer = customersByPhone.get(row.phone);
    if (!customer) {
      customer = {
        id: `c_${require("crypto").randomBytes(6).toString("hex")}`,
        name: String(row.name).trim(),
        phone: row.phone,
        latest_address: String(row.address || "").trim(),
        note: ""
      };
      customersByPhone.set(row.phone, customer);
      customers.push(customer);
      importedCustomerIds.push(customer.id);
    }
    const orderId = `o_${require("crypto").randomBytes(6).toString("hex")}`;
    orders.push({
      __rowNumber: row.rowNumber,
      __sourceRow: row,
      id: orderId,
      customer_id: customer.id,
      order_number: String(row.orderNumber || "").trim(),
      customer_name: String(row.name).trim(),
      phone: row.phone,
      address: String(row.address || "").trim(),
      items: row.items || "Growup",
      quantity: Number(row.jars || 1),
      amount: Number(row.amount || 0),
      order_date: row.date,
      order_time: row.time || null,
      source: "Import",
      source_channel: row.sourceChannel || "Import",
      social_name: row.socialName || "",
      free_gift: row.freeGift || "",
      vip_card_status: row.vipCardStatus || "",
      note: row.note || "",
      raw_text: rawTextWithOrderMetadata({
        orderNumber: row.orderNumber,
        alternatePhone: row.alternatePhone || "",
        originSource: row.originSource || "",
        originSourceOther: row.originSourceOther || "",
        rawText: row.rawText || ""
      })
    });
    importedOrderIds.push(orderId);
    for (const tagName of Array.isArray(row.tags) ? row.tags : String(row.tags || "").split(",").map(tag => tag.trim()).filter(Boolean)) {
      tags.push({ id: tagName, name: tagName });
      customerTags.push({ id: `${customer.id}_${tagName}`, customer_id: customer.id, tag_name: tagName });
    }
    existingKeys.add(key);
  }

  await upsert("customers", customers);
  await upsert("tags", [...new Map(tags.map(tag => [tag.id, tag])).values()]);
  await upsert("customer_tags", [...new Map(customerTags.map(tag => [tag.id, tag])).values()]);
  const orderPayload = orders.map(({ __rowNumber, __sourceRow, ...order }) => order);
  let imported = orderPayload.length;
  try {
    await upsert("orders", orderPayload);
  } catch {
    imported = 0;
    for (const order of orders) {
      const { __rowNumber, __sourceRow, ...payload } = order;
      try {
        await upsert("orders", [payload]);
        imported += 1;
      } catch (error) {
        failed.push({ rowNumber: __rowNumber, error: error.message, row: __sourceRow });
      }
    }
  }
  return { imported, skipped, failed, importedOrderIds, importedCustomerIds };
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

async function readSettingsPatch(keys = []) {
  const names = [...new Set(keys.map(key => String(key || "").trim()).filter(Boolean))];
  if (!names.length) return {};
  const rows = await selectWhere("settings", `key=in.(${names.map(encodeURIComponent).join(",")})`);
  return mapSettings(rows || []);
}

function orderNumberFromRawText(rawText) {
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (parsed.__orderNumber) return String(parsed.__orderNumber);
    const nested = parsed.primary || parsed.merged;
    return nested ? orderNumberFromRawText(nested) : "";
  } catch {
    return "";
  }
}

function normalizeOrderNumber(value) {
  return String(value || "").trim();
}

function orderMetadataFromRawText(rawText) {
  try {
    const parsed = JSON.parse(rawText || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const nested = parsed.primary || parsed.merged;
    return {
      alternatePhone: parsed.__alternatePhone || (nested ? orderMetadataFromRawText(nested).alternatePhone : "") || "",
      originSource: parsed.__originSource || (nested ? orderMetadataFromRawText(nested).originSource : "") || "",
      originSourceOther: parsed.__originSourceOther || (nested ? orderMetadataFromRawText(nested).originSourceOther : "") || "",
      lineMessageId: parsed.__lineMessageId || (nested ? orderMetadataFromRawText(nested).lineMessageId : "") || "",
      duplicateFingerprint: parsed.__duplicateFingerprint || (nested ? orderMetadataFromRawText(nested).duplicateFingerprint : "") || "",
      productId: parsed.__productId || (nested ? orderMetadataFromRawText(nested).productId : "") || "",
      packageId: parsed.__packageId || (nested ? orderMetadataFromRawText(nested).packageId : "") || "",
      packageName: parsed.__packageName || (nested ? orderMetadataFromRawText(nested).packageName : "") || "",
      paidQuantity: Number(parsed.__paidQuantity ?? (nested ? orderMetadataFromRawText(nested).paidQuantity : 0) ?? 0),
      freeQuantity: Number(parsed.__freeQuantity ?? (nested ? orderMetadataFromRawText(nested).freeQuantity : 0) ?? 0),
      totalQuantityShipped: Number(parsed.__totalQuantityShipped ?? (nested ? orderMetadataFromRawText(nested).totalQuantityShipped : 0) ?? 0),
      packageExpenses: Array.isArray(parsed.__packageExpenses)
        ? parsed.__packageExpenses
        : (nested ? orderMetadataFromRawText(nested).packageExpenses : []) || [],
      revenueSnapshot: Number(parsed.__revenueSnapshot ?? (nested ? orderMetadataFromRawText(nested).revenueSnapshot : 0) ?? 0),
      productCostSnapshot: Number(parsed.__productCostSnapshot ?? (nested ? orderMetadataFromRawText(nested).productCostSnapshot : 0) ?? 0),
      packageExpenseSnapshot: Number(parsed.__packageExpenseSnapshot ?? (nested ? orderMetadataFromRawText(nested).packageExpenseSnapshot : 0) ?? 0),
      globalExpenseSnapshot: Number(parsed.__globalExpenseSnapshot ?? (nested ? orderMetadataFromRawText(nested).globalExpenseSnapshot : 0) ?? 0),
      profitBeforeAdsSnapshot: Number(parsed.__profitBeforeAdsSnapshot ?? (nested ? orderMetadataFromRawText(nested).profitBeforeAdsSnapshot : 0) ?? 0),
      profitAfterAdsSnapshot: Number(parsed.__profitAfterAdsSnapshot ?? (nested ? orderMetadataFromRawText(nested).profitAfterAdsSnapshot : 0) ?? 0),
      profitSnapshotVersion: Number(parsed.__profitSnapshotVersion ?? (nested ? orderMetadataFromRawText(nested).profitSnapshotVersion : 0) ?? 0),
      profitSnapshotCreatedAt: parsed.__profitSnapshotCreatedAt || (nested ? orderMetadataFromRawText(nested).profitSnapshotCreatedAt : "") || "",
      profitSnapshotUpdatedAt: parsed.__profitSnapshotUpdatedAt || (nested ? orderMetadataFromRawText(nested).profitSnapshotUpdatedAt : "") || "",
      profitSnapshotSource: parsed.__profitSnapshotSource || (nested ? orderMetadataFromRawText(nested).profitSnapshotSource : "") || ""
    };
  } catch {
    return {};
  }
}

function rawTextWithOrderMetadata(order) {
  const rawText = String(order.rawText || "");
  let parsed;
  try {
    parsed = JSON.parse(rawText || "{}");
  } catch {
    parsed = rawText ? { primary: rawText } : {};
  }
  if (!parsed || typeof parsed !== "object") parsed = rawText ? { primary: rawText } : {};
  return JSON.stringify({
    ...parsed,
    __orderNumber: normalizeOrderNumber(order.orderNumber),
    __alternatePhone: order.alternatePhone || "",
    __originSource: order.originSource || "",
    __originSourceOther: order.originSourceOther || "",
    __lineMessageId: order.lineMessageId || "",
    __duplicateFingerprint: order.duplicateFingerprint || "",
    __productId: order.productId || "",
    __packageId: order.packageId || "",
    __packageName: order.packageName || "",
    __paidQuantity: Number(order.paidQuantity || 0),
    __freeQuantity: Number(order.freeQuantity || 0),
    __totalQuantityShipped: Number(order.totalQuantityShipped || 0),
    __packageExpenses: Array.isArray(order.packageExpenses) ? order.packageExpenses : [],
    __revenueSnapshot: Number(order.revenueSnapshot || 0),
    __productCostSnapshot: Number(order.productCostSnapshot || 0),
    __packageExpenseSnapshot: Number(order.packageExpenseSnapshot || 0),
    __globalExpenseSnapshot: Number(order.globalExpenseSnapshot || 0),
    __profitBeforeAdsSnapshot: Number(order.profitBeforeAdsSnapshot || 0),
    __profitAfterAdsSnapshot: Number(order.profitAfterAdsSnapshot || 0),
    __profitSnapshotVersion: Number(order.profitSnapshotVersion || 0),
    __profitSnapshotCreatedAt: order.profitSnapshotCreatedAt || "",
    __profitSnapshotUpdatedAt: order.profitSnapshotUpdatedAt || "",
    __profitSnapshotSource: order.profitSnapshotSource || ""
  });
}

function fromSupabaseShape(data) {
  const customerTagMap = new Map();
  for (const row of data.customer_tags || []) {
    if (!customerTagMap.has(row.customer_id)) customerTagMap.set(row.customer_id, []);
    customerTagMap.get(row.customer_id).push(row.tag_name);
  }
  const mappedSettings = mapSettings(data.settings);
  return {
    settings: mappedSettings,
    followUpRules: (data.follow_up_rules || []).map(rule => ({ jars: rule.jars, days: rule.days })),
    tags: (data.tags || []).map(tag => tag.name),
    users: (data.users || []).map(user => ({
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      name: user.name,
      role: user.role,
      phone: user.phone || "",
      active: user.is_active,
      avatar: String(mappedSettings[`profile_avatar_${user.id}`] || "")
    })),
    customers: (data.customers || []).map(customer => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.latest_address || "",
      tags: customerTagMap.get(customer.id) || [],
      note: customer.note || "",
      createdAt: customer.created_at?.slice(0, 10) || "",
      lastContactDate: customer.last_contact_date || "",
      lastContactNote: customer.last_contact_note || "",
      assignedTo: customer.assigned_to || ""
    })),
    orders: (data.orders || []).map(order => ({
      id: order.id,
      customerId: order.customer_id,
      orderNumber: normalizeOrderNumber(order.order_number) || orderNumberFromRawText(order.raw_text),
      customerName: order.customer_name || "",
      phone: order.phone || "",
      address: order.address || "",
      date: order.order_date,
      time: order.order_time || "",
      items: order.items || "Growup",
      jars: order.quantity,
      amount: order.amount,
      source: order.source || "",
      sourceChannel: order.source_channel || "",
      socialName: order.social_name || "",
      freeGift: order.free_gift || "",
      vipCardStatus: order.vip_card_status || "",
      rawText: order.raw_text || "",
      note: order.note || "",
      createdAt: order.created_at || "",
      updatedAt: order.updated_at || ""
    })).map(order => ({ ...order, ...orderMetadataFromRawText(order.rawText) })),
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
  return synchronizeCustomers(fromSupabaseShape({ users, customers, orders, line_messages, follow_up_rules, settings, tags, customer_tags, contact_logs }));
}

async function findUserForLogin(username) {
  const value = String(username || "").trim();
  if (!value) return null;
  let rows = await selectWhere("users", `username=eq.${encodeURIComponent(value)}&limit=1`);
  if (!rows?.length) {
    rows = await selectWhere("users", `id=eq.${encodeURIComponent(value)}&limit=1`);
  }
  const user = rows?.[0];
  if (!user) return null;
  if (user.is_active === false) return null;
  return {
    id: user.id,
    username: user.username,
    passwordHash: user.password_hash,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    active: user.is_active
  };
}

async function readUserById(id) {
  const value = String(id || "").trim();
  if (!value) return null;
  const [users, avatarRows] = await Promise.all([
    selectWhere("users", `id=eq.${encodeURIComponent(value)}&limit=1`),
    selectWhere("settings", `key=eq.${encodeURIComponent(`profile_avatar_${value}`)}&limit=1`)
  ]);
  const user = users?.[0];
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    passwordHash: user.password_hash,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    active: user.is_active,
    avatar: String(avatarRows?.[0]?.value || "")
  };
}

async function writeDb(db) {
  synchronizeCustomers(db);
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
  const existingCustomers = await selectWhere("customers", "select=id");
  const nextCustomerIds = new Set((db.customers || []).map(customer => customer.id));
  const orphanCustomerIds = (existingCustomers || [])
    .map(customer => customer.id)
    .filter(id => !nextCustomerIds.has(id));
  await upsert("customers", (db.customers || []).map(customerRowPayload));
  const customerTags = [];
  for (const customer of db.customers || []) {
    for (const tag of customer.tags || []) {
      customerTags.push({ id: `${customer.id}_${tag}`, customer_id: customer.id, tag_name: tag });
    }
  }
  await upsert("orders", (db.orders || []).map(orderRowPayload));
  if (orphanCustomerIds.length) {
    await deleteIdsInChunks("customers", "id", orphanCustomerIds);
  }
  await request("customer_tags", { method: "DELETE" }, "?customer_id=not.is.null");
  await upsert("customer_tags", customerTags);
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

async function persistSettingsPatch(patch = {}) {
  await upsert("settings", settingsRows(patch));
}

async function persistUserProfile(userId, { displayName, avatar }) {
  const rows = await selectWhere("users", `id=eq.${encodeURIComponent(userId)}&limit=1`);
  const stored = rows?.[0];
  if (!stored) return null;
  await upsert("users", [{
    id: stored.id,
    username: stored.username,
    password_hash: stored.password_hash,
    name: displayName,
    role: stored.role,
    phone: stored.phone || "",
    is_active: stored.is_active !== false
  }]);
  await upsert("settings", [{
    id: `profile_avatar_${userId}`,
    key: `profile_avatar_${userId}`,
    value: avatar || ""
  }]);
  return {
    id: stored.id,
    username: stored.username,
    passwordHash: stored.password_hash,
    name: displayName,
    role: stored.role,
    phone: stored.phone || "",
    active: stored.is_active !== false,
    avatar: avatar || ""
  };
}

async function persistOrderMutation(change = {}, settings = null) {
  const affectedCustomerIds = Array.from(new Set(change.affectedCustomerIds || []));
  if (settings && typeof settings === "object") {
    await upsert("settings", settingsRows(settings));
  }
  if (change.customers?.length) {
    await upsert("customers", change.customers.map(customerRowPayload));
  }
  if (change.deletedOrderId) {
    await deleteOrder(change.deletedOrderId);
  }
  if (change.order) {
    await upsert("orders", [orderRowPayload(change.order)]);
  }
  if (affectedCustomerIds.length) {
    await deleteIdsInChunks("customer_tags", "customer_id", affectedCustomerIds);
  }
  const customerTags = [];
  for (const customer of change.customers || []) {
    for (const tag of customer.tags || []) {
      customerTags.push({ id: `${customer.id}_${tag}`, customer_id: customer.id, tag_name: tag });
    }
  }
  await upsert("tags", (change.tags || []).map(name => ({ id: name, name })));
  await upsert("customer_tags", customerTags);
  if (change.deletedCustomerIds?.length) {
    await deleteIdsInChunks("customers", "id", change.deletedCustomerIds);
    await deleteIdsInChunks("contact_logs", "customer_id", change.deletedCustomerIds);
  }
}

async function persistOrderProfitSnapshots(orders = []) {
  if (!orders.length) return;
  const rows = orders.map(orderRowPayload);
  for (let index = 0; index < rows.length; index += 100) {
    await upsert("orders", rows.slice(index, index + 100));
  }
}

async function verifyCustomerSync() {
  const [
    customers,
    orders,
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs
  ] = await Promise.all([
    select("customers"),
    select("orders"),
    select("follow_up_rules"),
    select("settings"),
    select("tags"),
    select("customer_tags"),
    select("contact_logs")
  ]);
  const raw = fromSupabaseShape({
    users: [],
    customers,
    orders,
    line_messages: [],
    follow_up_rules,
    settings,
    tags,
    customer_tags,
    contact_logs
  });
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
    provider: "supabase",
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
  provider: "supabase",
  readDb,
  findUserForLogin,
  readUserById,
  writeDb,
  deleteUser,
  deleteOrder,
  deleteCustomer,
  getImportJob,
  getActiveImportJob,
  getLatestImportJob,
  previewLatestImportCleanup,
  cleanupImportJob,
  saveImportJob,
  importOrdersBatch,
  persistOrderMutation,
  persistOrderProfitSnapshots,
  persistUserProfile,
  persistSettingsPatch,
  readSettingsPatch,
  ensureProductImageBucket,
  uploadProductImageObject,
  productImagePublicUrl,
  productImagePublicBaseUrl,
  verifyPublicProductImageUrl,
  verifyCustomerSync,
  assertEnv
};
