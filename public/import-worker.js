importScripts("/xlsx.full.min.js");

let cancelled = false;
let activeJobId = "";
let preparedImport = null;

const FIELD_DEFS = [
  { key: "orderNumber", label: "เลขออเดอร์", required: false, aliases: ["เลขออเดอร์", "order_number", "order number", "order no", "เลขที่ออเดอร์"] },
  { key: "date", label: "วันที่ซื้อ", required: true, aliases: ["วันที่ซื้อ", "date", "order date", "วันที่", "วันที่สั่งซื้อ", "purchase date"] },
  { key: "sourceChannel", label: "ช่องทางการสั่งซื้อ", required: false, aliases: ["ช่องทางการสั่งซื้อ", "source_channel", "source channel", "ช่องทาง", "ช่องทางสั่ง", "สั่งจาก", "source"] },
  { key: "socialName", label: "Facebook / LINE ลูกค้า", required: false, aliases: ["facebook / line ลูกค้า", "facebook/line ลูกค้า", "facebook / line", "social_name", "social name", "facebook", "line", "ชื่อเฟส", "ชื่อไลน์", "facebook line ลูกค้า", "facebook / line customer"] },
  { key: "name", label: "ชื่อลูกค้า", required: true, aliases: ["ชื่อลูกค้า", "name", "customer", "customer name", "ชื่อ", "ชื่อลูกค้ารับของ", "ลูกค้า"] },
  { key: "phone", label: "เบอร์โทร", required: true, aliases: ["เบอร์โทร", "phone", "tel", "mobile", "เบอร์", "โทร", "โทรศัพท์", "เบอร์โทรศัพท์"] },
  { key: "alternatePhone", label: "เบอร์โทรสำรอง", required: false, aliases: ["เบอร์โทรสำรอง", "alternate phone", "secondary phone", "เบอร์สำรอง", "โทรสำรอง"] },
  { key: "address", label: "ที่อยู่จัดส่ง", required: false, aliases: ["ที่อยู่จัดส่ง", "address", "ที่อยู่", "shipping address"] },
  { key: "jars", label: "จำนวน", required: false, aliases: ["จำนวน", "จำนวนกระปุก", "jars", "jar", "กระปุก", "ซื้อกี่กระปุก", "qty", "quantity"] },
  { key: "amount", label: "ยอดซื้อ", required: false, aliases: ["ยอดซื้อ", "amount", "total", "ยอด", "ราคา", "ยอดรวม"] },
  { key: "freeGift", label: "ของแถมที่ลูกค้าได้", required: false, aliases: ["ของแถมที่ลูกค้าได้", "free_gift", "free gift", "ของแถม", "แถม"] },
  { key: "vipCardStatus", label: "สถานะบัตร VIP", required: false, aliases: ["สถานะบัตร vip", "vip_card_status", "vip card status", "บัตร vip", "เคยได้บัตรvipแล้วหรือยัง"] },
  { key: "tags", label: "อาการลูกค้า", required: false, aliases: ["อาการลูกค้า", "tags", "tag", "แท็ก", "อาการ"] },
  { key: "originSource", label: "ลูกค้ามาจาก", required: false, aliases: ["ลูกค้ามาจาก", "origin_source", "origin source", "มาจาก", "แหล่งที่มา"] },
  { key: "note", label: "หมายเหตุ", required: false, aliases: ["หมายเหตุ", "note", "remark", "remarks"] },
  { key: "items", label: "สินค้า", required: false, aliases: ["สินค้า", "items", "product", "product_name"] }
];

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-/().]+/g, "");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}

