/* Kiddie Corner Orders – main app.
   Plain JavaScript, no build step. Data lives in IndexedDB on the phone. */
(function () {
  'use strict';

  // ---------- Constants & state ----------
  const STATUSES = [
    { id: 'new', label: 'New' },
    { id: 'confirmed', label: 'Confirmed' },
    { id: 'shipped', label: 'Shipped' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'cancelled', label: 'Cancelled' }
  ];
  const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));

  const DEFAULT_SETTINGS = {
    shopName: 'Kiddie Corner',
    currency: 'EGP',
    countryCode: '',
    charges: [
      { id: uid(), name: 'Shipping', type: 'fixed', amount: 0, auto: true },
      { id: uid(), name: 'Packaging', type: 'fixed', amount: 0, auto: false }
    ]
  };

  const state = {
    settings: null,
    orders: [],
    ordersFilter: { q: '', status: 'all' },
    customersFilter: { q: '', type: 'all', sort: 'recent' },
    dashPeriod: 'month'
  };

  const view = document.getElementById('view');
  const titleEl = document.getElementById('pageTitle');
  const backBtn = document.getElementById('backBtn');
  const topActions = document.getElementById('topActions');

  // Object URLs for photos currently on screen; revoked on navigation.
  let liveUrls = [];
  let draft = null; // order being edited

  // ---------- Helpers ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function num(v) {
    const n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) {
    const v = round2(n || 0);
    const s = v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    const c = (state.settings && state.settings.currency) || '';
    return c ? s + ' ' + c : s;
  }
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function monthKey(iso) { return iso.slice(0, 7); }
  function monthLabel(key, withYear) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  }
  /** Normalises a phone so "+20 101 234 5678", "01012345678" and "00201012345678" match. */
  function phoneKey(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    return d.length > 10 ? d.slice(-10) : d;
  }
  function waNumber(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.startsWith('00')) return d.slice(2);
    if (String(phone).trim().startsWith('+')) return d;
    const cc = String(state.settings.countryCode || '').replace(/\D/g, '');
    if (cc && d.startsWith('0')) return cc + d.slice(1);
    return d;
  }
  function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function statusPill(s) {
    return `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
  }
  function photoUrl(blob) {
    const u = URL.createObjectURL(blob);
    liveUrls.push(u);
    return u;
  }
  function releaseUrls() {
    liveUrls.forEach((u) => URL.revokeObjectURL(u));
    liveUrls = [];
  }
  function sortOrders(list) {
    return list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.number - a.number);
  }

  // ---------- Calculations ----------
  function calcTotals(o) {
    const subtotal = round2(o.items.reduce((s, it) => s + num(it.qty) * num(it.price), 0));
    const charges = o.charges.filter((c) => c.on).map((c) => ({
      name: c.name, type: c.type, amount: num(c.amount),
      value: round2(c.type === 'percent' ? subtotal * num(c.amount) / 100 : num(c.amount))
    }));
    const chargesTotal = round2(charges.reduce((s, c) => s + c.value, 0));
    const discount = round2(num(o.discount));
    const total = round2(Math.max(0, subtotal + chargesTotal - discount));
    const pieces = o.items.reduce((s, it) => s + num(it.qty), 0);
    return { subtotal, charges, chargesTotal, discount, total, pieces };
  }

  /** Groups orders by normalised phone number → customers. */
  function buildCustomers(orders) {
    const map = new Map();
    sortOrders(orders).reverse().forEach((o) => { // oldest first
      const key = o.phoneKey || ('noname-' + o.id);
      let c = map.get(key);
      if (!c) {
        c = { key, name: o.customerName, phone: o.phone, instagram: o.instagram, address: o.address, orders: [], spent: 0, active: 0, first: o.date, last: o.date };
        map.set(key, c);
      }
      c.orders.push(o);
      if (o.customerName) c.name = o.customerName; // latest wins
      if (o.phone) c.phone = o.phone;
      if (o.instagram) c.instagram = o.instagram;
      if (o.address) c.address = o.address;
      c.last = o.date;
      if (o.status !== 'cancelled') { c.spent += o.total; c.active += 1; }
    });
    const list = [...map.values()];
    list.forEach((c) => { c.returning = c.active >= 2; c.spent = round2(c.spent); });
    return list;
  }
  function customerOrderCount(key) {
    return key ? state.orders.filter((o) => o.phoneKey === key && o.status !== 'cancelled').length : 0;
  }

  // ---------- Data ----------
  async function loadAll() {
    state.settings = Object.assign({}, DEFAULT_SETTINGS, await DB.getKV('settings', null) || {});
    state.orders = await DB.getAll('orders');
  }
  async function saveSettings() {
    await DB.setKV('settings', state.settings);
  }
  async function nextOrderNumber() {
    const max = state.orders.reduce((m, o) => Math.max(m, o.number || 0), 0);
    const stored = await DB.getKV('counter', 0);
    const n = Math.max(max, stored) + 1;
    await DB.setKV('counter', n);
    return n;
  }

  /** Resize & compress a photo so the phone storage does not fill up. */
  function compressImage(file, maxSide = 1400, quality = 0.82) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        cv.toBlob((b) => resolve(b || file), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // ---------- Router ----------
  const routes = [
    [/^#\/dashboard$/, renderDashboard],
    [/^#\/orders$/, renderOrders],
    [/^#\/order\/new$/, () => renderOrderForm(null)],
    [/^#\/order\/([^/]+)\/edit$/, (id) => renderOrderForm(id)],
    [/^#\/order\/([^/]+)\/copy$/, (id) => renderOrderForm(id, true)],
    [/^#\/order\/([^/]+)$/, renderOrderView],
    [/^#\/customers$/, renderCustomers],
    [/^#\/customer\/([^/]+)$/, (k) => renderCustomer(decodeURIComponent(k))],
    [/^#\/settings$/, renderSettings]
  ];

  function setChrome(title, opts = {}) {
    titleEl.textContent = title;
    backBtn.hidden = !opts.back;
    topActions.innerHTML = opts.actions || '';
    document.querySelectorAll('.bottomnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === opts.nav));
  }

  let routeSeq = 0;
  async function route() {
    releaseUrls();
    routeSeq++;
    const h = location.hash || '#/dashboard';
    for (const [re, fn] of routes) {
      const m = h.match(re);
      if (m) {
        try { await fn(...m.slice(1)); } catch (e) { console.error(e); view.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; }
        window.scrollTo(0, 0);
        return;
      }
    }
    location.hash = '#/dashboard';
  }

  backBtn.addEventListener('click', () => {
    if (history.length > 1) history.back(); else location.hash = '#/orders';
  });

  // ---------- Dashboard ----------
  function periodRange(p) {
    const now = new Date();
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (p === 'month') return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
    if (p === 'lastmonth') return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))];
    if (p === '30') { const d = new Date(now); d.setDate(d.getDate() - 29); return [iso(d), iso(now)]; }
    if (p === 'year') return [iso(new Date(now.getFullYear(), 0, 1)), iso(now)];
    return ['0000-00-00', '9999-12-31'];
  }

  function renderDashboard() {
    setChrome(state.settings.shopName || 'Dashboard', { nav: 'dashboard', actions: '<button id="dashExport">Export</button>' });
    const periods = [['month', 'This month'], ['lastmonth', 'Last month'], ['30', 'Last 30 days'], ['year', 'This year'], ['all', 'All time']];
    const [from, to] = periodRange(state.dashPeriod);
    const inRange = state.orders.filter((o) => o.date >= from && o.date <= to);
    const active = inRange.filter((o) => o.status !== 'cancelled');
    const cancelled = inRange.length - active.length;

    const revenue = active.reduce((s, o) => s + o.total, 0);
    const itemsRevenue = active.reduce((s, o) => s + o.subtotal, 0);
    const chargesSum = active.reduce((s, o) => s + o.chargesTotal, 0);
    const discounts = active.reduce((s, o) => s + (o.discount || 0), 0);
    const pieces = active.reduce((s, o) => s + o.pieces, 0);
    const aov = active.length ? revenue / active.length : 0;

    // Customers active in the period and whether they are returning (ordered 2+ times ever).
    const allCustomers = buildCustomers(state.orders);
    const byKey = new Map(allCustomers.map((c) => [c.key, c]));
    const periodKeys = new Set(active.map((o) => o.phoneKey || ('noname-' + o.id)));
    let returning = 0, newInPeriod = 0;
    periodKeys.forEach((k) => {
      const c = byKey.get(k);
      if (!c) return;
      if (c.returning) returning++;
      if (c.first >= from && c.first <= to) newInPeriod++;
    });
    const custCount = periodKeys.size;
    const retPct = custCount ? Math.round(returning / custCount * 100) : 0;
    const openOrders = state.orders.filter((o) => o.status === 'new' || o.status === 'confirmed').length;

    // Monthly revenue: last 12 months
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const monthRev = Object.fromEntries(months.map((m) => [m, 0]));
    const monthCnt = Object.fromEntries(months.map((m) => [m, 0]));
    state.orders.forEach((o) => {
      if (o.status === 'cancelled') return;
      const k = monthKey(o.date);
      if (k in monthRev) { monthRev[k] += o.total; monthCnt[k]++; }
    });

    // Status breakdown
    const statusCounts = STATUSES.map((s) => [s.label, inRange.filter((o) => o.status === s.id).length, s.id]);
    // Top customers (period)
    const custSpend = new Map();
    active.forEach((o) => {
      const k = o.phoneKey || ('noname-' + o.id);
      const e = custSpend.get(k) || { name: o.customerName || o.phone, spent: 0, n: 0, key: k };
      e.spent += o.total; e.n++; custSpend.set(k, e);
    });
    const topCust = [...custSpend.values()].sort((a, b) => b.spent - a.spent).slice(0, 5);
    // Sizes & pieces
    const sizeMap = new Map(), pieceMap = new Map();
    active.forEach((o) => o.items.forEach((it) => {
      const sz = (it.size || '').trim() || 'No size';
      sizeMap.set(sz, (sizeMap.get(sz) || 0) + num(it.qty));
      const nm = (it.name || '').trim();
      if (nm) {
        const key = nm.toLowerCase();
        const e = pieceMap.get(key) || { name: nm, qty: 0, rev: 0 };
        e.qty += num(it.qty); e.rev += num(it.qty) * num(it.price); pieceMap.set(key, e);
      }
    }));
    const sizes = [...sizeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topPieces = [...pieceMap.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    // Weekday
    const wd = [0, 0, 0, 0, 0, 0, 0];
    active.forEach((o) => { const [y, m, d] = o.date.split('-').map(Number); wd[new Date(y, m - 1, d).getDay()]++; });
    const wdNames = [...Array(7)].map((_, i) => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' }));

    view.innerHTML = `
      <div class="chips">${periods.map(([id, l]) => `<button class="chip ${state.dashPeriod === id ? 'active' : ''}" data-p="${id}">${l}</button>`).join('')}</div>
      ${state.orders.length === 0 ? `<div class="card empty"><div class="big">👶👗</div><p>No orders yet.<br>Tap <b>+</b> to add your first order.</p></div>` : ''}
      <div class="kpis">
        <div class="kpi accent"><div class="k-label">Total sales</div><div class="k-value">${money(revenue)}</div><div class="k-sub">${active.length} orders</div></div>
        <div class="kpi"><div class="k-label">Average order</div><div class="k-value">${money(aov)}</div><div class="k-sub">${pieces} pieces sold</div></div>
        <div class="kpi"><div class="k-label">Customers</div><div class="k-value">${custCount}</div><div class="k-sub">${newInPeriod} new in this period</div></div>
        <div class="kpi"><div class="k-label">Returning customers</div><div class="k-value">${returning} <span class="small muted">(${retPct}%)</span></div><div class="k-sub">ordered 2+ times</div></div>
        <div class="kpi"><div class="k-label">Pieces value</div><div class="k-value">${money(itemsRevenue)}</div><div class="k-sub">before extra costs</div></div>
        <div class="kpi"><div class="k-label">Extra costs added</div><div class="k-value">${money(chargesSum)}</div><div class="k-sub">discounts: ${money(discounts)}</div></div>
      </div>
      ${openOrders ? `<a class="list-item" href="#/orders" data-open="1"><div class="thumb">⏳</div><div class="main"><div class="title">${openOrders} open order${openOrders > 1 ? 's' : ''}</div><div class="sub">New or confirmed, not shipped yet</div></div><div>›</div></a>` : ''}
      <div class="card chart"><h2>Sales by month</h2>${barChart(months.map((m) => [monthLabel(m, m.endsWith('-01')), monthRev[m], monthCnt[m]]))}</div>
      <div class="card"><h2>Orders by status</h2>${hbars(statusCounts.map(([l, n]) => [l, n, n]))}${cancelled ? `<p class="small muted">Cancelled orders are not counted in sales.</p>` : ''}</div>
      <div class="card"><h2>Top customers</h2>${topCust.length ? topCust.map((c, i) => `
        <a class="list-item" style="margin-bottom:6px" href="#/customer/${encodeURIComponent(c.key)}"><div class="avatar">${i + 1}</div><div class="main"><div class="title">${esc(c.name || 'No name')}</div><div class="sub">${c.n} order${c.n > 1 ? 's' : ''}${byKey.get(c.key) && byKey.get(c.key).returning ? ' · <span class="pill returning">Returning</span>' : ''}</div></div><div class="amt">${money(c.spent)}</div></a>`).join('') : '<p class="muted">No data for this period.</p>'}</div>
      <div class="card"><h2>Best-selling pieces</h2>${topPieces.length ? hbars(topPieces.map((p) => [p.name, p.qty, p.qty + ' pcs · ' + money(p.rev)])) : '<p class="muted">Give your pieces names to see what sells best.</p>'}</div>
      <div class="card"><h2>Sizes sold</h2>${sizes.length ? hbars(sizes.map(([s, q]) => [s, q, q + ' pcs'])) : '<p class="muted">No data for this period.</p>'}</div>
      <div class="card chart"><h2>Orders by weekday</h2>${barChart(wdNames.map((n, i) => [n, wd[i], wd[i]]), true)}</div>
    `;
    view.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { state.dashPeriod = b.dataset.p; renderDashboard(); }));
    const openLink = view.querySelector('[data-open]');
    if (openLink) openLink.addEventListener('click', () => { state.ordersFilter.status = 'open'; });
    document.getElementById('dashExport').addEventListener('click', exportExcel);
  }

  function barChart(data, countOnly) {
    const W = 340, H = 170, padB = 22, padT = 16;
    const max = Math.max(1, ...data.map((d) => d[1]));
    const bw = W / data.length;
    const bars = data.map(([label, v, cnt], i) => {
      const h = (H - padB - padT) * (v / max);
      const x = i * bw + bw * 0.18, w = bw * 0.64, y = H - padB - h;
      const shown = countOnly ? v : (v ? shortNum(v) : '');
      return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(h, v ? 2 : 0).toFixed(1)}" rx="3"><title>${esc(label)}: ${countOnly ? v : money(v) + ' · ' + cnt + ' orders'}</title></rect>
        ${v ? `<text class="val" x="${(i * bw + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${shown}</text>` : ''}
        <text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img">${bars}</svg>`;
  }
  function shortNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }
  function hbars(rows) {
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.map(([l, v, shown]) => `<div class="hbar"><div class="hl"><span>${esc(l)}</span><span class="muted">${esc(shown)}</span></div><div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div>`).join('');
  }

  // ---------- Orders list ----------
  async function renderOrders() {
    setChrome('Orders', { nav: 'orders', actions: '<button id="ordExport">Export</button>' });
    const f = state.ordersFilter;
    const chips = [['all', 'All'], ['open', 'Open'], ...STATUSES.map((s) => [s.id, s.label])];
    view.innerHTML = `
      <input type="search" class="search" id="oq" placeholder="Search name, phone, Instagram, order #" value="${esc(f.q)}">
      <div class="chips">${chips.map(([id, l]) => `<button class="chip ${f.status === id ? 'active' : ''}" data-s="${id}">${l}</button>`).join('')}</div>
      <div id="olist"></div>`;
    const draw = async () => {
      const q = f.q.trim().toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      let list = sortOrders(state.orders).filter((o) => {
        if (f.status === 'open' && !(o.status === 'new' || o.status === 'confirmed')) return false;
        if (f.status !== 'all' && f.status !== 'open' && o.status !== f.status) return false;
        if (!q) return true;
        return (o.customerName || '').toLowerCase().includes(q) ||
          (o.instagram || '').toLowerCase().includes(q.replace(/^@/, '')) ||
          (qDigits && (o.phone || '').replace(/\D/g, '').includes(qDigits)) ||
          ('#' + o.number) === q || String(o.number) === q;
      });
      const box = document.getElementById('olist');
      if (!list.length) {
        box.innerHTML = `<div class="empty"><div class="big">📦</div><p>${state.orders.length ? 'No orders match.' : 'No orders yet. Tap + to add one.'}</p></div>`;
        return;
      }
      const sum = list.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
      box.innerHTML = `<p class="small muted">${list.length} order${list.length > 1 ? 's' : ''} · ${money(sum)}</p>` + list.map((o) => {
        const ret = customerOrderCount(o.phoneKey) >= 2;
        const photoId = (o.items.find((it) => it.photoId) || {}).photoId;
        return `<a class="list-item" href="#/order/${o.id}">
          <div class="thumb" data-photo="${photoId || ''}">👕</div>
          <div class="main"><div class="title">${esc(o.customerName || 'No name')} ${ret ? '<span class="pill returning">Returning</span>' : ''}</div>
          <div class="sub">#${o.number} · ${fmtDate(o.date)} · ${o.pieces} pc${o.pieces === 1 ? '' : 's'}</div></div>
          <div><div class="amt">${money(o.total)}</div><div class="right">${statusPill(o.status)}</div></div></a>`;
      }).join('');
      loadThumbs(box);
    };
    view.querySelector('#oq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    view.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => {
      f.status = b.dataset.s;
      view.querySelectorAll('[data-s]').forEach((x) => x.classList.toggle('active', x === b));
      draw();
    }));
    document.getElementById('ordExport').addEventListener('click', exportExcel);
    await draw();
  }

  async function loadThumbs(container) {
    const els = [...container.querySelectorAll('[data-photo]')].filter((e) => e.dataset.photo);
    for (const el of els) {
      const p = await DB.get('photos', el.dataset.photo);
      if (p && p.blob && el.isConnected) {
        el.outerHTML = `<img class="thumb" alt="" src="${photoUrl(p.blob)}">`;
      }
    }
  }

  // ---------- Order form ----------
  async function renderOrderForm(id, copy) {
    let existing = id ? state.orders.find((o) => o.id === id) : null;
    if (id && !existing) { location.hash = '#/orders'; return; }
    const isEdit = existing && !copy;
    const seq = routeSeq;
    setChrome(isEdit ? 'Edit order #' + existing.number : 'New order', { nav: isEdit ? '' : 'new', back: true });

    // Build the editable draft.
    const settingCharges = state.settings.charges || [];
    if (existing) {
      const photos = {};
      for (const it of existing.items) {
        if (it.photoId) { const p = await DB.get('photos', it.photoId); if (p) photos[it.photoId] = p.blob; }
      }
      if (seq !== routeSeq) return;
      const used = new Set(existing.charges.map((c) => c.name));
      draft = {
        id: isEdit ? existing.id : null,
        number: isEdit ? existing.number : null,
        createdAt: isEdit ? existing.createdAt : null,
        customerName: existing.customerName, phone: existing.phone, instagram: existing.instagram || '', address: existing.address || '',
        date: isEdit ? existing.date : todayISO(), status: isEdit ? existing.status : 'new',
        notes: isEdit ? existing.notes || '' : '', discount: isEdit ? existing.discount || 0 : 0,
        items: existing.items.map((it) => ({ ...it, key: uid(), blob: it.photoId ? photos[it.photoId] : null, newBlob: false })),
        charges: isEdit
          ? [...existing.charges.map((c) => ({ name: c.name, type: c.type, amount: c.amount, on: true })),
            ...settingCharges.filter((c) => !used.has(c.name)).map((c) => ({ name: c.name, type: c.type, amount: c.amount, on: false }))]
          : settingCharges.map((c) => ({ name: c.name, type: c.type, amount: c.amount, on: !!c.auto })),
        originalPhotoIds: isEdit ? existing.items.map((it) => it.photoId).filter(Boolean) : []
      };
    } else {
      draft = {
        id: null, number: null, createdAt: null, customerName: '', phone: '', instagram: '', address: '',
        date: todayISO(), status: 'new', notes: '', discount: 0, items: [newItem()],
        charges: settingCharges.map((c) => ({ name: c.name, type: c.type, amount: c.amount, on: !!c.auto })),
        originalPhotoIds: []
      };
    }

    const customers = buildCustomers(state.orders).filter((c) => c.phone);
    view.innerHTML = `
      <div class="card">
        <h2>Customer</h2>
        <label class="field"><span>Phone number</span><input type="tel" id="f-phone" list="phoneList" inputmode="tel" autocomplete="off" value="${esc(draft.phone)}" placeholder="e.g. 01012345678"></label>
        <datalist id="phoneList">${customers.map((c) => `<option value="${esc(c.phone)}">${esc(c.name)}</option>`).join('')}</datalist>
        <div id="custNote"></div>
        <label class="field"><span>Name</span><input type="text" id="f-name" value="${esc(draft.customerName)}" placeholder="Customer name" autocomplete="off"></label>
        <div class="grid2">
          <label class="field"><span>Instagram (optional)</span><input type="text" id="f-ig" value="${esc(draft.instagram)}" placeholder="@username" autocapitalize="off"></label>
          <label class="field"><span>Order date</span><input type="date" id="f-date" value="${esc(draft.date)}"></label>
        </div>
        <label class="field"><span>Address (optional)</span><input type="text" id="f-addr" value="${esc(draft.address)}" placeholder="Delivery address"></label>
        <label class="field"><span>Status</span><select id="f-status">${STATUSES.map((s) => `<option value="${s.id}" ${draft.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
      </div>

      <div class="card">
        <h2>Pieces</h2>
        <div id="pieces"></div>
        <div class="btn-row">
          <label class="btn file-btn">📷 Add photos<input type="file" id="multiPhotos" accept="image/*" multiple></label>
          <button class="btn" id="addPiece" type="button">+ Add piece</button>
        </div>
        <p class="small muted" style="margin:8px 0 0">Tip: “Add photos” lets you pick several photos at once — each photo becomes a piece, then just type its price.</p>
      </div>

      <div class="card">
        <h2>Extra costs</h2>
        <div id="charges"></div>
        <label class="field" style="margin-top:10px"><span>Discount (amount)</span><input type="number" id="f-discount" inputmode="decimal" min="0" step="any" value="${draft.discount || ''}" placeholder="0"></label>
      </div>

      <div class="card"><h2>Notes</h2><textarea id="f-notes" placeholder="Anything to remember about this order">${esc(draft.notes)}</textarea></div>

      <div class="card totals" id="totals"></div>
      <div class="sticky-save"><button class="btn primary block" id="saveOrder" type="button">💾 Save order</button></div>
    `;

    const bind = (sel, key, cb) => view.querySelector(sel).addEventListener('input', (e) => { draft[key] = e.target.value; if (cb) cb(); });
    bind('#f-phone', 'phone', updateCustomerNote);
    bind('#f-name', 'customerName');
    bind('#f-ig', 'instagram');
    bind('#f-date', 'date');
    bind('#f-addr', 'address');
    bind('#f-notes', 'notes');
    bind('#f-discount', 'discount', updateTotals);
    view.querySelector('#f-status').addEventListener('change', (e) => { draft.status = e.target.value; });
    view.querySelector('#f-phone').addEventListener('change', autofillFromPhone);
    view.querySelector('#addPiece').addEventListener('click', () => { draft.items.push(newItem()); drawPieces(); });
    view.querySelector('#multiPhotos').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      toast('Adding ' + files.length + ' photo' + (files.length > 1 ? 's' : '') + '…');
      // Fill empty pieces first, then add new ones.
      for (const f of files) {
        const blob = await compressImage(f);
        const empty = draft.items.find((it) => !it.blob && !it.name && !num(it.price));
        if (empty) { empty.blob = blob; empty.newBlob = true; } else { draft.items.push({ ...newItem(), blob, newBlob: true }); }
      }
      drawPieces();
    });
    view.querySelector('#saveOrder').addEventListener('click', saveDraft);

    drawPieces();
    drawCharges();
    updateCustomerNote();
  }

  function newItem() {
    return { key: uid(), name: '', size: '', qty: 1, price: '', photoId: null, blob: null, newBlob: false };
  }

  function drawPieces() {
    releaseUrls();
    const box = document.getElementById('pieces');
    if (!draft.items.length) { box.innerHTML = '<p class="muted">No pieces yet.</p>'; updateTotals(); return; }
    box.innerHTML = draft.items.map((it, i) => `
      <div class="piece" data-k="${it.key}">
        <div class="piece-top">
          <label class="photo-slot ${it.blob ? 'has' : ''}" ${it.blob ? `style="background-image:url('${photoUrl(it.blob)}')"` : ''}>
            ${it.blob ? '' : '📷<br>Photo'}<input type="file" accept="image/*" data-f="photo">
          </label>
          <div class="piece-fields">
            <input type="text" data-f="name" value="${esc(it.name)}" placeholder="Piece ${i + 1} (e.g. Pink dress)">
            <div class="piece-nums">
              <input type="text" data-f="size" value="${esc(it.size)}" placeholder="Size">
              <input type="number" data-f="qty" inputmode="numeric" min="1" step="1" value="${esc(it.qty)}" placeholder="Qty">
              <input type="number" data-f="price" inputmode="decimal" min="0" step="any" value="${esc(it.price)}" placeholder="Price">
            </div>
          </div>
        </div>
        <div class="piece-bottom"><button class="link-btn" data-f="remove" type="button">Remove</button><span>Line: <b data-line>${money(num(it.qty) * num(it.price))}</b></span></div>
      </div>`).join('');
    box.querySelectorAll('.piece').forEach((el) => {
      const it = draft.items.find((x) => x.key === el.dataset.k);
      el.querySelectorAll('input[data-f]').forEach((inp) => {
        const f = inp.dataset.f;
        if (f === 'photo') {
          inp.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            it.blob = await compressImage(file); it.newBlob = true;
            drawPieces();
          });
        } else {
          inp.addEventListener('input', (e) => {
            it[f] = e.target.value;
            if (f === 'qty' || f === 'price') { el.querySelector('[data-line]').textContent = money(num(it.qty) * num(it.price)); updateTotals(); }
          });
        }
      });
      el.querySelector('[data-f=remove]').addEventListener('click', () => {
        if ((it.blob || it.name || num(it.price)) && !confirm('Remove this piece?')) return;
        draft.items = draft.items.filter((x) => x !== it);
        drawPieces();
      });
    });
    updateTotals();
  }

  function drawCharges() {
    const box = document.getElementById('charges');
    if (!draft.charges.length) {
      box.innerHTML = '<p class="muted small">No extra costs set up. Add them in <a href="#/settings">Settings</a> (e.g. shipping, packaging).</p>';
      return;
    }
    box.innerHTML = draft.charges.map((c, i) => `
      <div class="charge-row">
        <input type="checkbox" data-i="${i}" data-f="on" ${c.on ? 'checked' : ''} aria-label="Apply ${esc(c.name)}">
        <span class="cname">${esc(c.name)}</span>
        <input type="number" data-i="${i}" data-f="amount" inputmode="decimal" step="any" min="0" value="${esc(c.amount)}">
        <span class="small muted" style="width:34px">${c.type === 'percent' ? '%' : esc(state.settings.currency)}</span>
      </div>`).join('');
    box.querySelectorAll('input').forEach((inp) => {
      const c = draft.charges[+inp.dataset.i];
      inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', (e) => {
        if (inp.dataset.f === 'on') c.on = e.target.checked; else { c.amount = e.target.value; }
        updateTotals();
      });
    });
  }

  function updateTotals() {
    const t = calcTotals(draft);
    const box = document.getElementById('totals');
    if (!box) return;
    box.innerHTML = `
      <div class="tline"><span>Pieces (${t.pieces})</span><span>${money(t.subtotal)}</span></div>
      ${t.charges.map((c) => `<div class="tline"><span>${esc(c.name)}${c.type === 'percent' ? ` (${c.amount}%)` : ''}</span><span>+ ${money(c.value)}</span></div>`).join('')}
      ${t.discount ? `<div class="tline"><span>Discount</span><span>− ${money(t.discount)}</span></div>` : ''}
      <div class="tline grand"><span>Total</span><span>${money(t.total)}</span></div>`;
  }

  function updateCustomerNote() {
    const el = document.getElementById('custNote');
    if (!el) return;
    const k = phoneKey(draft.phone);
    if (k.length < 6) { el.innerHTML = ''; return; }
    const prev = state.orders.filter((o) => o.phoneKey === k && o.id !== draft.id);
    if (!prev.length) { el.innerHTML = '<div class="returning-note newc">✨ New customer</div>'; return; }
    const spent = prev.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
    const last = sortOrders(prev)[0];
    el.innerHTML = `<div class="returning-note">🔁 Returning customer — ${prev.length} previous order${prev.length > 1 ? 's' : ''}, ${money(spent)} total. Last: ${fmtDate(last.date)}${last.customerName ? ' (' + esc(last.customerName) + ')' : ''}</div>`;
  }

  function autofillFromPhone() {
    const k = phoneKey(draft.phone);
    if (k.length < 6) return;
    const last = sortOrders(state.orders.filter((o) => o.phoneKey === k && o.id !== draft.id))[0];
    if (!last) return;
    const fill = (sel, key) => {
      if (!draft[key] && last[key]) { draft[key] = last[key]; view.querySelector(sel).value = last[key]; }
    };
    fill('#f-name', 'customerName');
    fill('#f-ig', 'instagram');
    fill('#f-addr', 'address');
  }

  async function saveDraft() {
    const btn = document.getElementById('saveOrder');
    if (!draft.customerName.trim() && !draft.phone.trim()) { toast('Please add the customer name or phone'); return; }
    const items = draft.items.filter((it) => it.blob || it.name.trim() || num(it.price));
    if (!items.length) { toast('Please add at least one piece'); return; }
    btn.disabled = true;
    try {
      const t = calcTotals({ ...draft, items: items.map((it) => ({ ...it, qty: recalcQty(it.qty) })) });
      const id = draft.id || uid();
      const newPhotos = [];
      const keptPhotoIds = new Set();
      const savedItems = items.map((it) => {
        let photoId = it.photoId;
        if (it.blob && it.newBlob) { photoId = uid(); newPhotos.push({ id: photoId, orderId: id, blob: it.blob }); }
        if (!it.blob) photoId = null;
        if (photoId) keptPhotoIds.add(photoId);
        return { id: it.id || uid(), name: it.name.trim(), size: String(it.size || '').trim(), qty: recalcQty(it.qty), price: round2(num(it.price)), photoId };
      });
      // When duplicating an order, copy (not share) the photos so deleting one order keeps the other's.
      if (!draft.id) {
        for (const it of savedItems) {
          const src = items.find((x) => x.photoId === it.photoId && !x.newBlob);
          if (it.photoId && src) {
            const nid = uid();
            newPhotos.push({ id: nid, orderId: id, blob: src.blob });
            keptPhotoIds.delete(it.photoId); keptPhotoIds.add(nid); it.photoId = nid;
          }
        }
      }
      const order = {
        id,
        number: draft.number || await nextOrderNumber(),
        createdAt: draft.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        date: draft.date || todayISO(),
        customerName: draft.customerName.trim(),
        phone: draft.phone.trim(),
        phoneKey: phoneKey(draft.phone),
        instagram: draft.instagram.trim().replace(/^@/, ''),
        address: draft.address.trim(),
        status: draft.status,
        notes: draft.notes.trim(),
        items: savedItems,
        charges: t.charges,
        discount: t.discount,
        subtotal: t.subtotal,
        chargesTotal: t.chargesTotal,
        total: t.total,
        pieces: savedItems.reduce((s, it) => s + it.qty, 0)
      };
      if (newPhotos.length) await DB.putMany('photos', newPhotos);
      await DB.put('orders', order);
      const removed = draft.originalPhotoIds.filter((p) => !keptPhotoIds.has(p));
      if (draft.id && removed.length) await DB.delMany('photos', removed);
      const idx = state.orders.findIndex((o) => o.id === id);
      if (idx >= 0) state.orders[idx] = order; else state.orders.push(order);
      toast('Order #' + order.number + ' saved');
      draft = null;
      location.replace('#/order/' + id);
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      alert('Could not save: ' + e.message + (e.name === 'QuotaExceededError' ? '\nThe phone storage is full. Export a backup and delete old orders.' : ''));
    }
  }
  function recalcQty(q) { return Math.max(1, Math.round(num(q))); }

  // ---------- Order view ----------
  async function renderOrderView(id) {
    const o = state.orders.find((x) => x.id === id);
    if (!o) { location.hash = '#/orders'; return; }
    const seq = routeSeq;
    const photos = {};
    for (const it of o.items) if (it.photoId) { const p = await DB.get('photos', it.photoId); if (p) photos[it.photoId] = photoUrl(p.blob); }
    if (seq !== routeSeq) return;
    setChrome('Order #' + o.number, { back: true, nav: 'orders', actions: `<button id="editBtn">Edit</button>` });
    const prevCount = customerOrderCount(o.phoneKey);
    const wa = waNumber(o.phone);

    view.innerHTML = `
      <div class="card">
        <div class="row"><div class="avatar">${esc(initials(o.customerName))}</div>
          <div class="grow"><div style="font-weight:700;font-size:18px">${esc(o.customerName || 'No name')}</div>
          <div class="small muted">${esc(o.phone)}${o.instagram ? ' · @' + esc(o.instagram) : ''}</div></div>
          ${prevCount >= 2 ? '<span class="pill returning">Returning</span>' : ''}</div>
        <div class="spacer"></div>
        <div class="kv"><span>Date</span><span>${fmtDate(o.date)}</span></div>
        <div class="kv"><span>Status</span><span><select class="status-select" id="qStatus">${STATUSES.map((s) => `<option value="${s.id}" ${o.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></span></div>
        ${o.address ? `<div class="kv"><span>Address</span><span>${esc(o.address)}</span></div>` : ''}
        ${o.phoneKey ? `<div class="kv"><span>Customer orders</span><span><a href="#/customer/${encodeURIComponent(o.phoneKey)}">${prevCount} order${prevCount === 1 ? '' : 's'} ›</a></span></div>` : ''}
        <div class="spacer"></div>
        <div class="btn-row">
          ${o.phone ? `<a class="btn sm" href="tel:${esc(o.phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : ''}
          ${wa ? `<a class="btn sm" id="waBtn" href="https://wa.me/${wa}?text=${encodeURIComponent(orderMessage(o))}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
          ${o.instagram ? `<a class="btn sm" href="https://instagram.com/${encodeURIComponent(o.instagram)}" target="_blank" rel="noopener">📸 Instagram</a>` : ''}
        </div>
      </div>

      ${Object.keys(photos).length ? `<div class="card"><h2>Photos</h2><div class="gallery">${o.items.filter((it) => photos[it.photoId]).map((it) => `<img src="${photos[it.photoId]}" alt="${esc(it.name)}" data-zoom>`).join('')}</div></div>` : ''}

      <div class="card"><h2>Pieces</h2>
        ${o.items.map((it) => `<div class="item-line">${photos[it.photoId] ? `<img src="${photos[it.photoId]}" alt="" data-zoom>` : '<div class="noimg">👕</div>'}
          <div class="grow"><div style="font-weight:600">${esc(it.name || 'Piece')}</div><div class="small muted">${it.size ? 'Size ' + esc(it.size) + ' · ' : ''}${it.qty} × ${money(it.price)}</div></div>
          <div style="font-weight:700">${money(it.qty * it.price)}</div></div>`).join('')}
      </div>

      <div class="card totals">
        <div class="tline"><span>Pieces (${o.pieces})</span><span>${money(o.subtotal)}</span></div>
        ${o.charges.map((c) => `<div class="tline"><span>${esc(c.name)}${c.type === 'percent' ? ` (${c.amount}%)` : ''}</span><span>+ ${money(c.value)}</span></div>`).join('')}
        ${o.discount ? `<div class="tline"><span>Discount</span><span>− ${money(o.discount)}</span></div>` : ''}
        <div class="tline grand"><span>Total</span><span>${money(o.total)}</span></div>
      </div>

      ${o.notes ? `<div class="card"><h2>Notes</h2><div style="white-space:pre-wrap">${esc(o.notes)}</div></div>` : ''}

      <div class="btn-row">
        <button class="btn" id="copyMsg">📋 Copy summary</button>
        <a class="btn" href="#/order/${o.id}/copy">⧉ Repeat order</a>
      </div>
      <div class="spacer"></div>
      <button class="btn danger block" id="delBtn">🗑 Delete order</button>
    `;
    document.getElementById('editBtn').addEventListener('click', () => { location.hash = '#/order/' + o.id + '/edit'; });
    document.getElementById('qStatus').addEventListener('change', async (e) => {
      o.status = e.target.value; o.updatedAt = new Date().toISOString();
      await DB.put('orders', o);
      toast('Status: ' + STATUS_LABEL[o.status]);
    });
    document.getElementById('copyMsg').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(orderMessage(o)); toast('Copied — paste it in Instagram DM'); }
      catch (_) { prompt('Copy this:', orderMessage(o)); }
    });
    document.getElementById('delBtn').addEventListener('click', async () => {
      if (!confirm('Delete order #' + o.number + '? This cannot be undone.')) return;
      await DB.del('orders', o.id);
      const ids = o.items.map((it) => it.photoId).filter(Boolean);
      if (ids.length) await DB.delMany('photos', ids);
      state.orders = state.orders.filter((x) => x.id !== o.id);
      toast('Order deleted');
      location.replace('#/orders');
    });
    bindZoom();
  }

  function orderMessage(o) {
    const lines = [`${state.settings.shopName || 'Order'} – Order #${o.number}`, `Hi ${o.customerName || ''}`.trim() + ' 💕', ''];
    o.items.forEach((it) => lines.push(`• ${it.name || 'Piece'}${it.size ? ' (' + it.size + ')' : ''} – ${it.qty} × ${money(it.price)}`));
    lines.push('', `Pieces: ${money(o.subtotal)}`);
    o.charges.forEach((c) => lines.push(`${c.name}: ${money(c.value)}`));
    if (o.discount) lines.push(`Discount: -${money(o.discount)}`);
    lines.push(`Total: ${money(o.total)}`);
    return lines.join('\n');
  }

  function bindZoom() {
    const lb = document.getElementById('lightbox');
    view.querySelectorAll('[data-zoom]').forEach((img) => img.addEventListener('click', () => {
      lb.querySelector('img').src = img.src; lb.hidden = false;
    }));
  }
  document.getElementById('lightbox').addEventListener('click', () => { document.getElementById('lightbox').hidden = true; });

  // ---------- Customers ----------
  function renderCustomers() {
    setChrome('Customers', { nav: 'customers' });
    const f = state.customersFilter;
    const all = buildCustomers(state.orders);
    const retCount = all.filter((c) => c.returning).length;
    view.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="k-label">All customers</div><div class="k-value">${all.length}</div></div>
        <div class="kpi"><div class="k-label">Returning</div><div class="k-value">${retCount} <span class="small muted">(${all.length ? Math.round(retCount / all.length * 100) : 0}%)</span></div></div>
      </div>
      <input type="search" class="search" id="cq" placeholder="Search name, phone, Instagram" value="${esc(f.q)}">
      <div class="chips">
        ${[['all', 'All'], ['returning', '🔁 Returning'], ['new', 'One-time']].map(([id, l]) => `<button class="chip ${f.type === id ? 'active' : ''}" data-t="${id}">${l}</button>`).join('')}
        <span style="width:8px"></span>
        ${[['recent', 'Recent'], ['spent', 'Top spent'], ['orders', 'Most orders']].map(([id, l]) => `<button class="chip ${f.sort === id ? 'active' : ''}" data-so="${id}">${l}</button>`).join('')}
      </div>
      <div id="clist"></div>`;
    const draw = () => {
      const q = f.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
      let list = all.filter((c) => {
        if (f.type === 'returning' && !c.returning) return false;
        if (f.type === 'new' && c.returning) return false;
        if (!q) return true;
        return (c.name || '').toLowerCase().includes(q) || (c.instagram || '').toLowerCase().includes(q.replace(/^@/, '')) || (qd && (c.phone || '').replace(/\D/g, '').includes(qd));
      });
      list.sort(f.sort === 'spent' ? (a, b) => b.spent - a.spent : f.sort === 'orders' ? (a, b) => b.orders.length - a.orders.length || b.spent - a.spent : (a, b) => (b.last || '').localeCompare(a.last || ''));
      document.getElementById('clist').innerHTML = list.length ? list.map((c) => `
        <a class="list-item" href="#/customer/${encodeURIComponent(c.key)}">
          <div class="avatar">${esc(initials(c.name))}</div>
          <div class="main"><div class="title">${esc(c.name || 'No name')} ${c.returning ? '<span class="pill returning">Returning</span>' : ''}</div>
          <div class="sub">${esc(c.phone || '')} · ${c.orders.length} order${c.orders.length > 1 ? 's' : ''} · last ${fmtDate(c.last)}</div></div>
          <div class="amt">${money(c.spent)}</div></a>`).join('') : `<div class="empty"><div class="big">👥</div><p>${all.length ? 'No customers match.' : 'Customers appear here automatically when you add orders.'}</p></div>`;
    };
    view.querySelector('#cq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    view.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { f.type = b.dataset.t; view.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b)); draw(); }));
    view.querySelectorAll('[data-so]').forEach((b) => b.addEventListener('click', () => { f.sort = b.dataset.so; view.querySelectorAll('[data-so]').forEach((x) => x.classList.toggle('active', x === b)); draw(); }));
    draw();
  }

  async function renderCustomer(key) {
    const c = buildCustomers(state.orders).find((x) => x.key === key);
    if (!c) { location.hash = '#/customers'; return; }
    setChrome(c.name || 'Customer', { back: true, nav: 'customers' });
    const orders = sortOrders(c.orders);
    const pieces = c.orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.pieces, 0);
    const wa = waNumber(c.phone);
    const sizes = new Map();
    c.orders.forEach((o) => o.items.forEach((it) => { if (it.size) sizes.set(it.size, (sizes.get(it.size) || 0) + it.qty); }));
    view.innerHTML = `
      <div class="card">
        <div class="row"><div class="avatar">${esc(initials(c.name))}</div>
          <div class="grow"><div style="font-weight:700;font-size:18px">${esc(c.name || 'No name')}</div>
          <div class="small muted">${esc(c.phone || '')}${c.instagram ? ' · @' + esc(c.instagram) : ''}</div></div>
          ${c.returning ? '<span class="pill returning">Returning</span>' : '<span class="pill">One-time</span>'}</div>
        ${c.address ? `<div class="spacer"></div><div class="kv"><span>Address</span><span>${esc(c.address)}</span></div>` : ''}
        <div class="spacer"></div>
        <div class="btn-row">
          ${c.phone ? `<a class="btn sm" href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">📞 Call</a>` : ''}
          ${wa ? `<a class="btn sm" href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
          ${c.instagram ? `<a class="btn sm" href="https://instagram.com/${encodeURIComponent(c.instagram)}" target="_blank" rel="noopener">📸 Instagram</a>` : ''}
        </div>
      </div>
      <div class="kpis">
        <div class="kpi accent"><div class="k-label">Total spent</div><div class="k-value">${money(c.spent)}</div></div>
        <div class="kpi"><div class="k-label">Orders</div><div class="k-value">${c.orders.length}</div><div class="k-sub">${pieces} pieces</div></div>
        <div class="kpi"><div class="k-label">Average order</div><div class="k-value">${money(c.active ? c.spent / c.active : 0)}</div></div>
        <div class="kpi"><div class="k-label">Customer since</div><div class="k-value" style="font-size:17px">${fmtDate(c.first)}</div><div class="k-sub">last order ${fmtDate(c.last)}</div></div>
      </div>
      ${sizes.size ? `<div class="card"><h2>Sizes bought</h2>${[...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([s, q]) => `<span class="pill" style="margin:0 6px 6px 0">${esc(s)} × ${q}</span>`).join('')}</div>` : ''}
      <div class="row" style="margin:6px 0 10px"><div class="section-title grow" style="margin:0">Orders</div>
        <a class="btn sm primary" href="#/order/new" id="newForCust">+ New order</a></div>
      <div id="corders">${orders.map((o) => `
        <a class="list-item" href="#/order/${o.id}">
          <div class="thumb" data-photo="${(o.items.find((it) => it.photoId) || {}).photoId || ''}">👕</div>
          <div class="main"><div class="title">Order #${o.number}</div><div class="sub">${fmtDate(o.date)} · ${o.pieces} pc${o.pieces === 1 ? '' : 's'}</div></div>
          <div><div class="amt">${money(o.total)}</div><div class="right">${statusPill(o.status)}</div></div></a>`).join('')}</div>`;
    loadThumbs(document.getElementById('corders'));
    document.getElementById('newForCust').addEventListener('click', (e) => {
      e.preventDefault();
      pendingCustomer = { customerName: c.name, phone: c.phone, instagram: c.instagram || '', address: c.address || '' };
      location.hash = '#/order/new';
    });
  }
  let pendingCustomer = null;

  // ---------- Settings ----------
  function renderSettings() {
    setChrome('Settings', { nav: 'settings' });
    const s = state.settings;
    view.innerHTML = `
      <div class="card">
        <h2>Shop</h2>
        <label class="field"><span>Shop name</span><input type="text" id="s-name" value="${esc(s.shopName)}"></label>
        <div class="grid2">
          <label class="field"><span>Currency</span><input type="text" id="s-cur" value="${esc(s.currency)}" placeholder="EGP, $, SAR…"></label>
          <label class="field"><span>Country code (for WhatsApp)</span><input type="tel" id="s-cc" value="${esc(s.countryCode)}" placeholder="e.g. 20"></label>
        </div>
      </div>

      <div class="card">
        <h2>Extra costs added to orders</h2>
        <p class="small muted" style="margin-top:-4px">These are added on top of the pieces total (e.g. shipping, packaging, COD fee). “Fixed” adds an amount, “%” adds a percentage of the pieces total. Tick <b>Auto</b> to add it to every new order automatically — you can still switch it off or change it inside any order.</p>
        <div id="chargeList"></div>
        <button class="btn block" id="addCharge" type="button">+ Add cost</button>
      </div>
      <button class="btn primary block" id="saveSettings">💾 Save settings</button>
      <div class="spacer"></div><div class="spacer"></div>

      <div class="card">
        <h2>Export & backup</h2>
        <button class="btn block" id="xlsBtn">📊 Export to Excel (.xlsx)</button>
        <div class="spacer"></div>
        <button class="btn block" id="bakBtn">💾 Download full backup (with photos)</button>
        <div class="spacer"></div>
        <label class="btn block file-btn">♻️ Restore from backup<input type="file" id="restoreInput" accept=".json,application/json"></label>
        <p class="small muted">Your data is saved only on this phone. Download a backup regularly (e.g. weekly) and keep it in Google Drive / iCloud, so you never lose your orders if the phone is lost or changed.</p>
        <p class="small muted" id="storageInfo"></p>
      </div>

      <div class="card">
        <h2>Danger zone</h2>
        <button class="btn danger block" id="wipeBtn">Delete ALL data</button>
      </div>
      <p class="small muted" style="text-align:center">Kiddie Corner Orders · works offline</p>
    `;
    const drawCharges = () => {
      document.getElementById('chargeList').innerHTML = s.charges.length ? s.charges.map((c, i) => `
        <div class="set-charge">
          <input type="text" data-i="${i}" data-f="name" value="${esc(c.name)}" placeholder="Name">
          <input type="number" data-i="${i}" data-f="amount" inputmode="decimal" step="any" min="0" value="${esc(c.amount)}">
          <select data-i="${i}" data-f="type"><option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Fixed</option><option value="percent" ${c.type === 'percent' ? 'selected' : ''}>%</option></select>
          <button class="icon-btn" data-del="${i}" aria-label="Delete" style="font-size:18px">🗑</button>
        </div>
        <label class="switch"><input type="checkbox" data-i="${i}" data-f="auto" ${c.auto ? 'checked' : ''}> Auto-add to new orders</label>`).join('') : '<p class="muted">No extra costs yet.</p>';
      document.querySelectorAll('#chargeList [data-f]').forEach((inp) => {
        inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', (e) => {
          const c = s.charges[+inp.dataset.i], f = inp.dataset.f;
          c[f] = f === 'auto' ? e.target.checked : f === 'amount' ? num(e.target.value) : e.target.value;
        });
      });
      document.querySelectorAll('#chargeList [data-del]').forEach((b) => b.addEventListener('click', () => { s.charges.splice(+b.dataset.del, 1); drawCharges(); }));
    };
    drawCharges();
    document.getElementById('addCharge').addEventListener('click', () => { s.charges.push({ id: uid(), name: '', type: 'fixed', amount: 0, auto: true }); drawCharges(); });
    document.getElementById('saveSettings').addEventListener('click', async () => {
      s.shopName = document.getElementById('s-name').value.trim() || 'Kiddie Corner';
      s.currency = document.getElementById('s-cur').value.trim();
      s.countryCode = document.getElementById('s-cc').value.replace(/\D/g, '');
      s.charges = s.charges.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim(), amount: num(c.amount) }));
      await saveSettings();
      drawCharges();
      toast('Settings saved');
    });
    document.getElementById('xlsBtn').addEventListener('click', exportExcel);
    document.getElementById('bakBtn').addEventListener('click', exportBackup);
    document.getElementById('restoreInput').addEventListener('change', restoreBackup);
    document.getElementById('wipeBtn').addEventListener('click', async () => {
      if (!confirm('Delete ALL orders, photos and settings from this phone?')) return;
      if (prompt('Type DELETE to confirm') !== 'DELETE') return;
      await Promise.all([DB.clear('orders'), DB.clear('photos'), DB.clear('kv')]);
      await loadAll();
      toast('All data deleted');
      renderSettings();
    });
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((e) => {
        const mb = (x) => (x / 1048576).toFixed(1) + ' MB';
        const el = document.getElementById('storageInfo');
        if (el) el.textContent = `Storage used: ${mb(e.usage || 0)}${e.quota ? ' of ' + mb(e.quota) : ''} · ${state.orders.length} orders`;
      });
    }
  }

  // ---------- Export / Backup ----------
  async function deliverFile(blob, filename) {
    // On phones, the share sheet lets you save to Files / Drive or send via WhatsApp.
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function buildWorkbook() {
    const cur = state.settings.currency ? ` (${state.settings.currency})` : '';
    const customers = buildCustomers(state.orders);
    const custByKey = new Map(customers.map((c) => [c.key, c]));
    const orders = sortOrders(state.orders);
    const chargeNames = [...new Set(orders.flatMap((o) => o.charges.map((c) => c.name)))];

    const ordersRows = orders.map((o) => {
      const c = custByKey.get(o.phoneKey || ('noname-' + o.id));
      const row = {
        'Order #': o.number, 'Date': o.date, 'Customer': o.customerName, 'Phone': o.phone, 'Instagram': o.instagram ? '@' + o.instagram : '',
        'Address': o.address, 'Status': STATUS_LABEL[o.status] || o.status, 'Pieces': o.pieces,
        ['Pieces total' + cur]: o.subtotal
      };
      chargeNames.forEach((n) => { const ch = o.charges.find((x) => x.name === n); row[n + cur] = ch ? ch.value : 0; });
      row['Discount' + cur] = o.discount || 0;
      row['Order total' + cur] = o.total;
      row['Customer type'] = c && c.returning ? 'Returning' : 'New / one-time';
      row['Customer total orders'] = c ? c.orders.length : 1;
      row['Notes'] = o.notes;
      return row;
    });
    const itemRows = orders.flatMap((o) => o.items.map((it) => ({
      'Order #': o.number, 'Date': o.date, 'Customer': o.customerName, 'Phone': o.phone, 'Status': STATUS_LABEL[o.status] || o.status,
      'Piece': it.name, 'Size': it.size, 'Qty': it.qty, ['Unit price' + cur]: it.price, ['Line total' + cur]: round2(it.qty * it.price), 'Has photo': it.photoId ? 'Yes' : 'No'
    })));
    const custRows = customers.sort((a, b) => b.spent - a.spent).map((c) => ({
      'Customer': c.name, 'Phone': c.phone, 'Instagram': c.instagram ? '@' + c.instagram : '', 'Address': c.address,
      'Orders': c.orders.length, 'Active orders (not cancelled)': c.active, ['Total spent' + cur]: c.spent,
      ['Average order' + cur]: c.active ? round2(c.spent / c.active) : 0, 'First order': c.first, 'Last order': c.last,
      'Type': c.returning ? 'Returning' : 'New / one-time'
    }));
    const monthly = new Map();
    orders.forEach((o) => {
      const k = monthKey(o.date);
      const m = monthly.get(k) || { orders: 0, cancelled: 0, pieces: 0, sub: 0, charges: 0, disc: 0, total: 0, custs: new Set() };
      if (o.status === 'cancelled') m.cancelled++;
      else { m.orders++; m.pieces += o.pieces; m.sub += o.subtotal; m.charges += o.chargesTotal; m.disc += o.discount || 0; m.total += o.total; m.custs.add(o.phoneKey || o.id); }
      monthly.set(k, m);
    });
    const monthRows = [...monthly.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, m]) => ({
      'Month': k, 'Orders': m.orders, 'Cancelled': m.cancelled, 'Customers': m.custs.size, 'Pieces sold': m.pieces,
      ['Pieces total' + cur]: round2(m.sub), ['Extra costs' + cur]: round2(m.charges), ['Discounts' + cur]: round2(m.disc),
      ['Sales total' + cur]: round2(m.total), ['Average order' + cur]: m.orders ? round2(m.total / m.orders) : 0
    }));

    const wb = XLSX.utils.book_new();
    const add = (rows, name, emptyHeader) => {
      const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([emptyHeader]);
      const keys = rows.length ? Object.keys(rows[0]) : emptyHeader;
      ws['!cols'] = keys.map((k) => ({ wch: Math.min(40, Math.max(k.length, ...rows.map((r) => String(r[k] == null ? '' : r[k]).length)) + 2) }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add(ordersRows, 'Orders', ['Order #', 'Date', 'Customer', 'Phone', 'Total']);
    add(itemRows, 'Pieces', ['Order #', 'Piece', 'Size', 'Qty', 'Unit price']);
    add(custRows, 'Customers', ['Customer', 'Phone', 'Orders', 'Total spent']);
    add(monthRows, 'Monthly summary', ['Month', 'Orders', 'Sales total']);
    return wb;
  }

  async function exportExcel() {
    if (typeof XLSX === 'undefined') { alert('Excel library not loaded yet, try again in a moment.'); return; }
    if (!state.orders.length) { toast('No orders to export yet'); return; }
    const wb = buildWorkbook();
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await deliverFile(blob, `kiddie-corner-orders-${todayISO()}.xlsx`);
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }
  async function dataURLToBlob(url) { return (await fetch(url)).blob(); }

  async function exportBackup() {
    toast('Preparing backup…');
    const photos = await DB.getAll('photos');
    const data = {
      app: 'kiddie-corner', version: 1, exportedAt: new Date().toISOString(),
      settings: state.settings, counter: await DB.getKV('counter', 0), orders: state.orders,
      photos: await Promise.all(photos.map(async (p) => ({ id: p.id, orderId: p.orderId, data: await blobToDataURL(p.blob) })))
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await deliverFile(blob, `kiddie-corner-backup-${todayISO()}.json`);
  }

  async function restoreBackup(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (_) { alert('This file is not a valid backup.'); return; }
    if (data.app !== 'kiddie-corner' || !Array.isArray(data.orders)) { alert('This file is not a Kiddie Corner backup.'); return; }
    if (!confirm(`Restore ${data.orders.length} orders from ${fmtDate((data.exportedAt || '').slice(0, 10))}?\nThis REPLACES all data currently on this phone.`)) return;
    toast('Restoring…');
    try {
      const photos = await Promise.all((data.photos || []).map(async (p) => ({ id: p.id, orderId: p.orderId, blob: await dataURLToBlob(p.data) })));
      await Promise.all([DB.clear('orders'), DB.clear('photos'), DB.clear('kv')]);
      await DB.putMany('orders', data.orders);
      // Write photos in chunks to keep memory reasonable on phones.
      for (let i = 0; i < photos.length; i += 20) await DB.putMany('photos', photos.slice(i, i + 20));
      if (data.settings) await DB.setKV('settings', data.settings);
      await DB.setKV('counter', data.counter || 0);
      await loadAll();
      toast('Backup restored ✔');
      renderSettings();
    } catch (err) {
      console.error(err);
      alert('Restore failed: ' + err.message);
    }
  }

  // ---------- Boot ----------
  window.addEventListener('hashchange', async () => {
    await route();
    if (pendingCustomer && location.hash === '#/order/new' && draft) {
      Object.assign(draft, pendingCustomer);
      view.querySelector('#f-name').value = draft.customerName || '';
      view.querySelector('#f-phone').value = draft.phone || '';
      view.querySelector('#f-ig').value = draft.instagram || '';
      view.querySelector('#f-addr').value = draft.address || '';
      updateCustomerNote();
      pendingCustomer = null;
    }
  });

  async function boot() {
    try {
      await loadAll();
    } catch (e) {
      view.innerHTML = `<div class="card">Could not open storage on this device: ${esc(e.message)}.<br>If you are in a private/incognito tab, open the app in a normal tab.</div>`;
      return;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW failed', e));
    }
    route();
  }
  boot();

  // Exposed for automated tests only.
  window.__kc = { phoneKey, calcTotals, buildCustomers, state };
})();
