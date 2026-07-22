const DEFAULT_AD_PLATFORMS = [
  ["facebook_ads", "Facebook Ads"],
  ["tiktok_ads", "TikTok Ads"],
  ["google_ads", "Google Ads"],
  ["line_oa", "LINE OA"],
  ["shopee_ads", "Shopee Ads"],
  ["lazada_ads", "Lazada Ads"],
  ["other", "Other"]
].map(([id, name]) => ({ id, name, enabled: true }));

const AD_COST_MODES = new Set(["fixed_amount", "percent_sales", "cost_per_order"]);

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAdPlatforms(rows, { useDefaults = true } = {}) {
  const source = Array.isArray(rows)
    ? rows
    : (useDefaults ? DEFAULT_AD_PLATFORMS : []);
  const unique = new Map();
  source.forEach((row, index) => {
    const name = normalizeText(row?.name);
    if (!name) return;
    const id = normalizeText(row?.id) || `ad_platform_${index + 1}`;
    unique.set(id, {
      id,
      name,
      enabled: row?.enabled !== false
    });
  });
  return [...unique.values()];
}

function normalizeAdCostRecords(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      id: normalizeText(row?.id) || `ad_cost_${index + 1}`,
      date: /^\d{4}-\d{2}-\d{2}$/.test(normalizeText(row?.date)) ? normalizeText(row.date) : "",
      productId: normalizeText(row?.productId),
      productName: normalizeText(row?.productName),
      platformId: normalizeText(row?.platformId),
      platformName: normalizeText(row?.platformName),
      campaignName: normalizeText(row?.campaignName),
      costMode: AD_COST_MODES.has(row?.costMode) ? row.costMode : "fixed_amount",
      value: Math.max(0, Number(row?.value || 0)),
      enabled: row?.enabled !== false,
      note: normalizeText(row?.note),
      createdAt: normalizeText(row?.createdAt),
      updatedAt: normalizeText(row?.updatedAt)
    }))
    .filter(row => row.date && row.productName && row.platformName);
}

function orderMatchesAdRecord(order = {}, record = {}) {
  if (String(order.date || "") !== record.date) return false;
  if (record.productId && order.productId) return String(order.productId) === record.productId;
  return normalizeText(order.items).toLocaleLowerCase("th-TH")
    === record.productName.toLocaleLowerCase("th-TH");
}

function hasProfitSnapshot(order = {}) {
  return Number(order.profitSnapshotVersion || 0) >= 1
    && Number.isFinite(Number(order.revenueSnapshot))
    && Number.isFinite(Number(order.profitBeforeAdsSnapshot));
}

function orderRevenue(order = {}) {
  return hasProfitSnapshot(order) ? Number(order.revenueSnapshot) : Number(order.amount || 0);
}

function orderProfitBeforeAds(order = {}, fallbackProfitForOrder) {
  if (hasProfitSnapshot(order)) return Number(order.profitBeforeAdsSnapshot);
  if (typeof fallbackProfitForOrder === "function") {
    return Number(fallbackProfitForOrder(order)?.profitBeforeAds || 0);
  }
  return Number(order.amount || 0);
}

function adCostForRecord(record = {}, orders = []) {
  if (record.enabled === false) return 0;
  const matchingOrders = (Array.isArray(orders) ? orders : [])
    .filter(order => orderMatchesAdRecord(order, record));
  if (record.costMode === "percent_sales") {
    return matchingOrders.reduce((sum, order) => sum + orderRevenue(order), 0)
      * Number(record.value || 0) / 100;
  }
  if (record.costMode === "cost_per_order") {
    return matchingOrders.length * Number(record.value || 0);
  }
  return Number(record.value || 0);
}

function inPeriod(date, { date: selectedDate = "", month = "" } = {}) {
  if (selectedDate) return date === selectedDate;
  if (month) return String(date || "").startsWith(`${month}-`);
  return true;
}