function normalizeDate(value) {
  const text = cellText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const compactThai = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (compactThai) {
    const first = Number(compactThai[1]);
    const second = Number(compactThai[2]);
    let year = Number(compactThai[3]);
    if (year < 100) year = year >= 50 ? year + 2500 : year + 2000;
    if (year > 2400) year -= 543;
    const isMonthFirst = first <= 12 && second > 12;
    const day = isMonthFirst ? second : first;
    const month = isMonthFirst ? first : second;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toISOString().slice(0, 10);
}

function parseNumber(value) {
  const text = cellText(value).replace(/,/g, "");
  if (!text) return NaN;
  return Number(text);
}

function normalizeVipStatus(value) {
  const text = cellText(value);
  if (!text) return "";
  if (/^(เคย|ใช่|มี|ส่งแล้ว|ได้แล้ว|yes|y|true|1)$/i.test(text)) return "ส่งบัตรแล้ว";
  if (/^(ยัง|ไม่|no|n|false|0)$/i.test(text)) return "ยังไม่ได้ส่งบัตร";
  return text;
}

function normalizeCustomerSource(value) {
  const raw = cellText(value);
  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9ก-๙]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const known = ["facebook", "line", "phone", "crm", "referral", "tiktok", "shopee", "lazada", "instagram", "website", "walk_in"];
  if (!raw) return { originSource: "", originSourceOther: "" };
  if (known.includes(normalized)) return { originSource: normalized, originSourceOther: "" };
  if (normalized.includes("facebook") || normalized === "fb" || raw.includes("เฟส") || raw.includes("เพจ") || raw.includes("ไลฟ์")) return { originSource: "facebook", originSourceOther: "" };
  if (normalized.includes("line") || raw.includes("ไลน์")) return { originSource: "line", originSourceOther: "" };
  if (normalized === "crm" || normalized.includes("customer_relationship") || raw.includes("ลูกค้าสัมพันธ์")) return { originSource: "crm", originSourceOther: "" };
  if (normalized.includes("tiktok") || normalized.includes("tik_tok") || raw.includes("ติ๊กต็อก")) return { originSource: "tiktok", originSourceOther: "" };
  if (normalized.includes("shopee") || raw.includes("ช้อปปี้") || raw.includes("ช็อปปี้")) return { originSource: "shopee", originSourceOther: "" };
  if (normalized.includes("lazada") || raw.includes("ลาซาด้า")) return { originSource: "lazada", originSourceOther: "" };
  if (normalized.includes("instagram") || normalized === "ig" || raw.includes("อินสตาแกรม")) return { originSource: "instagram", originSourceOther: "" };
  if (normalized.includes("website") || normalized.includes("web") || raw.includes("เว็บไซต์")) return { originSource: "website", originSourceOther: "" };
  if (normalized.includes("walk_in") || normalized.includes("walkin") || raw.includes("หน้าร้าน")) return { originSource: "walk_in", originSourceOther: "" };
  if (raw.includes("โทร") || normalized.includes("phone") || normalized.includes("call") || normalized.includes("tel")) return { originSource: "phone", originSourceOther: "" };
  if (raw.includes("บอกต่อ") || raw.includes("แนะนำ") || normalized.includes("referral") || normalized.includes("refer")) return { originSource: "referral", originSourceOther: "" };
  return { originSource: normalized, originSourceOther: "" };
}

function matchField(headerValue) {
  const normalized = normalizeHeader(headerValue);
  if (!normalized) return null;
  let best = null;
  for (const field of FIELD_DEFS) {
    for (const alias of field.aliases) {
      const normalizedAlias = normalizeHeader(alias);
      let score = 0;
      if (normalized === normalizedAlias) score = 100;
      else if (normalized.includes(normalizedAlias) || normalizedAlias.includes(normalized)) score = 70;
      if (!best || score > best.score) best = { key: field.key, score };
    }
  }
  return best?.score >= 70 ? best.key : null;
}

function detectHeaderRow(rows) {
  const scanLimit = Math.min(rows.length, 25);
  let best = { index: 0, score: -1 };
  for (let index = 0; index < scanLimit; index += 1) {
    const row = rows[index] || [];
    const seen = new Set();
    let score = 0;
    for (const cell of row) {
      const fieldKey = matchField(cell);
      if (fieldKey && !seen.has(fieldKey)) {
        seen.add(fieldKey);
        score += FIELD_DEFS.find(field => field.key === fieldKey)?.required ? 3 : 1;
      }
    }
    if (score > best.score) best = { index, score };
  }
  return best.index;
}

function mapColumns(headerRow) {
  const mapped = new Map();
  const usedIndexes = new Set();
  headerRow.forEach((header, index) => {
    const fieldKey = matchField(header);
    if (!fieldKey || usedIndexes.has(index) || mapped.has(fieldKey)) return;
    mapped.set(fieldKey, { index, header: cellText(header) });
    usedIndexes.add(index);
  });
  return mapped;
}

