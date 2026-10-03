"use strict";

const crypto = require("crypto");

function canonicalOrderRequest(value) {
  if (Array.isArray(value)) return value.map(canonicalOrderRequest);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => key !== "clientMutationId" && key !== "selectedDate")
    .map(key => [key, canonicalOrderRequest(value[key])]));
}

function orderRequestFingerprint(body) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalOrderRequest(body))).digest("hex");
}

function orderCreateError(code) {
  const messages = {
    ORDER_CREATE_TOKEN_CONFLICT: "คำขอบันทึกเดิมมีข้อมูลต่างกัน กรุณาเปิดฟอร์มออเดอร์ใหม่",
    ORDER_CREATE_RESULT_REMOVED: "ออเดอร์จากคำขอนี้ถูกลบแล้ว กรุณาเปิดฟอร์มออเดอร์ใหม่",
    ORDER_CREATE_STALE_SNAPSHOT: "ข้อมูลออเดอร์มีการเปลี่ยนแปลง กรุณาลองบันทึกอีกครั้ง",
    ORDER_CREATE_UNCONFIRMED: "ยังยืนยันการบันทึกออเดอร์ไม่ได้ กรุณาลองบันทึกอีกครั้ง",
    ORDER_CREATE_ATOMIC_STORAGE_REQUIRED: "การบันทึกออเดอร์แบบปลอดภัยต้องใช้ฐานข้อมูล Supabase",
    ORDER_CREATE_INVALID_TOKEN: "คำขอบันทึกออเดอร์ไม่ถูกต้อง",
    ORDER_CREATE_FORBIDDEN: "ไม่มีสิทธิ์เพิ่มออเดอร์"
  };
  const error = new Error(messages[code] || messages.ORDER_CREATE_UNCONFIRMED);
  error.code = code;
  error.status = code === "ORDER_CREATE_FORBIDDEN" ? 403
    : code === "ORDER_CREATE_INVALID_TOKEN" ? 400
    : ["ORDER_CREATE_TOKEN_CONFLICT", "ORDER_CREATE_STALE_SNAPSHOT"].includes(code) ? 409
    : code === "ORDER_CREATE_RESULT_REMOVED" ? 410 : 503;
  return error;
}

// Business rules remain in the existing add/inventory/mutation functions.
async function createConfirmedOrder({ body, db, readDb, findOperation, commitOperation, addOrder, adjustInventory, mutationFor }) {
  if (typeof findOperation !== "function" || typeof commitOperation !== "function") {
    throw orderCreateError("ORDER_CREATE_ATOMIC_STORAGE_REQUIRED");
  }
  const token = String(body.clientMutationId || crypto.randomUUID()).trim();
  if (!token || token.length > 160) throw orderCreateError("ORDER_CREATE_INVALID_TOKEN");
  const fingerprint = orderRequestFingerprint(body);
  let result = await findOperation(token, fingerprint);
  for (let attempt = 0; !result && attempt < 4; attempt += 1) {
    const order = addOrder(db, body);
    adjustInventory(db, null, order);
    const mutation = mutationFor(db, { orderId: order.id, selectedDate: body.selectedDate });
    try {
      result = await commitOperation({ token, fingerprint, mutation, db });
    } catch (error) {
      if (error.code !== "ORDER_CREATE_STALE_SNAPSHOT" || attempt === 3) throw error;
      db = await readDb();
      result = await findOperation(token, fingerprint);
    }
  }
  // Never acknowledge a proposed or cached order: confirm the committed row.
  const committedDb = await readDb();
  if (!result?.order_id || !committedDb.orders.some(order => order.id === result.order_id)) {
    throw orderCreateError("ORDER_CREATE_UNCONFIRMED");
  }
  const mutation = mutationFor(committedDb, { orderId: result.order_id, selectedDate: body.selectedDate });
  mutation.clientMutationId = String(body.clientMutationId || "");
  return { mutation, replayed: result.replayed === true };
}

module.exports = { canonicalOrderRequest, orderRequestFingerprint, orderCreateError, createConfirmedOrder };
