(() => {
  "use strict";

  const root = document.getElementById("platform-admin-app");
  const state = { user: null, snapshot: null, range: null, preset: "month", promos: [], promoKpis: null, promoAudit: [], promoLoading: false, promoAuditLoading: false, promoLoadingMore: false, promoAuditLoadingMore: false, promoHasMore: false, promoAuditHasMore: false, promoError: "", promoAuditError: "", promoEditingId: null, promoSaving: false, paymentFilter: "all", settings: null, menuOpen: false, loading: false, routeToken: 0, routeController: null };
  const cache = { dashboard: new Map(), endpoints: new Map(), inFlight: new Map() };
  const CACHE_TTL_MS = 45_000;
  const icons = { home: "⌂", revenue: "↗", plans: "♛", payments: "▣", usage: "⌁", companies: "▤", health: "●", promos: "◇", actions: "!", settings: "⚙" };
  const homeCardIcons = {
    revenue: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 26V18h5v8H4Zm9 0V13h5v13h-5Zm9 0V7h5v19h-5ZM4 13l7-6 5 4 9-8"/><path d="M21 3h4v4"/></svg>',
    plans: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m4 8 7 5 5-8 5 8 7-5-2 15H6L4 8Z"/><path d="M7 27h18M9 18h14"/></svg>',
    payments: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="3.5" y="6" width="25" height="19" rx="2"/><path d="M4 12h24M8 19h6"/></svg>',
    usage: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 24 11 17l5 4 8-10 4 3"/><path d="M23 11h5v5"/></svg>',
    companies: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 27V12h9v15H4Zm9 0V6h9v21h-9Zm9 0V15h6v12h-6Z"/><path d="M7 16h3m-3 4h3m6-9h3m-3 4h3m-3 4h3m6 1h2"/></svg>',
    health: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 27 7v8c0 7-4.5 11.5-11 14C9.5 26.5 5 22 5 15V7l11-4Z"/><path d="m10 16 4 4 8-9"/></svg>',
    promos: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m5 18 13-13h8v8L13 26 5 18Z"/><circle cx="21" cy="10" r="1.5"/></svg>',
    actions: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 23h16l-2-3v-7a6 6 0 0 0-12 0v7l-2 3Z"/><path d="M13 27h6"/></svg>',
    alert: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="m16 5 12 22H4L16 5Z"/><path d="M16 12v7m0 4h.01"/></svg>'
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  function today() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const map = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function shift(date, days) {
    const next = new Date(`${date}T12:00:00+07:00`);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
  }

  function monthRange(offset = 0) {
    const current = new Date(`${today()}T12:00:00+07:00`);
    current.setUTCMonth(current.getUTCMonth() + offset, 1);
    const year = current.getUTCFullYear();
    const month = String(current.getUTCMonth() + 1).padStart(2, "0");
    const start = `${year}-${month}-01`;
    const endDate = new Date(Date.UTC(year, current.getUTCMonth() + 1, 0));
    return { start, end: `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}` };
  }

  function presetRange(preset) {
    const end = today();
    if (preset === "today") return { start: end, end };
    if (preset === "yesterday") { const date = shift(end, -1); return { start: date, end: date }; }
    if (preset === "7d") return { start: shift(end, -6), end };
    return monthRange(preset === "last-month" ? -1 : 0);
  }

  function money(value) { return value === null || value === undefined ? "—" : new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(Number(value)) + " ฿"; }
  function number(value) { return value === null || value === undefined ? "—" : new Intl.NumberFormat("th-TH").format(Number(value)); }
  function dateLabel(value) { if (!value) return "—"; try { return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T12:00:00+07:00`)); } catch { return value; } }
  function statusClass(status) { return /ปกติ|success|paid|active|สำเร็จ/i.test(String(status)) ? "ok" : /มีปัญหา|failed|ไม่สำเร็จ|disabled/i.test(String(status)) ? "bad" : /ตรวจ|pending|trial/i.test(String(status)) ? "warn" : "neutral"; }
  function display(value) { return value === null || value === undefined || value === "" ? "—" : escapeHtml(value); }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { state.user = null; renderLogin("เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง"); throw new Error(payload.error || "Unauthorized"); }
    if (!response.ok) throw new Error(payload.error || "เกิดข้อผิดพลาด");
    return payload;
  }

  function cacheEntry(map, key) {
    const entry = map.get(key);
    return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry.value : null;
  }

  function dashboardCacheKey(range, preset) {
    return [preset || "month", range.start, range.end].join("|");
  }

  function abortObsoleteDashboardRequests(activeKey) {
    for (const [key, request] of cache.inFlight.entries()) {
      if (key !== activeKey) request.controller.abort();
    }
  }

  async function loadDashboard(range, preset) {
    const key = dashboardCacheKey(range, preset);
    const cached = cacheEntry(cache.dashboard, key);
    if (cached) return cached;
    const existing = cache.inFlight.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = api(`/api/platform-admin/dashboard?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`, { signal: controller.signal })
      .then(response => {
        cache.dashboard.set(key, { at: Date.now(), value: response });
        return response;
      })
      .finally(() => cache.inFlight.delete(key));
    cache.inFlight.set(key, { controller, promise });
    return promise;
  }

  async function loadCachedEndpoint(key, path, signal) {
    const cached = cacheEntry(cache.endpoints, key);
    if (cached) return cached;
    const inFlightKey = `endpoint:${key}`;
    const existing = cache.inFlight.get(inFlightKey);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = api(path, { signal: controller.signal })
      .then(response => {
        cache.endpoints.set(key, { at: Date.now(), value: response });
        return response;
      })
      .finally(() => cache.inFlight.delete(inFlightKey));
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    cache.inFlight.set(inFlightKey, { controller, promise });
    return promise;
  }

  function brand() { return `<div class="pa-brand"><img class="pa-brand-mark" src="/platform-admin/Logo%20Growup%20Pilot%284%29.png" alt="Growup Pilot"><div class="pa-brand-copy"><strong>GROWUP PILOT</strong><small>Platform Admin</small></div></div>`; }

  function renderLogin(message = "") {
    root.innerHTML = `<main class="pa-login"><section class="pa-login-panel">${brand()}<h1>เข้าสู่ระบบ</h1><p>พื้นที่ส่วนตัวสำหรับ Platform Admin เท่านั้น<br>ระบบจะตรวจสอบสิทธิ์ super_admin จากเซิร์ฟเวอร์</p><form id="pa-login-form"><div class="pa-field"><label for="pa-username">Username</label><input id="pa-username" name="username" autocomplete="username" required></div><div class="pa-field"><label for="pa-password">Password</label><input id="pa-password" name="password" type="password" autocomplete="current-password" required></div><div class="pa-error" id="pa-login-error">${escapeHtml(message)}</div><button class="pa-button" type="submit">เข้าสู่ระบบ Platform Admin</button></form></section></main>`;
    document.getElementById("pa-login-form").addEventListener("submit", async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button");
      button.disabled = true;
      document.getElementById("pa-login-error").textContent = "กำลังตรวจสอบสิทธิ์…";
      try {
        const form = new FormData(event.currentTarget);
        const response = await api("/api/platform-admin/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
        state.user = response.user || null;
        history.replaceState({}, "", "/platform-admin");
        await renderRoute();
      } catch (error) {
        document.getElementById("pa-login-error").textContent = error.message;
        button.disabled = false;
      }
    });
  }

  function navItem(path, label, icon) { return `<a class="${location.pathname === path || (path !== "/platform-admin" && location.pathname.startsWith(path)) ? "active" : ""}" href="${path}" data-route="${path}"><span class="pa-nav-icon">${icon}</span>${label}</a>`; }

  function shell(content) {
    const homeShell = location.pathname === "/platform-admin" ? " pa-home-shell" : " pa-detail-shell";
    const profileName = display(state.user?.name || "Platform Admin");
    const profileLogout = `<button class="pa-logout" data-logout title="ออกจากระบบ">↪</button>`;
    const existingShell = root.querySelector(".pa-shell");
    if (existingShell) {
      existingShell.classList.toggle("pa-home-shell", homeShell.includes("pa-home-shell"));
      existingShell.classList.toggle("pa-detail-shell", homeShell.includes("pa-detail-shell"));
      existingShell.classList.toggle("menu-open", state.menuOpen);
      const mainInner = existingShell.querySelector(".pa-main-inner");
      if (mainInner) {
        mainInner.innerHTML = content;
        mainInner.removeAttribute("aria-busy");
      }
      root.querySelectorAll(".pa-nav [data-route]").forEach(link => link.classList.toggle("active", link.dataset.route === "/platform-admin" ? location.pathname === "/platform-admin" : location.pathname.startsWith(link.dataset.route)));
    } else {
      root.innerHTML = `<div class="pa-shell${homeShell} ${state.menuOpen ? "menu-open" : ""}"><aside class="pa-sidebar">${brand()}<nav class="pa-nav">${navItem("/platform-admin", "หน้าหลัก", icons.home)}${navItem("/platform-admin/settings", "ตั้งค่า", icons.settings)}</nav><div class="pa-user"><span class="pa-avatar">${escapeHtml((state.user?.name || "Platform Admin").slice(0, 1))}</span><div><strong>${profileName}</strong><small>Platform Admin</small></div>${profileLogout}</div></aside><main class="pa-main"><div class="pa-mobile-bar"><button class="pa-menu-button" data-menu>☰</button>${brand()}<span></span></div><div class="pa-main-inner">${content}</div></main></div>`;
    }
    bindCommon();
  }

  function bindCommon() {
    if (root.dataset.eventsBound) return;
    root.dataset.eventsBound = "true";
    root.addEventListener("click", async event => {
      const link = event.target.closest("[data-route]");
      if (link && root.contains(link)) { event.preventDefault(); await navigate(link.dataset.route); return; }
      if (event.target.closest("[data-logout]")) {
        await api("/api/platform-admin/logout", { method: "POST", body: "{}" }).catch(() => {});
        state.user = null;
        history.replaceState({}, "", "/platform-admin/login");
        renderLogin();
        return;
      }
      if (event.target.closest("[data-menu]")) {
        state.menuOpen = !state.menuOpen;
        root.querySelector(".pa-shell")?.classList.toggle("menu-open", state.menuOpen);
      }
    });
  }

  async function navigate(path) {
    state.menuOpen = false;
    state.routeToken += 1;
    state.routeController?.abort();
    state.routeController = null;
    history.pushState({}, "", path);
    await renderRoute();
  }

  function pageHead(title, subtitle = "") { return `<div class="pa-breadcrumb"><span>หน้าหลัก</span>　›　${escapeHtml(title)}</div><div class="pa-page-head"><div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div></div>`; }
  function cardMetric(label, value, color = "") { return `<div><dt>${escapeHtml(label)}</dt><dd class="${color}">${display(value)}</dd></div>`; }
  function alertCardMetric(label, value) { return `<div class="pa-home-alert-row"><span class="pa-home-alert-icon">${homeCardIcons.alert}</span><dt>${escapeHtml(label)}</dt><dd class="is-red">${display(value)}</dd></div>`; }
  function card(title, icon, rows, route, tone = "") { return `<article class="pa-card"><div class="pa-card-head"><span class="pa-card-icon ${tone}">${icon}</span><h2>${escapeHtml(title)}</h2></div><dl>${rows.join("")}</dl><button class="pa-card-link" data-route="${route}">ดูรายละเอียด <span>›</span></button></article>`; }

  function home(snapshot) {
    const h = snapshot.home;
    return `<div class="pa-page-head pa-home-page-head"><div><h1>หน้าหลัก</h1></div></div><section class="pa-card-grid pa-home-card-grid">
      ${card("รายได้", homeCardIcons.revenue, [cardMetric("รายได้วันนี้", h.revenue.today, "is-green"), cardMetric("รายได้เดือนนี้", h.revenue.month, "is-green"), cardMetric("รายได้ทั้งหมด", h.revenue.total, "is-green")], "/platform-admin/revenue", "green")}
      ${card("แพ็กเกจสมาชิก", homeCardIcons.plans, [cardMetric("Starter", h.plans.Starter, "is-purple"), cardMetric("Business", h.plans.Business, "is-purple"), cardMetric("Enterprise", h.plans.Enterprise, "is-purple")], "/platform-admin/plans", "purple")}
      ${card("การชำระเงิน", homeCardIcons.payments, [cardMetric("MRR", h.payments.mrr, "is-green"), cardMetric("ชำระไม่สำเร็จ", h.payments.failed, "is-red"), cardMetric("รอบบิลวันนี้", h.payments.billingToday, "is-green")], "/platform-admin/payments", "green")}
      ${card("การใช้งานของลูกค้า", homeCardIcons.usage, [cardMetric("เข้าใช้งานวันนี้", h.usage.activeCompanies, "is-orange"), cardMetric("ออเดอร์วันนี้", h.usage.ordersToday, "is-blue"), cardMetric("ไม่ได้ใช้งานเกิน 14 วัน", h.usage.inactiveCompanies, "is-orange")], "/platform-admin/usage", "orange")}
      ${card("ลูกค้า / บริษัท", homeCardIcons.companies, [cardMetric("ทั้งหมด", h.companies.total, "is-blue"), cardMetric("Active", h.companies.active, "is-blue"), cardMetric("Trial", h.companies.trial, "is-blue")], "/platform-admin/companies", "")}
      ${card("สถานะระบบ", homeCardIcons.health, [cardMetric("LINE", h.health.line, "is-green"), cardMetric("Stripe", h.health.stripe, "is-green"), cardMetric("Supabase", h.health.supabase, "is-green")], "/platform-admin/health", "green")}
      ${card("โค้ดส่วนลด / Promo", homeCardIcons.promos, [cardMetric("โค้ดที่ใช้งานอยู่", h.promos.active, "is-orange"), cardMetric("ใช้ไปแล้ว", h.promos.used, "is-orange"), cardMetric("เหลือใช้ / ไม่จำกัด", h.promos.remaining, "is-orange")], "/platform-admin/promos", "orange")}
      ${card("สิ่งที่ต้องจัดการ", homeCardIcons.actions, [alertCardMetric("Payment Failed", h.actions.paymentFailed), alertCardMetric("Trial ใกล้หมด", h.actions.trialExpiring), alertCardMetric("LINE ไม่เชื่อม", h.actions.lineDisconnected)], "/platform-admin/actions", "red")}
    </section>`;
  }

  function homeLoading() {
    return home({ home: {
      revenue: { today: null, month: null, total: null },
      plans: { Starter: null, Business: null, Enterprise: null },
      payments: { mrr: null, failed: null, billingToday: null },
      usage: { activeCompanies: null, ordersToday: null, inactiveCompanies: null },
      companies: { total: null, active: null, trial: null },
      health: { line: null, stripe: null, supabase: null },
      promos: { active: null, used: null, remaining: null },
      actions: { paymentFailed: null, trialExpiring: null, lineDisconnected: null }
    }}).replace('class="pa-card-grid pa-home-card-grid"', 'class="pa-card-grid pa-home-card-grid" aria-busy="true"');
  }

  function dateToolbar() { const range = state.range || presetRange(state.preset); return `<div class="pa-toolbar"><div class="pa-date-tabs">${[["today", "วันนี้"], ["yesterday", "เมื่อวาน"], ["7d", "7 วันล่าสุด"], ["month", "เดือนนี้"], ["last-month", "เดือนที่แล้ว"], ["custom", "กำหนดเอง"]].map(([key, label]) => `<button class="pa-date-tab ${state.preset === key ? "active" : ""}" data-preset="${key}">${label}</button>`).join("")}</div>${state.preset === "custom" ? `<div class="pa-custom-dates"><input type="date" id="pa-start" value="${range.start}"><input type="date" id="pa-end" value="${range.end}"><button class="pa-button" data-apply-range>ใช้ช่วงวันที่</button></div>` : ""}<span class="pa-muted">${dateLabel(range.start)} – ${dateLabel(range.end)} · Asia/Bangkok</span></div>`; }

  function transactionTable(rows = [], options = {}) { if (!rows.length) return `<div class="pa-empty">ไม่มีข้อมูลการชำระเงินที่เชื่อถือได้ในช่วงที่เลือก</div>`; return `<div class="pa-table-wrap"><table class="pa-table"><thead><tr><th>เวลา</th><th>บริษัท</th><th>แพ็กเกจ</th><th>จำนวนเงิน</th><th>ช่องทาง</th><th>สถานะ</th>${options.actions ? "<th>จัดการ</th>" : ""}</tr></thead><tbody>${rows.map(row => `<tr ${options.paymentRows ? `data-payment-row data-payment-status="${escapeHtml(paymentStatusLabel(row.status))}"` : ""}><td>${dateLabel(String(row.timestamp || "").slice(0, 10))}</td><td><strong>${display(row.company)}</strong></td><td>${display(row.plan)}</td><td>${money(row.amount)}</td><td>${display(row.method)}</td><td><span class="pa-status ${statusClass(row.status)}">${display(row.status)}</span></td>${options.actions ? `<td><button class="pa-table-action" type="button">ดูรายละเอียด</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`; }

  function paymentStatusLabel(value) {
    const text = String(value || "").toLowerCase();
    if (/fail|ไม่สำเร็จ|cancel/.test(text)) return "failed";
    if (/pending|process|รอดำเนินการ/.test(text)) return "pending";
    if (/paid|success|complete|ชำระแล้ว/.test(text)) return "paid";
    return "other";
  }

  function rangeChart(snapshot) {
    const rows = snapshot.revenue.transactions || [];
    if (!rows.length) return `<div class="pa-chart pa-chart-empty"><div class="pa-empty">ไม่มีข้อมูลกราฟในช่วงที่เลือก</div></div>`;
    const start = new Date(`${snapshot.range.start}T12:00:00+07:00`);
    const end = new Date(`${snapshot.range.end}T12:00:00+07:00`);
    const span = Math.max(1, Math.ceil((end - start) / 86400000) + 1);
    const bucketCount = Math.min(7, span);
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({ date: shift(snapshot.range.start, Math.floor((index * span) / bucketCount)), value: 0 }));
    rows.forEach(row => { const date = new Date(`${dateOnlyLabel(row.timestamp)}T12:00:00+07:00`); const offset = Math.max(0, Math.floor((date - start) / 86400000)); const bucketIndex = Math.min(bucketCount - 1, Math.floor((offset / span) * bucketCount)); if (Number.isFinite(Number(row.amount))) buckets[bucketIndex].value += Number(row.amount); });
    const max = Math.max(...buckets.map(item => item.value), 1);
    return `<div class="pa-chart pa-chart-data">${buckets.map(item => `<div class="pa-bar"><i style="height:${item.value ? Math.max(10, (item.value / max) * 100) : 4}%"></i><small>${dateLabel(item.date)}</small></div>`).join("")}</div>`;
  }

  function dateOnlyLabel(value) { return String(value || "").slice(0, 10); }

  function packageDistribution(snapshot) {
    const rows = snapshot.revenue.transactions || [];
    const counts = Object.fromEntries(["Starter", "Business", "Enterprise"].map(plan => [plan, 0]));
    rows.forEach(row => { const key = Object.keys(counts).find(plan => plan.toLowerCase() === String(row.plan || "").toLowerCase()); if (key) counts[key] += 1; });
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    if (!total) return `<div class="pa-distribution-empty">ไม่มีข้อมูลแพ็กเกจในช่วงที่เลือก</div>`;
    let cursor = 0;
    const colors = { Starter: "#42c99b", Business: "#4b75e8", Enterprise: "#6654db" };
    const stops = Object.entries(counts).map(([plan, value]) => { const start = (cursor / total) * 100; cursor += value; return `${colors[plan]} ${start}% ${(cursor / total) * 100}%`; }).join(", ");
    return `<div class="pa-distribution"><div class="pa-donut" style="background:conic-gradient(${stops})"></div><ul>${Object.entries(counts).map(([plan, value]) => `<li><span><i style="background:${colors[plan]}"></i>${plan}</span><strong>${value} (${Math.round((value / total) * 100)}%)</strong></li>`).join("")}</ul></div>`;
  }

  function detailPage(kind, snapshot) {
    const isRevenue = kind === "revenue";
    const metrics = isRevenue ? [["รายได้รวม", money(snapshot.revenue.gross), "green"], ["จำนวนบริษัท", number(snapshot.revenue.payingCompanies), ""], ["ชำระสำเร็จ", number(snapshot.revenue.successfulPayments), ""], ["MRR", money(snapshot.revenue.mrrSnapshot), "orange"]] : [["ชำระสำเร็จ", number(snapshot.payments.successful), "green"], ["ชำระไม่สำเร็จ", number(snapshot.payments.failed), "red"], ["รอดำเนินการ", number(snapshot.payments.pending), "orange"], ["ยอดเรียกเก็บ", money(snapshot.payments.collected), "green"]];
    const paymentTabs = isRevenue ? "" : `<div class="pa-status-tabs"><button class="pa-status-tab ${state.paymentFilter === "all" ? "active" : ""}" data-payment-filter="all">รายการทั้งหมด</button><button class="pa-status-tab ${state.paymentFilter === "paid" ? "active" : ""}" data-payment-filter="paid">ชำระแล้ว</button><button class="pa-status-tab ${state.paymentFilter === "pending" ? "active" : ""}" data-payment-filter="pending">รอดำเนินการ</button><button class="pa-status-tab ${state.paymentFilter === "failed" ? "active" : ""}" data-payment-filter="failed">ไม่สำเร็จ</button></div>`;
    return `${pageHead(isRevenue ? "รายได้ - รายละเอียด" : "การชำระเงิน - รายละเอียด", "ข้อมูลจากรายการชำระเงินที่มีอยู่จริง")}${dateToolbar()}<section class="pa-kpi-row">${metrics.map(metric => `<div class="pa-kpi ${metric[2]}"><small>${metric[0]}</small><strong>${metric[1]}</strong></div>`).join("")}</section><section class="pa-detail-grid pa-revenue-detail" style="margin-top:14px"><div class="pa-panel"><div class="pa-section-head"><div><h2>${isRevenue ? "รายได้ตามช่วงเวลา" : "รายการชำระเงิน"}</h2><p class="pa-panel-subtitle">ช่วงที่เลือก: ${dateLabel(snapshot.range.start)} – ${dateLabel(snapshot.range.end)}</p></div></div>${isRevenue ? rangeChart(snapshot) : paymentTabs}</div><div class="pa-panel"><div class="pa-section-head"><h2>${isRevenue ? "สัดส่วนแพ็กเกจ" : "สถานะการชำระเงิน"}</h2></div>${isRevenue ? packageDistribution(snapshot) : `<div class="pa-payment-summary"><strong>${number(snapshot.payments.successful)}</strong><span>ชำระสำเร็จในช่วงที่เลือก</span></div>`}</div><div class="pa-panel wide"><div class="pa-section-head"><div><h2>${isRevenue ? "รายการรายได้ล่าสุด" : "รายการธุรกรรม"}</h2><p class="pa-panel-subtitle">ใช้ timestamp ของรายการเป็นตัวกรอง · Asia/Bangkok</p></div></div>${transactionTable(isRevenue ? snapshot.revenue.transactions : snapshot.payments.transactions, { paymentRows: !isRevenue })}</div></section>`;
  }

  function companiesPage(snapshot) { const plans = ["Starter", "Business", "Enterprise"]; return `${pageHead("ลูกค้า / บริษัท", "ข้อมูลบริษัทจาก tenant source แบบอ่านอย่างเดียว")}${snapshot.companies.length ? `<div class="pa-filter-pills"><button class="pa-filter-pill active" data-company-status-pill="">ทั้งหมด ${number(snapshot.companies.length)}</button><button class="pa-filter-pill" data-company-status-pill="Active">Active ${number(snapshot.companies.filter(item => item.subscriptionStatus.toLowerCase() === "active").length)}</button><button class="pa-filter-pill" data-company-status-pill="Trial">Trial ${number(snapshot.companies.filter(item => item.subscriptionStatus.toLowerCase() === "trial").length)}</button><button class="pa-filter-pill" data-company-status-pill="Inactive">Inactive</button></div><div class="pa-toolbar pa-table-toolbar"><input id="pa-company-search" placeholder="ค้นหาบริษัท / Tenant ID"><select id="pa-company-plan"><option value="">ทุกแพ็กเกจ</option>${plans.map(plan => `<option>${plan}</option>`).join("")}</select><select id="pa-company-status"><option value="">ทุกสถานะ</option><option>Active</option><option>Trial</option><option>Inactive</option></select></div><div class="pa-panel"><div class="pa-table-wrap"><table class="pa-table" id="pa-companies-table"><thead><tr><th>บริษัท / Owner</th><th>แพ็กเกจ</th><th>สถานะ</th><th>สมัครเมื่อ</th><th>ผู้ใช้</th><th>ออเดอร์</th><th>Last Active</th><th>จัดการ</th></tr></thead><tbody>${snapshot.companies.map(company => `<tr data-company-row data-search="${escapeHtml(`${company.name} ${company.id} ${company.owner}`)}" data-status="${escapeHtml(company.subscriptionStatus)}" data-plan="${escapeHtml(company.plan)}"><td><strong>${display(company.name)}</strong><br><small class="pa-muted">${display(company.owner)}</small></td><td>${display(company.plan)}</td><td><span class="pa-status ${statusClass(company.subscriptionStatus)}">${display(company.subscriptionStatus)}</span></td><td>${dateLabel(company.signupDate)}</td><td>${number(company.userCount)}</td><td>${number(company.orders)}</td><td>${dateLabel(company.lastActive)}</td><td><button class="pa-table-action" type="button">ดูรายละเอียด</button></td></tr>`).join("")}</tbody></table></div></div>` : `<div class="pa-panel"><div class="pa-empty">ไม่มีข้อมูลบริษัท/tenant ที่เชื่อถือได้ในแหล่งข้อมูลปัจจุบัน<br><small>schema ที่ตรวจพบยังไม่มีตาราง tenants สำหรับ Platform Admin</small></div></div>`}`; }

  function plansPage(snapshot) { const counts = snapshot.plans.counts; const total = Number(snapshot.plans.total || 0); const rows = ["Starter", "Business", "Enterprise"].map(plan => ({ plan, count: Number(counts[plan] || 0), percent: total ? `${((Number(counts[plan] || 0) / total) * 100).toFixed(1)}%` : "—", mrr: "—" })); return `${pageHead("แพ็กเกจสมาชิก", "ภาพรวมแพ็กเกจและสัดส่วนบริษัทแบบอ่านอย่างเดียว")}<section class="pa-plan-summary">${rows.map(row => `<div class="pa-plan-card"><small>${row.plan}</small><strong>${number(row.count)}</strong><span>บริษัท</span></div>`).join("")}</section><div class="pa-panel pa-plan-table-panel"><div class="pa-section-head"><div><h2>รายละเอียดแพ็กเกจ</h2><p class="pa-panel-subtitle">ไม่เปลี่ยน subscription และไม่คำนวณค่าที่ไม่มีแหล่งข้อมูล</p></div></div><div class="pa-table-wrap"><table class="pa-table"><thead><tr><th>แพ็กเกจ</th><th>จำนวนบริษัท</th><th>สัดส่วน</th><th>MRR</th><th>จัดการ</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${row.plan}</strong></td><td>${number(row.count)}</td><td>${row.percent}</td><td>${row.mrr}</td><td><button class="pa-table-action" type="button">ดูรายละเอียด</button></td></tr>`).join("")}<tr class="pa-total-row"><td><strong>รวมทั้งหมด</strong></td><td>${number(total)}</td><td>100%</td><td>—</td><td>—</td></tr></tbody></table></div></div>`; }

  function usagePage(snapshot) { return `${pageHead("การใช้งานของลูกค้า", "ภาพรวม activity และ order records ที่มีอยู่แล้ว")}<section class="pa-kpi-row"><div class="pa-kpi orange"><small>เข้าใช้งานวันนี้</small><strong>${number(snapshot.usage.activeCompanies)}</strong></div><div class="pa-kpi blue"><small>ผู้ใช้งานวันนี้</small><strong>${number(snapshot.usage.activeUsers)}</strong></div><div class="pa-kpi purple"><small>Logins วันนี้</small><strong>${number(snapshot.usage.loginsToday)}</strong></div><div class="pa-kpi orange"><small>ออเดอร์วันนี้</small><strong>${number(snapshot.usage.ordersToday)}</strong></div></section><div class="pa-filter-pills"><button class="pa-filter-pill active">7 วันล่าสุด</button><button class="pa-filter-pill">ผู้ใช้งาน</button><button class="pa-filter-pill">ออเดอร์</button></div><section class="pa-detail-grid pa-usage-layout"><div class="pa-panel wide"><div class="pa-section-head"><div><h2>การใช้งานในช่วงล่าสุด</h2><p class="pa-panel-subtitle">ใช้ข้อมูล activity source เท่านั้น · Asia/Bangkok</p></div></div><div class="pa-usage-chart"><div class="pa-chart-axis"><span>สูง</span><span>กลาง</span><span>ต่ำ</span></div><div class="pa-empty">${snapshot.usage.activeUsers === null && snapshot.usage.ordersToday === null ? "ไม่มีข้อมูลการใช้งานรายวันในแหล่งข้อมูลปัจจุบัน" : "ข้อมูลรายวันยังไม่เพียงพอสำหรับกราฟ"}</div></div></div><div class="pa-panel wide"><div class="pa-section-head"><div><h2>ไม่ได้ใช้งานเกิน 14 วัน</h2><p class="pa-panel-subtitle">เทียบกับวันที่ปัจจุบันใน Asia/Bangkok</p></div></div>${snapshot.usage.inactiveCompanies.length ? `<ul class="pa-list">${snapshot.usage.inactiveCompanies.map(company => `<li><span>${display(company.name)}</span><span class="pa-muted">${dateLabel(company.lastActive)}</span></li>`).join("")}</ul>` : `<div class="pa-empty">ไม่มีข้อมูล inactive companies ที่เชื่อถือได้</div>`}</div></section>`; }

  function healthPage(snapshot) { const services = [[homeCardIcons.health, "LINE", snapshot.home.health.line], [homeCardIcons.payments, "Stripe", snapshot.home.health.stripe], [homeCardIcons.health, "Supabase", snapshot.home.health.supabase], [homeCardIcons.companies, "Production", "ควรตรวจสอบ"]]; return `${pageHead("สถานะระบบ", "ตรวจสอบแบบอ่านอย่างเดียว · ไม่ส่ง event ไม่สร้างธุรกรรม") }<div class="pa-panel pa-health-panel"><ul class="pa-health-list">${services.map(([icon, name, status]) => `<li><span class="pa-health-icon">${icon}</span><span class="pa-health-name"><strong>${name}</strong><small>last successful check</small></span><span class="pa-status ${statusClass(status)}">${status}</span><span class="pa-muted">ไม่มีข้อมูลเวลา</span></li>`).join("")}</ul><div class="pa-note">ไม่แสดง secret/token ใด ๆ และไม่ทำ active probe ที่อาจกระทบ Payment หรือ LINE</div></div>`; }

  function promoTypeLabel(type) {
    return ({ percentage: "เปอร์เซ็นต์", fixed_thb: "ลดเป็น THB", free_days: "ฟรี X วัน", free_months: "ฟรี X เดือน" })[type] || type || "—";
  }

  function promoValueFieldConfig(type) {
    return ({
      percentage: { label: "ส่วนลด (%)", placeholder: "เช่น 10", min: "0.01", max: "100", step: "0.01", inputmode: "decimal", message: "กรุณาระบุส่วนลดมากกว่า 0 และไม่เกิน 100%" },
      fixed_thb: { label: "ส่วนลด (บาท)", placeholder: "เช่น 500", min: "0.01", max: "", step: "0.01", inputmode: "decimal", message: "กรุณาระบุจำนวนเงินมากกว่า 0 บาท" },
      free_days: { label: "จำนวนวัน", placeholder: "เช่น 7", min: "1", max: "", step: "1", inputmode: "numeric", message: "กรุณาระบุจำนวนวันเป็นจำนวนเต็มอย่างน้อย 1 วัน" },
      free_months: { label: "จำนวนเดือน", placeholder: "เช่น 1", min: "1", max: "", step: "1", inputmode: "numeric", message: "กรุณาระบุจำนวนเดือนเป็นจำนวนเต็มอย่างน้อย 1 เดือน" }
    })[type] || null;
  }

  function promoValueValidationMessage(type, rawValue) {
    const config = promoValueFieldConfig(type) || promoValueFieldConfig("percentage");
    const value = Number(String(rawValue ?? "").trim());
    if (!Number.isFinite(value) || value <= 0) return config.message;
    if (type === "percentage" && value > 100) return config.message;
    if (["free_days", "free_months"].includes(type) && !Number.isInteger(value)) return config.message;
    return "";
  }

  function applyPromoValueFieldType(form, reportInvalid = false) {
    const type = String(form?.elements?.type?.value || "percentage");
    const config = promoValueFieldConfig(type) || promoValueFieldConfig("percentage");
    const input = form?.elements?.value;
    const label = form?.querySelector("[data-promo-value-label]");
    if (!input) return;
    if (label) label.textContent = config.label;
    input.placeholder = config.placeholder;
    input.min = config.min;
    input.step = config.step;
    input.inputMode = config.inputmode;
    if (config.max) input.max = config.max;
    else input.removeAttribute("max");
    input.setCustomValidity(promoValueValidationMessage(type, input.value));
    if (reportInvalid && input.value && !input.checkValidity()) input.reportValidity();
  }

  function promoListHtml() {
    if (state.promoLoading && !state.promos.length) return `<div class="pa-empty">กำลังโหลด Promo…</div>`;
    if (state.promoError && !state.promos.length) return `<div class="pa-empty">${escapeHtml(state.promoError)}</div>`;
    if (!state.promos.length) return `<div class="pa-empty">ยังไม่มี Promo</div>`;
    const table = `<div class="pa-table-wrap"><table class="pa-table"><thead><tr><th>Code</th><th>ส่วนลด</th><th>ประเภท</th><th>ใช้แล้ว / จำกัด</th><th>หมดอายุ</th><th>สถานะ</th><th>จัดการ</th></tr></thead><tbody>${state.promos.map(promo => `<tr><td><strong>${display(promo.code)}</strong><br><small class="pa-muted">${display(promo.description)}</small></td><td>${number(promo.value)}</td><td>${escapeHtml(promoTypeLabel(promo.type))}</td><td>${number(promo.usedCount)} / ${promo.usageLimit === null ? "ไม่จำกัด" : number(promo.usageLimit)}</td><td>${promo.noExpiry ? "ไม่หมดอายุ" : dateLabel(String(promo.expiresAt || "").slice(0, 10))}</td><td><span class="pa-status ${statusClass(promo.status)}">${display(promo.status)}</span></td><td><div class="pa-promo-actions"><button class="pa-table-action" type="button" data-edit-promo="${escapeHtml(promo.id)}">แก้ไข</button><button class="pa-table-action ${promo.active ? "danger" : ""}" type="button" data-promo-status="${escapeHtml(promo.id)}" data-active="${promo.active ? "false" : "true"}">${promo.active ? "ปิดใช้งาน" : "เปิดใช้งาน"}</button></div></td></tr>`).join("")}</tbody></table></div>`;
    const more = state.promoHasMore ? `<div class="pa-pagination"><span>แสดง ${number(state.promos.length)} รายการ</span><button class="pa-button secondary" type="button" data-promo-load-more ${state.promoLoadingMore ? "disabled" : ""}>${state.promoLoadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}</button></div>` : "";
    return `${table}${more}`;
  }

  function promoAuditHtml() {
    if (state.promoAuditLoading && !state.promoAudit.length) return "กำลังโหลด Audit Log…";
    if (state.promoAuditError) return escapeHtml(state.promoAuditError);
    if (!state.promoAudit.length) return "ยังไม่มี Audit Log";
    const rows = state.promoAudit.map(log => `${escapeHtml(log.action)} · ${escapeHtml(log.code || log.promoId)} · ${escapeHtml(log.actor)} · ${dateLabel(String(log.at || "").slice(0, 10))}${log.changedFields?.length ? ` · ${escapeHtml(log.changedFields.join(", "))}` : ""}`).join("<br>");
    return `${rows}${state.promoAuditHasMore ? `<div class="pa-pagination"><span>แสดง ${number(state.promoAudit.length)} รายการ</span><button class="pa-button secondary" type="button" data-promo-audit-load-more ${state.promoAuditLoadingMore ? "disabled" : ""}>${state.promoAuditLoadingMore ? "กำลังโหลด…" : "โหลด Audit เพิ่ม"}</button></div>` : ""}`;
  }

  function promoPage() {
    const editing = state.promos.find(item => item.id === state.promoEditingId) || null;
    const form = editing || { code: "", type: "percentage", value: "", usageLimit: null, usagePerCompany: 1, description: "", startsAt: "", expiresAt: "", noExpiry: true, newCustomersOnly: false, plans: ["starter", "business", "enterprise"] };
    const kpis = state.promoKpis || { active: null, used: null, total: null };
    const selected = value => form.type === value ? "selected" : "";
    const checked = value => form.plans.includes(value) ? "checked" : "";
    const disabled = state.promoSaving ? "disabled" : "";
    const listContent = promoListHtml();
    const valueField = promoValueFieldConfig(form.type) || promoValueFieldConfig("percentage");
    return `${pageHead("โค้ดส่วนลด / Promo", "ข้อมูลจริงจาก Preview Supabase พร้อม Audit Log")}
      <div class="pa-promo-heading"><div class="pa-stat-strip"><div><small>โค้ดที่ใช้งานอยู่</small><strong>${number(kpis.active)}</strong></div><div><small>ใช้ไปแล้ว</small><strong>${number(kpis.used)}</strong></div><div><small>โค้ดทั้งหมด</small><strong>${number(kpis.total)}</strong></div></div><button class="pa-button" type="button" data-new-promo>+ สร้างโค้ดใหม่</button></div>
      <div class="pa-panel pa-promo-form-panel"><form id="pa-promo-form" class="pa-promo-form" data-promo-id="${escapeHtml(editing?.id || "")}">
        <div class="pa-field"><label>Code</label><input name="code" required maxlength="64" placeholder="WELCOME10" value="${escapeHtml(form.code)}" ${disabled}></div>
        <div class="pa-field"><label>ประเภท</label><select name="type" ${disabled}><option value="percentage" ${selected("percentage")}>เปอร์เซ็นต์</option><option value="fixed_thb" ${selected("fixed_thb")}>ลดเป็น THB</option><option value="free_days" ${selected("free_days")}>ฟรี X วัน</option><option value="free_months" ${selected("free_months")}>ฟรี X เดือน</option></select></div>
        <div class="pa-field"><label data-promo-value-label>${valueField.label}</label><input name="value" type="number" min="${valueField.min}" ${valueField.max ? `max="${valueField.max}"` : ""} step="${valueField.step}" inputmode="${valueField.inputmode}" placeholder="${valueField.placeholder}" required value="${escapeHtml(form.value)}" ${disabled}></div>
        <div class="pa-field"><label>จำนวนครั้งที่ใช้ได้ทั้งหมด</label><input name="usageLimit" inputmode="numeric" placeholder="ไม่จำกัด" value="${form.usageLimit === null ? "" : escapeHtml(form.usageLimit)}" ${disabled}></div>
        <div class="pa-field span-2"><label>คำอธิบาย</label><input name="description" maxlength="500" value="${escapeHtml(form.description)}" ${disabled}></div>
        <div class="pa-field"><label>เริ่มใช้</label><input name="startsAt" type="date" value="${escapeHtml(String(form.startsAt || "").slice(0, 10))}" ${disabled}></div>
        <div class="pa-field"><label>หมดอายุ</label><input name="expiresAt" type="date" value="${escapeHtml(String(form.expiresAt || "").slice(0, 10))}" ${form.noExpiry ? "disabled" : disabled}></div>
        <div class="pa-field"><label>จำนวนครั้งที่ใช้ได้ต่อบริษัท</label><input name="usagePerCompany" inputmode="numeric" placeholder="ไม่จำกัด" value="${form.usagePerCompany === null ? "" : escapeHtml(form.usagePerCompany)}" ${disabled}></div>
        <div class="pa-field pa-promo-plans"><label>แพ็กเกจ</label><span><label><input type="checkbox" name="plans" value="starter" ${checked("starter")} ${disabled}> Starter</label><label><input type="checkbox" name="plans" value="business" ${checked("business")} ${disabled}> Business</label><label><input type="checkbox" name="plans" value="enterprise" ${checked("enterprise")} ${disabled}> Enterprise</label></span></div>
        <label class="pa-switch"><input name="noExpiry" type="checkbox" ${form.noExpiry ? "checked" : ""} ${disabled}> ไม่หมดอายุ</label>
        <label class="pa-switch"><input name="newCustomersOnly" type="checkbox" ${form.newCustomersOnly ? "checked" : ""} ${disabled}> ลูกค้าใหม่เท่านั้น</label>
        <div class="pa-promo-form-actions"><button class="pa-button" type="submit" ${disabled}>${state.promoSaving ? "กำลังบันทึก…" : editing ? "บันทึกการแก้ไข" : "บันทึก Promo"}</button>${editing ? `<button class="pa-button secondary" type="button" data-cancel-promo-edit>ยกเลิก</button>` : ""}</div>
      </form></div>
      <div class="pa-panel pa-promo-table-panel"><div class="pa-section-head"><div><h2>รายการ Promo</h2><p class="pa-panel-subtitle">การปิดใช้งานไม่ลบ redemption เดิม</p></div></div><div data-promo-list>${listContent}</div></div>
      <div class="pa-panel pa-audit-panel"><h2>Audit Log</h2><p class="pa-panel-subtitle">โหลดแยกจากรายการ Promo เพื่อไม่บล็อกหน้า</p><div class="pa-note" data-promo-audit>${promoAuditHtml()}</div></div>`;
  }

  function refreshPromoView(token) {
    if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
    shell(promoPage());
    bindRouteActions();
  }

  function refreshPromoListView(token) {
    if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
    const list = root.querySelector("[data-promo-list]");
    if (list) { list.innerHTML = promoListHtml(); bindPromoListActions(); }
  }

  function refreshPromoAuditView(token) {
    if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
    const audit = root.querySelector("[data-promo-audit]");
    if (audit) { audit.innerHTML = promoAuditHtml(); bindPromoAuditActions(); }
  }

  function bindPromoListActions() {
    root.querySelectorAll("[data-edit-promo]").forEach(button => button.addEventListener("click", () => { state.promoEditingId = button.dataset.editPromo; refreshPromoView(state.routeToken); root.querySelector("#pa-promo-form input[name=code]")?.focus(); }));
    root.querySelectorAll("[data-promo-status]").forEach(button => button.addEventListener("click", async () => {
      const active = button.dataset.active === "true";
      if (!confirm(active ? "เปิดใช้งาน Promo นี้หรือไม่?" : "ปิดใช้งาน Promo นี้หรือไม่?")) return;
      try {
        button.disabled = true;
        await api(`/api/platform-admin/promos/${encodeURIComponent(button.dataset.promoStatus)}/status`, { method: "PUT", body: JSON.stringify({ active }) });
        cache.endpoints.delete("promos:0");
        cache.endpoints.delete("promo-audit:0");
        showToast(active ? "เปิดใช้งาน Promo แล้ว" : "ปิดใช้งาน Promo แล้ว");
        await renderRoute();
      } catch (error) { button.disabled = false; showToast(error.message); }
    }));
    root.querySelector("[data-promo-load-more]")?.addEventListener("click", async () => {
      if (state.promoLoadingMore) return;
      const token = state.routeToken;
      const offset = state.promos.length;
      state.promoLoadingMore = true;
      refreshPromoListView(token);
      try {
        const data = await loadCachedEndpoint(`promos:${offset}`, `/api/platform-admin/promos?limit=25&offset=${offset}`, state.routeController?.signal);
        if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
        state.promos = [...state.promos, ...(data.promos || [])];
        state.promoHasMore = Boolean(data.pagination?.hasMore);
      } catch (error) {
        if (error?.name !== "AbortError" && token === state.routeToken) showToast(error.message || "โหลด Promo ไม่สำเร็จ");
      } finally {
        state.promoLoadingMore = false;
        refreshPromoListView(token);
      }
    });
  }

  function bindPromoAuditActions() {
    root.querySelector("[data-promo-audit-load-more]")?.addEventListener("click", async () => {
      if (state.promoAuditLoadingMore) return;
      const token = state.routeToken;
      const offset = state.promoAudit.length;
      state.promoAuditLoadingMore = true;
      refreshPromoAuditView(token);
      try {
        const data = await loadCachedEndpoint(`promo-audit:${offset}`, `/api/platform-admin/promos/audit?limit=20&offset=${offset}`, state.routeController?.signal);
        if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
        state.promoAudit = [...state.promoAudit, ...(data.auditLog || [])];
        state.promoAuditHasMore = Boolean(data.pagination?.hasMore);
      } catch (error) {
        if (error?.name !== "AbortError" && token === state.routeToken) showToast(error.message || "โหลด Audit Log ไม่สำเร็จ");
      } finally {
        state.promoAuditLoadingMore = false;
        refreshPromoAuditView(token);
      }
    });
  }

  function beginPromoLoads(token, controller) {
    state.promos = [];
    state.promoKpis = null;
    state.promoAudit = [];
    state.promoLoading = true;
    state.promoAuditLoading = true;
    state.promoLoadingMore = false;
    state.promoAuditLoadingMore = false;
    state.promoHasMore = false;
    state.promoAuditHasMore = false;
    state.promoError = "";
    state.promoAuditError = "";
    loadCachedEndpoint("promos:0", "/api/platform-admin/promos?limit=25&offset=0", controller.signal).then(data => {
      if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
      state.promos = data.promos || [];
      state.promoKpis = data.kpis || null;
      state.promoHasMore = Boolean(data.pagination?.hasMore);
      state.promoLoading = false;
      refreshPromoView(token);
    }).catch(error => {
      if (error?.name === "AbortError" || token !== state.routeToken) return;
      state.promoLoading = false;
      state.promoError = error.message || "โหลด Promo ไม่สำเร็จ";
      refreshPromoView(token);
    });
    const loadAudit = () => loadCachedEndpoint("promo-audit:0", "/api/platform-admin/promos/audit?limit=20&offset=0", controller.signal).then(data => {
      if (token !== state.routeToken || location.pathname !== "/platform-admin/promos") return;
      state.promoAudit = data.auditLog || [];
      state.promoAuditHasMore = Boolean(data.pagination?.hasMore);
      state.promoAuditLoading = false;
      refreshPromoAuditView(token);
    }).catch(error => {
      if (error?.name === "AbortError" || token !== state.routeToken) return;
      state.promoAuditLoading = false;
      state.promoAuditError = error.message || "โหลด Audit Log ไม่สำเร็จ";
      refreshPromoAuditView(token);
    });
    const auditTimer = setTimeout(loadAudit, 0);
    controller.signal.addEventListener("abort", () => clearTimeout(auditTimer), { once: true });
  }

  function actionsPage(snapshot) { const rows = [["Payment Failed", snapshot.home.actions.paymentFailed, "bad"], ["Trial ใกล้หมด", snapshot.home.actions.trialExpiring, "warn"], ["LINE ไม่เชื่อม", snapshot.home.actions.lineDisconnected, "bad"], ["Inactive companies", snapshot.home.actions.inactive, "warn"]]; return `${pageHead("สิ่งที่ต้องจัดการ", "รายการแจ้งเตือนเพื่อการตรวจสอบเท่านั้น") }<div class="pa-filter-pills"><button class="pa-filter-pill active">ทั้งหมด</button><button class="pa-filter-pill">Payment Failed</button><button class="pa-filter-pill">Trial ใกล้หมด</button><button class="pa-filter-pill">LINE ไม่เชื่อม</button></div><div class="pa-panel pa-actions-panel"><div class="pa-section-head"><h2>รายการที่ต้องตรวจสอบ</h2></div><ul class="pa-action-list">${rows.map(([label, value, tone]) => `<li><span class="pa-action-icon ${tone}">${homeCardIcons.alert}</span><span><strong>${label}</strong><small>พบรายการที่ต้องตรวจสอบ</small></span><strong class="pa-action-count">${number(value)}</strong><button class="pa-table-action" type="button">ดูรายละเอียด</button></li>`).join("")}</ul></div>`; }

  function settingsPage() {
    const settings = state.settings || { timezone: "Asia/Bangkok", currency: "THB", language: "th", notificationPreferences: { paymentFailed: true, trialExpiring: true, lineDisconnected: true } };
    const preferences = settings.notificationPreferences || {};
    return `<div class="pa-breadcrumb"><span>หน้าหลัก</span>　›　ตั้งค่า</div><div class="pa-page-head pa-settings-page-head"><div><h1>ตั้งค่า</h1><p>การตั้งค่าสำหรับ Platform Admin เท่านั้น</p></div><button class="pa-button" disabled>บันทึกการตั้งค่า</button></div><div class="pa-settings-layout"><aside class="pa-settings-nav"><strong>ข้อมูลส่วนตัว</strong><span>ผู้ใช้ Platform Admin</span><span>การแจ้งเตือน</span><span>ความปลอดภัย</span><span>การตั้งค่าระบบ</span></aside><div class="pa-settings-content"><section class="pa-panel pa-settings-profile"><div class="pa-section-head"><div><h2>ข้อมูล Platform Admin</h2><p class="pa-panel-subtitle">บัญชี Platform Admin ที่ยืนยันแล้วจากเซิร์ฟเวอร์</p></div></div><div class="pa-profile-grid"><div><small>ชื่อที่แสดง</small><strong>${display(state.user?.name)}</strong></div><div><small>Username</small><strong>${display(state.user?.username)}</strong></div><div><small>Role</small><strong>super_admin</strong></div></div></section><section class="pa-panel pa-settings-notifications"><div class="pa-section-head"><div><h2>การตั้งค่าการแจ้งเตือน</h2><p class="pa-panel-subtitle">การตั้งค่าอ่านอย่างเดียวในระยะนี้</p></div></div><ul class="pa-toggle-list"><li><span>แจ้งเตือน Payment Failed</span><input type="checkbox" role="switch" ${preferences.paymentFailed ? "checked" : ""} disabled></li><li><span>แจ้งเตือน Trial ใกล้หมด</span><input type="checkbox" role="switch" ${preferences.trialExpiring ? "checked" : ""} disabled></li><li><span>แจ้งเตือน LINE ไม่เชื่อม</span><input type="checkbox" role="switch" ${preferences.lineDisconnected ? "checked" : ""} disabled></li></ul></section><section class="pa-panel pa-settings-general"><div class="pa-section-head"><h2>การตั้งค่าทั่วไป</h2></div><div class="pa-settings-fields"><label>เขตเวลา <select disabled><option>${escapeHtml(settings.timezone)}</option></select></label><label>สกุลเงิน <select disabled><option>${escapeHtml(settings.currency)} · บาท</option></select></label><label>ภาษา <select disabled><option>ไทย</option></select></label></div></section><section class="pa-panel pa-settings-security"><div class="pa-section-head"><h2>การตั้งค่าความปลอดภัย</h2></div><div class="pa-security-row"><div><strong>ยืนยันตัวตน 2 ชั้น (2FA)</strong><small>เปิดใช้งานเมื่อมีการตั้งค่า 2FA</small></div><button class="pa-button secondary" disabled>จัดการ 2FA</button></div><div class="pa-security-row"><div><strong>เปลี่ยนรหัสผ่าน</strong><small>เปลี่ยนได้เฉพาะบัญชี Platform Admin ที่กำลังเข้าสู่ระบบ</small></div><button class="pa-button secondary" type="button" data-toggle-password-form>เปลี่ยนรหัสผ่าน</button></div><form class="pa-password-form" data-password-form hidden><div class="pa-field"><label for="pa-current-password">รหัสผ่านปัจจุบัน</label><input id="pa-current-password" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="pa-field"><label for="pa-new-password">รหัสผ่านใหม่</label><input id="pa-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" required></div><div class="pa-field"><label for="pa-confirm-password">ยืนยันรหัสผ่านใหม่</label><input id="pa-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></div><div class="pa-error" data-password-error></div><button class="pa-button" type="submit">บันทึกรหัสผ่านใหม่</button></form></section></div></div>`;
  }

  async function renderRoute() {
    if (!state.user) { renderLogin(); return; }
    const token = ++state.routeToken;
    const path = location.pathname;
    if (path === "/platform-admin/promos") {
      const controller = new AbortController();
      state.routeController?.abort();
      state.routeController = controller;
      state.promoLoading = true;
      state.promoAuditLoading = true;
      shell(promoPage());
      bindRouteActions();
      beginPromoLoads(token, controller);
      return;
    }
    const needsSnapshot = !state.snapshot || path === "/platform-admin" || ["/platform-admin/revenue", "/platform-admin/payments"].includes(path);
    if (needsSnapshot) {
      const requestedRange = state.range || presetRange(state.preset);
      const dashboardKey = dashboardCacheKey(requestedRange, state.preset);
      abortObsoleteDashboardRequests(dashboardKey);
      state.loading = true;
      const existingShell = root.querySelector(".pa-shell");
      if (existingShell) existingShell.querySelector(".pa-main-inner")?.setAttribute("aria-busy", "true");
      else shell(path === "/platform-admin" && !state.snapshot ? homeLoading() : `<div class="pa-loading">กำลังโหลดข้อมูล Platform Admin…</div>`);
      try {
        const response = await loadDashboard(requestedRange, state.preset);
        if (token !== state.routeToken || location.pathname !== path) return;
        state.snapshot = response.snapshot;
        state.range = response.snapshot.range;
      } catch (error) {
        if (error?.name === "AbortError" || token !== state.routeToken) return;
        return;
      }
    }
    if (path === "/platform-admin/settings" && !state.settings) {
      const controller = new AbortController();
      state.routeController = controller;
      try {
        const response = await loadCachedEndpoint("settings", "/api/platform-admin/settings", controller.signal);
        if (token !== state.routeToken || location.pathname !== path) return;
        state.settings = response.settings;
      } catch (error) {
        if (error?.name === "AbortError" || token !== state.routeToken) return;
        return;
      } finally {
        if (state.routeController === controller) state.routeController = null;
      }
    }
    let content;
    if (path === "/platform-admin") content = home(state.snapshot);
    else if (path === "/platform-admin/revenue") content = detailPage("revenue", state.snapshot);
    else if (path === "/platform-admin/payments") content = detailPage("payments", state.snapshot);
    else if (path === "/platform-admin/plans") content = plansPage(state.snapshot);
    else if (path === "/platform-admin/usage") content = usagePage(state.snapshot);
    else if (path === "/platform-admin/companies") content = companiesPage(state.snapshot);
    else if (path === "/platform-admin/health") content = healthPage(state.snapshot);
    else if (path === "/platform-admin/actions") content = actionsPage(state.snapshot);
    else if (path === "/platform-admin/settings") content = settingsPage();
    else content = home(state.snapshot);
    if (token !== state.routeToken || location.pathname !== path) return;
    shell(content);
    bindRouteActions();
  }

  function bindRouteActions() {
    root.querySelectorAll("[data-preset]").forEach(button => button.addEventListener("click", async () => { state.preset = button.dataset.preset; state.range = presetRange(state.preset); await renderRoute(); }));
    root.querySelector("[data-apply-range]")?.addEventListener("click", async () => { state.range = { start: root.querySelector("#pa-start").value, end: root.querySelector("#pa-end").value }; state.preset = "custom"; await renderRoute(); });
    root.querySelector("[data-new-promo]")?.addEventListener("click", () => { state.promoEditingId = null; refreshPromoView(state.routeToken); root.querySelector("#pa-promo-form input[name=code]")?.focus(); });
    root.querySelector("[data-cancel-promo-edit]")?.addEventListener("click", () => { state.promoEditingId = null; refreshPromoView(state.routeToken); });
    root.querySelector("#pa-promo-form input[name=noExpiry]")?.addEventListener("change", event => { const expires = root.querySelector("#pa-promo-form input[name=expiresAt]"); if (expires) { expires.disabled = event.currentTarget.checked; if (event.currentTarget.checked) expires.value = ""; } });
    const promoForm = root.querySelector("#pa-promo-form");
    if (promoForm) {
      applyPromoValueFieldType(promoForm);
      promoForm.elements.type?.addEventListener("change", () => applyPromoValueFieldType(promoForm, true));
      promoForm.elements.value?.addEventListener("input", () => applyPromoValueFieldType(promoForm));
      promoForm.elements.value?.addEventListener("blur", () => applyPromoValueFieldType(promoForm, true));
    }
    root.querySelector("#pa-promo-form")?.addEventListener("submit", async event => {
      event.preventDefault();
      if (state.promoSaving) return;
      const form = event.currentTarget;
      applyPromoValueFieldType(form, true);
      if (!form.checkValidity()) return;
      const formData = new FormData(form);
      const data = Object.fromEntries(formData.entries());
      data.plans = formData.getAll("plans");
      data.noExpiry = Boolean(form.noExpiry.checked);
      data.newCustomersOnly = Boolean(form.newCustomersOnly.checked);
      const promoId = String(form.dataset.promoId || "");
      state.promoSaving = true;
      refreshPromoView(state.routeToken);
      try {
        await api(promoId ? `/api/platform-admin/promos/${encodeURIComponent(promoId)}` : "/api/platform-admin/promos", { method: promoId ? "PUT" : "POST", body: JSON.stringify(data) });
        cache.endpoints.delete("promos:0");
        cache.endpoints.delete("promo-audit:0");
        state.promoEditingId = null;
        showToast(promoId ? "แก้ไข Promo และบันทึก Audit Log แล้ว" : "สร้าง Promo และบันทึก Audit Log แล้ว");
      } catch (error) {
        showToast(error.message);
      } finally {
        state.promoSaving = false;
        if (location.pathname === "/platform-admin/promos") await renderRoute();
      }
    });
    bindPromoListActions();
    bindPromoAuditActions();
    root.querySelector("#pa-company-search")?.addEventListener("input", filterCompanies);
    root.querySelector("#pa-company-status")?.addEventListener("change", filterCompanies);
    root.querySelector("#pa-company-plan")?.addEventListener("change", filterCompanies);
    root.querySelectorAll("[data-company-status-pill]").forEach(button => button.addEventListener("click", () => { const status = button.dataset.companyStatusPill || ""; const select = root.querySelector("#pa-company-status"); if (select) select.value = status; filterCompanies(); root.querySelectorAll("[data-company-status-pill]").forEach(item => item.classList.toggle("active", item === button)); }));
    root.querySelectorAll("[data-payment-filter]").forEach(button => button.addEventListener("click", async () => { state.paymentFilter = button.dataset.paymentFilter; filterPayments(); root.querySelectorAll("[data-payment-filter]").forEach(item => item.classList.toggle("active", item === button)); }));
    root.querySelector("[data-toggle-password-form]")?.addEventListener("click", () => {
      const form = root.querySelector("[data-password-form]");
      if (!form) return;
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("input")?.focus();
    });
    root.querySelector("[data-password-form]")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector("button[type=submit]");
      const error = form.querySelector("[data-password-error]");
      button.disabled = true;
      error.textContent = "กำลังตรวจสอบ…";
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        await api("/api/platform-admin/password", { method: "POST", body: JSON.stringify(values) });
        state.user = null;
        history.replaceState({}, "", "/platform-admin/login");
        renderLogin("เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบอีกครั้ง");
      } catch (passwordError) {
        error.textContent = passwordError.message;
        button.disabled = false;
      }
    });
  }

  function filterCompanies() { const query = String(root.querySelector("#pa-company-search")?.value || "").toLowerCase(); const status = String(root.querySelector("#pa-company-status")?.value || "").toLowerCase(); const plan = String(root.querySelector("#pa-company-plan")?.value || "").toLowerCase(); root.querySelectorAll("[data-company-row]").forEach(row => { row.hidden = (query && !row.dataset.search.toLowerCase().includes(query)) || (status && row.dataset.status.toLowerCase() !== status) || (plan && row.dataset.plan.toLowerCase() !== plan); }); }
  function filterPayments() { root.querySelectorAll("[data-payment-row]").forEach(row => { row.hidden = state.paymentFilter !== "all" && row.dataset.paymentStatus !== state.paymentFilter; }); }
  function showToast(message) { const toast = document.createElement("div"); toast.className = "pa-toast"; toast.textContent = message; document.body.appendChild(toast); setTimeout(() => toast.remove(), 2800); }

  async function bootstrap() {
    try { const response = await api("/api/platform-admin/session"); if (!response.user) { renderLogin(); return; } state.user = response.user; await renderRoute(); } catch { renderLogin(); }
  }

  window.addEventListener("popstate", () => {
    state.routeToken += 1;
    state.routeController?.abort();
    state.routeController = null;
    renderRoute();
  });
  bootstrap();
})();