function rowsFromSheet(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false
  }).filter(row => Array.isArray(row) && row.some(cell => cellText(cell)));
}

function normalizePreparedRows(rows, defaultJarPrice) {
  if (!rows.length) {
    return {
      totalRows: 0,
      headerRowIndex: 0,
      headerRow: [],
      mappedColumns: [],
      missingColumns: FIELD_DEFS.map(field => field.label),
      invalidColumns: [],
      previewRows: [],
      rows: [],
      invalidRows: 0,
      readyRows: 0,
      canImport: false,
      validationMessage: "ไม่พบข้อมูลในไฟล์"
    };
  }

  const headerRowIndex = detectHeaderRow(rows);
  const headerRow = rows[headerRowIndex] || [];
  const mapped = mapColumns(headerRow);
  const mappedColumns = FIELD_DEFS
    .filter(field => mapped.has(field.key) && field.key !== "items")
    .map(field => ({ key: field.key, label: field.label, header: mapped.get(field.key).header }));
  const missingColumns = FIELD_DEFS
    .filter(field => field.key !== "items" && !mapped.has(field.key))
    .map(field => field.label);
  const invalidColumns = headerRow
    .map(cell => cellText(cell))
    .filter(Boolean)
    .filter(cell => !mappedColumns.some(item => item.header === cell));
  const dataRows = rows.slice(headerRowIndex + 1);
  const normalizedRows = [];
  let invalidRows = 0;
  let readyRows = 0;

  dataRows.forEach((row, rowOffset) => {
    const value = key => {
      const column = mapped.get(key);
      return column ? cellText(row[column.index]) : "";
    };
    const jarsValue = parseNumber(value("jars"));
    const jars = Number.isFinite(jarsValue) && jarsValue > 0 ? jarsValue : 1;
    const amountValue = parseNumber(value("amount"));
    const orderNumber = value("orderNumber");
    const origin = normalizeCustomerSource(value("originSource"));
    const normalized = {
      rowNumber: headerRowIndex + rowOffset + 2,
      orderNumber,
      date: normalizeDate(value("date")),
      sourceChannel: value("sourceChannel") || "Import",
      socialName: value("socialName"),
      name: value("name"),
      phone: value("phone"),
      alternatePhone: value("alternatePhone"),
      address: value("address"),
      jars,
      amount: Number.isFinite(amountValue) ? amountValue : jars * Number(defaultJarPrice || 750),
      freeGift: value("freeGift"),
      vipCardStatus: normalizeVipStatus(value("vipCardStatus")),
      tags: value("tags"),
      originSource: origin.originSource,
      originSourceOther: origin.originSourceOther,
      note: value("note"),
      items: value("items") || "Growup",
      source: "Import"
    };
    normalized.rawText = JSON.stringify({
      ...Object.fromEntries(headerRow.map((header, index) => [cellText(header), cellText(row[index])])),
      __orderNumber: normalized.orderNumber || "",
      __alternatePhone: normalized.alternatePhone || "",
      __originSource: normalized.originSource || "",
      __originSourceOther: normalized.originSourceOther || ""
    });
    if (!normalized.name || !normalized.phone || !normalized.date) invalidRows += 1;
    else readyRows += 1;
    normalizedRows.push(normalized);
  });

  const missingRequired = FIELD_DEFS.filter(field => field.required && !mapped.has(field.key)).map(field => field.label);
  return {
    totalRows: normalizedRows.length,
    headerRowIndex,
    headerRow,
    mappedColumns,
    missingColumns,
    invalidColumns,
    previewRows: normalizedRows.slice(0, 10),
    rows: normalizedRows,
    invalidRows,
    readyRows,
    canImport: missingRequired.length === 0 && normalizedRows.length > 0,
    validationMessage: missingRequired.length ? `ต้องมีคอลัมน์ ${missingRequired.join(", ")} ก่อนเริ่มนำเข้า` : ""
  };
}