function marketingPerformance({
  orders = [],
  records = [],
  date = "",
  month = "",
  fallbackProfitForOrder
} = {}) {
  const normalizedRecords = normalizeAdCostRecords(records)
    .filter(record => record.enabled && inPeriod(record.date, { date, month }));
  const periodOrders = (Array.isArray(orders) ? orders : [])
    .filter(order => inPeriod(order.date, { date, month }));
  const calculatedRecords = normalizedRecords.map(record => ({
    ...record,
    cost: adCostForRecord(record, orders)
  }));
  const sales = periodOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
  const profitBeforeAds = periodOrders.reduce(
    (sum, order) => sum + orderProfitBeforeAds(order, fallbackProfitForOrder),
    0
  );
  const adCost = calculatedRecords.reduce((sum, record) => sum + record.cost, 0);

  const productMap = new Map();
  const productKey = (productId, productName) => productId || `name:${normalizeText(productName).toLocaleLowerCase("th-TH")}`;
  for (const order of periodOrders) {
    const key = productKey(order.productId, order.items);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: normalizeText(order.productId),
        productName: normalizeText(order.items) || "ไม่ระบุสินค้า",
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    const row = productMap.get(key);
    row.sales += orderRevenue(order);
    row.orderCount += 1;
    row.profitBeforeAds += orderProfitBeforeAds(order, fallbackProfitForOrder);
  }
  for (const record of calculatedRecords) {
    const key = productKey(record.productId, record.productName);
    if (!productMap.has(key)) {
      productMap.set(key, {
        productId: record.productId,
        productName: record.productName,
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    productMap.get(key).adCost += record.cost;
  }

  const platformRecords = calculatedRecords.filter(record => Number(record.cost || 0) > 0);
  const platformMap = new Map();
  for (const record of platformRecords) {
    const key = record.platformId || `name:${record.platformName.toLocaleLowerCase("th-TH")}`;
    if (!platformMap.has(key)) {
      platformMap.set(key, {
        platformId: record.platformId,
        platformName: record.platformName,
        sales: 0,
        orderCount: 0,
        profitBeforeAds: 0,
        adCost: 0
      });
    }
    platformMap.get(key).adCost += record.cost;
  }

  const allocationGroups = new Map();
  for (const record of platformRecords) {
    const key = `${record.date}|${productKey(record.productId, record.productName)}`;
    if (!allocationGroups.has(key)) allocationGroups.set(key, []);
    allocationGroups.get(key).push(record);
  }
  for (const recordsForProductDate of allocationGroups.values()) {
    const sample = recordsForProductDate[0];
    const matchingOrders = periodOrders.filter(order => orderMatchesAdRecord(order, sample));
    const groupSales = matchingOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
    const groupProfit = matchingOrders.reduce(
      (sum, order) => sum + orderProfitBeforeAds(order, fallbackProfitForOrder),
      0
    );
    const groupCost = recordsForProductDate.reduce((sum, record) => sum + record.cost, 0);
    recordsForProductDate.forEach(record => {
      const platformKey = record.platformId || `name:${record.platformName.toLocaleLowerCase("th-TH")}`;
      const platform = platformMap.get(platformKey);
      const share = groupCost > 0 ? record.cost / groupCost : 1 / recordsForProductDate.length;
      platform.sales += groupSales * share;
      platform.profitBeforeAds += groupProfit * share;
      platform.orderCount += matchingOrders.length * share;
    });
  }

  const finishRow = row => ({
    ...row,
    profitAfterAds: row.profitBeforeAds - row.adCost,
    roas: row.adCost > 0 ? row.sales / row.adCost : 0,
    adCostPercent: row.sales > 0 ? row.adCost / row.sales * 100 : 0,
    costPerOrder: row.orderCount > 0 ? row.adCost / row.orderCount : 0
  });

  return {
    sales,
    orderCount: periodOrders.length,
    profitBeforeAds,
    adCost,
    profitAfterAds: profitBeforeAds - adCost,
    roas: adCost > 0 ? sales / adCost : 0,
    adCostPercent: sales > 0 ? adCost / sales * 100 : 0,
    costPerOrder: periodOrders.length > 0 ? adCost / periodOrders.length : 0,
    productPerformance: [...productMap.values()].map(finishRow).sort((a, b) => b.sales - a.sales),
    platformPerformance: [...platformMap.values()].map(finishRow).sort((a, b) => b.adCost - a.adCost),
    calculatedRecords
  };
}

module.exports = {
  AD_COST_MODES,
  DEFAULT_AD_PLATFORMS,
  normalizeAdPlatforms,
  normalizeAdCostRecords,
  orderMatchesAdRecord,
  adCostForRecord,
  marketingPerformance
};
