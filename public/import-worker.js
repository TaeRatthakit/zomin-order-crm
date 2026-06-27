let cancelled = false;
let activeJobId = "";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!match) return text;
  const year = Number(match[3]) > 2400 ? Number(match[3]) - 543 : Number(match[3]);
  return `${year}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function normalizeRows(parsed, defaultJarPrice) {
  if (parsed.length < 2) return [];
  const headers = parsed[0].map(value => value.replace(/^\uFEFF/, "").trim().toLowerCase());
  const aliases = {
    orderNumber: ["order_number", "order number", "เลขออเดอร์"],
    name: ["name", "customer", "customer name", "ชื่อ", "ชื่อลูกค้า", "ชื่อลูกค้ารับของ", "ลูกค้า"],
    phone: ["phone", "tel", "mobile", "เบอร์", "เบอร์โทร", "โทร"],
    address: ["address", "ที่อยู่"],
    date: ["date", "order date", "วันที่", "วันที่ซื้อ", "วันที่สั่งซื้อ"],
    jars: ["jars", "jar", "จำนวนกระปุก", "กระปุก", "ซื้อกี่กระปุก", "qty", "quantity"],
    amount: ["amount", "total", "ยอด", "ยอดซื้อ", "ราคา"],
    tags: ["tags", "tag", "แท็ก"],
    items: ["items", "product", "สินค้า"],
    sourceChannel: ["source_channel", "source channel", "ช่องทาง", "ช่องทางสั่ง", "สั่งจาก", "source"],
    socialName: ["social_name", "social name", "ชื่อเฟส", "ชื่อไลน์", "ชื่อ facebook หรือ ไลน์ ของลูกค้า", "facebook", "line"],
    freeGift: ["free_gift", "free gift", "ของแถม", "แถม"],
    vipCardStatus: ["vip_card_status", "vip card status", "สถานะบัตร vip", "บัตร vip", "เคยได้บัตรvipแล้วหรือยัง"],
    note: ["note", "หมายเหตุ"]
  };
  const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [
    key,
    headers.findIndex(header => names.includes(header))
  ]));
  const value = (row, key) => indexes[key] >= 0 ? String(row[indexes[key]] || "").trim() : "";
  return parsed.slice(1).map((row, index) => {
    const jars = Number(value(row, "jars") || 1);
    const amountText = value(row, "amount").replace(/,/g, "");
    const amount = amountText ? Number(amountText) : jars * defaultJarPrice;
    return {
      rowNumber: index + 2,
      orderNumber: value(row, "orderNumber"),
      name: value(row, "name"),
      phone: value(row, "phone"),
      address: value(row, "address"),
      date: normalizeDate(value(row, "date")),
      jars,
      amount,
      tags: value(row, "tags"),
      items: value(row, "items") || "Zomin",
      sourceChannel: value(row, "sourceChannel") || "Import",
      socialName: value(row, "socialName"),
      freeGift: value(row, "freeGift"),
      vipCardStatus: value(row, "vipCardStatus"),
      note: value(row, "note"),
      rawText: JSON.stringify(Object.fromEntries(headers.map((header, column) => [header, row[column] || ""])))
    };
  });
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

async function runImport(file, defaultJarPrice) {
  cancelled = false;
  self.postMessage({ type: "preparing", fileName: file.name });
  const rows = normalizeRows(parseCsv(await file.text()), Number(defaultJarPrice || 750));
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  const started = await request("/api/import-jobs", {
    method: "POST",
    body: JSON.stringify({
      type: "orders",
      total: rows.length,
      fileName: file.name,
      fileSize: file.size,
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
    self.postMessage({ type: "complete", job });
  }
}

self.addEventListener("message", async event => {
  if (event.data?.type === "start" && event.data.file) {
    try {
      await runImport(event.data.file, event.data.defaultJarPrice);
    } catch (error) {
      self.postMessage({
        type: "error",
        message: error.message,
        job: error.payload?.job || null
      });
    }
  }
  if (event.data?.type === "cancel") {
    cancelled = true;
    if (activeJobId) {
      try {
        const payload = await request(`/api/import-jobs/${encodeURIComponent(activeJobId)}/cancel`, {
          method: "POST",
          body: "{}"
        });
        self.postMessage({ type: "cancelled", job: payload.job });
      } catch (error) {
        self.postMessage({ type: "error", message: error.message });
      }
    }
  }
});