function inspectPreparedSheet(defaultJarPrice) {
  if (!preparedImport) throw new Error("ยังไม่มีไฟล์ที่เลือก");
  const normalized = normalizePreparedRows(preparedImport.rowsBySheet.get(preparedImport.selectedSheet) || [], defaultJarPrice);
  preparedImport.normalizedRows = normalized.rows;
  return {
    fileName: preparedImport.fileName,
    fileType: preparedImport.fileType,
    fileTypeLabel: preparedImport.fileType.toUpperCase(),
    sheetNames: preparedImport.sheetNames,
    selectedSheet: preparedImport.selectedSheet,
    headerRowNumber: normalized.headerRowIndex + 1,
    totalRows: normalized.totalRows,
    readyRows: normalized.readyRows,
    invalidRows: normalized.invalidRows,
    mappedColumns: normalized.mappedColumns,
    missingColumns: normalized.missingColumns,
    invalidColumns: normalized.invalidColumns,
    previewRows: normalized.previewRows,
    canImport: normalized.canImport,
    validationMessage: normalized.validationMessage
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Import request failed");
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function inspectFile(file, defaultJarPrice) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false, dense: true, cellDates: true });
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) throw new Error("ไม่พบชีตในไฟล์ที่เลือก");
  preparedImport = {
    fileName: file.name,
    fileType: (String(file.name).split(".").pop() || "csv").toLowerCase(),
    sheetNames,
    selectedSheet: sheetNames[0],
    rowsBySheet: new Map(sheetNames.map(name => [name, rowsFromSheet(workbook.Sheets[name])]))
  };
  return inspectPreparedSheet(defaultJarPrice);
}

async function runPreparedImport(defaultJarPrice) {
  if (!preparedImport) throw new Error("ยังไม่มีไฟล์ที่พร้อมนำเข้า");
  const inspection = inspectPreparedSheet(defaultJarPrice);
  if (!inspection.canImport) throw new Error(inspection.validationMessage || "ไฟล์นี้ยังไม่พร้อมนำเข้า");

  cancelled = false;
  self.postMessage({ type: "preparing", fileName: preparedImport.fileName });
  const rows = preparedImport.normalizedRows;
  const fingerprint = `${preparedImport.fileName}:${preparedImport.selectedSheet}:${rows.length}`;
  const started = await request("/api/import-jobs", {
    method: "POST",
    body: JSON.stringify({
      type: "orders",
      total: rows.length,
      fileName: preparedImport.sheetNames.length > 1
        ? `${preparedImport.fileName} (${preparedImport.selectedSheet})`
        : preparedImport.fileName,
      fileSize: rows.length,
      fingerprint,
      batchSize: 300
    })
  });
  let job = started.job;
  activeJobId = job.id;
  self.postMessage({ type: "progress", job });
  let offset = Number(job.processed || 0);

  while (offset < rows.length && !cancelled) {
    const batch = rows.slice(offset, offset + Number(job.batchSize || 300));
    const payload = await request(`/api/import-jobs/${encodeURIComponent(job.id)}/batches`, {
      method: "POST",
      body: JSON.stringify({ offset, rows: batch })
    });
    job = payload.job;
    offset = Number(job.processed || offset + batch.length);
    self.postMessage({ type: "progress", job });
  }
  if (!cancelled && job.status === "completed") {
    preparedImport = null;
    self.postMessage({ type: "complete", job });
  }
}

self.addEventListener("message", async event => {
  try {
    if (event.data?.type === "inspect" && event.data.file) {
      self.postMessage({ type: "preparing", fileName: event.data.file.name });
      const inspection = await inspectFile(event.data.file, event.data.defaultJarPrice);
      self.postMessage({ type: "inspected", inspection });
      return;
    }
    if (event.data?.type === "select-sheet") {
      if (!preparedImport) throw new Error("ยังไม่มีไฟล์ที่เลือก");
      preparedImport.selectedSheet = event.data.sheetName || preparedImport.selectedSheet;
      const inspection = inspectPreparedSheet(event.data.defaultJarPrice);
      self.postMessage({ type: "inspected", inspection });
      return;
    }
    if (event.data?.type === "start-import") {
      await runPreparedImport(event.data.defaultJarPrice);
      return;
    }
    if (event.data?.type === "cancel") {
      cancelled = true;
      if (activeJobId) {
        const payload = await request(`/api/import-jobs/${encodeURIComponent(activeJobId)}/cancel`, {
          method: "POST",
          body: "{}"
        });
        self.postMessage({ type: "cancelled", job: payload.job });
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error.message,
      job: error.payload?.job || null
    });
  }
});
