(() => {
  "use strict";

  // 仅阳光版：只保留阳光人寿的产品
  const ONLY_SUNSHINE = !!window.ONLY_SUNSHINE;
  const products = (Array.isArray(window.PRODUCTS) ? window.PRODUCTS : [])
    .filter(p => !ONLY_SUNSHINE || (p.company || "阳光人寿") === "阳光人寿");

  const FILTER_DEFS = [
    {
      key: "company", label: "所属公司", placeholder: "全部",
      options: [["阳光人寿", "阳光人寿"], ["中国人寿", "中国人寿"]],
      get: p => [p.company || "阳光人寿"]
    },
    {
      key: "mainCategory", label: "产品属性", placeholder: "全部",
      options: [["分红", "分红"], ["传统固收", "传统固收"]],
      get: p => [p.mainCategory]
    },
    {
      key: "subcategory", label: "产品分类", placeholder: "全部",
      options: [["增额终身寿", "增额终身寿"], ["杠杆终身寿", "杠杆终身寿"], ["两全", "两全"], ["年金", "年金"], ["其他", "其他"]],
      get: p => [p.subcategory]
    },
    {
      key: "status", label: "产品状态", placeholder: "全部",
      options: [["在售", "在售"], ["停售", "停售"]],
      get: p => [p.status]
    },
    {
      key: "period", label: "保险期间类型", placeholder: "全部",
      options: [["终身", "终身"], ["固定年限", "固定年限"], ["至指定年龄", "至指定年龄"], ["其他", "其他 / 未明确"]],
      get: p => p.basicInfo?.insurancePeriodTypes || [], emptyValue: "其他"
    },
    {
      key: "bucket", label: "保险期间长度", placeholder: "全部",
      options: [["短期", "短期（≤5年）"], ["中期", "中期（6–20年）"], ["长期", "长期（>20年）"], ["未明确", "其他 / 未明确"]],
      get: p => p.basicInfo?.periodBuckets || [], emptyValue: "未明确"
    },
    {
      key: "payment", label: "缴费方式", placeholder: "全部",
      options: [["趸交", "趸交"], ["年交", "年交"], ["半年交", "半年交"], ["季交", "季交"], ["月交", "月交"], ["未明确", "其他 / 未明确"]],
      get: p => p.basicInfo?.paymentDetails || [], emptyValue: "未明确"
    }
  ];

  const selected = {};
  FILTER_DEFS.forEach(def => { selected[def.key] = new Set(); });

  const state = { query: "", onlyUnpinned: false };
  const expanded = new Set();

  // 置顶的产品：按置顶先后顺序保存，刷新后仍保留
  const PIN_KEY = "sinosig.pinnedProducts.v1";
  const pinned = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
    if (Array.isArray(saved)) saved.forEach(id => { if (typeof id === "string") pinned.add(id); });
  } catch (err) { /* 隐私模式或本地存储不可用时忽略 */ }

  function savePins() {
    try { localStorage.setItem(PIN_KEY, JSON.stringify([...pinned])); } catch (err) { /* ignore */ }
  }

  const els = {
    search: document.getElementById("searchInput"),
    clearSearch: document.getElementById("clearSearch"),
    suggestions: document.getElementById("suggestions"),
    results: document.getElementById("results"),
    count: document.getElementById("resultCount"),
    empty: document.getElementById("emptyState"),
    activeFilters: document.getElementById("activeFilters"),
    filterPanel: document.getElementById("filterPanel"),
    mobileFilterToggle: document.getElementById("mobileFilterToggle")
  };

  let suggestionItems = [];
  let activeSuggestion = -1;

  const e = (value) => String(value ?? "未见明确披露")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const normalize = (value) => String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\s·•（）()\-—_]/g, "");
  const docLabels = { terms: "保险条款", rates: "费率表", cash_values: "现价全表", brochure: "产品说明书", history: "往期版本" };

  function searchText(product) {
    return normalize([
      product.id, product.name, product.mainCategory, product.subcategory, product.insuranceType,
      product.basicInfo?.age, product.basicInfo?.paymentPeriod, product.basicInfo?.insurancePeriod,
      ...(product.responsibilities || []).flatMap(item => [item.name, item.summary])
    ].join(" "));
  }

  // 产品编号：YG001 / GS001。用户常少敲前导零（GS1 / YG12），要能对上
  function idMatchLevel(product, term) {
    const m = /^(yg|gs)(\d{1,3})$/.exec(term);
    if (!m) return 0;
    const pid = /^(yg|gs)(\d{1,3})$/i.exec(String(product.id || ""));
    if (!pid) return 0;
    if (pid[1].toLowerCase() !== m[1]) return 0;
    if (Number(pid[2]) !== Number(m[2])) return 0;
    return pid[2] === m[2] ? 3 : 2;     // 连前导零都一致算最高优先级
  }

  function subsequenceScore(query, target) {
    let q = 0;
    let gaps = 0;
    let previous = -1;
    for (let i = 0; i < target.length && q < query.length; i += 1) {
      if (target[i] === query[q]) {
        if (previous >= 0) gaps += i - previous - 1;
        previous = i;
        q += 1;
      }
    }
    return q === query.length ? Math.max(20, 130 - gaps * 2) : 0;
  }

  function scoreProduct(product, rawQuery) {
    const terms = String(rawQuery ?? "").trim().split(/\s+/).map(normalize).filter(Boolean);
    if (!terms.length) return 1;
    const name = normalize(product.name);
    const haystack = searchText(product);
    let total = 0;
    for (const term of terms) {
      let score = 0;
      const idHit = idMatchLevel(product, term);
      if (idHit) score = idHit >= 3 ? 1600 : 1500;
      else if (name === term) score = 1200;
      else if (name.startsWith(term)) score = 800 - name.length;
      else if (name.includes(term)) score = 600 - name.indexOf(term);
      else if (haystack.includes(term)) score = 280;
      else score = subsequenceScore(term, name);
      if (!score) return 0;
      total += score;
    }
    return total;
  }

  // 搜索命中的层级：0 名称/编号完全相同，1 名称包含关键词，2 责任/类型等字段命中，3 仅模糊命中
  function rankProduct(product, rawQuery) {
    const terms = String(rawQuery ?? "").trim().split(/\s+/).map(normalize).filter(Boolean);
    if (!terms.length) return 0;
    const name = normalize(product.name);
    if (terms.length === 1 && idMatchLevel(product, terms[0]) >= 3) return 0;
    if (terms.length === 1 && name === terms[0]) return 0;
    if (terms.every(term => idMatchLevel(product, term) || name.includes(term))) return 1;
    if (terms.every(term => searchText(product).includes(term))) return 2;
    return 3;
  }

  function matchesFilter(product, def) {
    const chosen = selected[def.key];
    if (!chosen.size) return true;
    const values = def.get(product) || [];
    for (const pick of chosen) {
      if (def.emptyValue && pick === def.emptyValue) {
        if (!values.length) return true;
      } else if (values.includes(pick)) {
        return true;
      }
    }
    return false;
  }

  // 默认排序分组：阳光在售 → 国寿在售 → 阳光停售 → 国寿停售
  // （在售优先于停售，同状态下阳光优先于国寿）
  function groupRank(product) {
    const onSale = (product.status || "在售") === "在售" ? 0 : 1;
    const company = (product.company || "阳光人寿") === "阳光人寿" ? 0 : 1;
    return onSale * 2 + company;
  }

  function filteredProducts() {
    const list = products.map(product => ({
      product,
      score: scoreProduct(product, state.query),
      rank: rankProduct(product, state.query)
    }))
      .filter(({ score }) => score > 0)
      .filter(({ product }) => FILTER_DEFS.every(def => matchesFilter(product, def)))
      .filter(({ product }) => !(state.onlyUnpinned && pinned.has(product.id)));
    const order = new Map([...pinned].map((id, index) => [id, index]));
    list.sort((a, b) => {
      const pa = order.has(a.product.id);
      const pb = order.has(b.product.id);
      if (pa && pb) return order.get(a.product.id) - order.get(b.product.id);
      if (pa) return -1;
      if (pb) return 1;
      // 命中层级优先，同层级按「阳光在售 → 国寿在售 → 阳光停售」，最后按编号
      if (state.query && a.rank !== b.rank) return a.rank - b.rank;
      const ga = groupRank(a.product);
      const gb = groupRank(b.product);
      if (ga !== gb) return ga - gb;
      return a.product.id.localeCompare(b.product.id);
    });
    return list;
  }

  function inCompare(id) {
    return !!(window.CompareModule && window.CompareModule.has(id));
  }

  function toast(message) {
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    document.body.appendChild(node);
    requestAnimationFrame(() => node.classList.add("is-show"));
    setTimeout(() => {
      node.classList.remove("is-show");
      setTimeout(() => node.remove(), 240);
    }, 1900);
  }

  // 六个标签用的短标签映射：保险期间类型 / 保险期间长度 / 缴费方式
  const PERIOD_LABEL = {
    "终身": "终身", "固定年限": "固定年限", "至指定年龄": "至指定年龄", "其他": "期间未明确"
  };
  const BUCKET_LABEL = {
    "短期": "短期≤5年", "中期": "中期6–20年", "长期": "长期>20年", "未明确": "长度未明确"
  };
  const PAY_LABEL = {
    "趸交": "趸交", "年交": "年交", "半年交": "半年交", "季交": "季交", "月交": "月交", "未明确": "缴费未明确"
  };

  function joinTags(list, map) {
    const out = [...new Set((list || []).map(v => map[v] || v).filter(Boolean))];
    return out.length ? out.join(" / ") : "";
  }

  function tagMarkup(product) {
    const info = product.basicInfo || {};
    const mainClass = product.mainCategory === "分红" ? "participating" : "";
    const cells = [
      [product.mainCategory, mainClass],
      [product.subcategory, ""],
      [product.status, product.status === "停售" ? "status-off" : ""],
      [joinTags(info.insurancePeriodTypes, PERIOD_LABEL) || "期间未明确", "tag-period"],
      [joinTags(info.periodBuckets, BUCKET_LABEL) || "长度未明确", "tag-period"],
      [joinTags(info.paymentDetails, PAY_LABEL) || "缴费未明确", "tag-pay"]
    ];
    return cells.map(([text, cls]) =>
      `<span class="product-tag ${cls}">${e(text)}</span>`).join("") +
      (product.classificationReview ? '<span class="product-tag review">分类待复核</span>' : "");
  }

  function sourceLabel(source) {
    if (!source) return "来源：公开披露文件";
    const label = docLabels[source.docKey] || source.label || "公开披露文件";
    return `来源：${label}${source.page ? ` · PDF 第 ${source.page} 页` : ""}`;
  }

  function detailMarkup(product) {
    const info = product.basicInfo || {};
    const infoItems = [
      ["可投保年龄", info.age], ["缴费期间", info.paymentPeriod],
      ["保险期间", info.insurancePeriod], ["交费方式", info.paymentMethod],
      ["披露险种", product.insuranceType], ["公开分级分类", product.disclosureClass]
    ];
    const responsibilities = (product.responsibilities || []).map(item => `
      <article class="responsibility-item">
        <h4>${e(item.name)}</h4>
        <p>${e(item.summary)}</p>
        <small class="source-citation">${e(sourceLabel(item.source))}</small>
      </article>`).join("") || '<p class="document-unavailable">本次收录文件中未提取到可确认的责任摘要，请查阅公开条款。</p>';
    const basis = product.classificationBasis || {};
    const documents = Object.entries(product.documents || {}).map(([key, doc]) => `
      <div class="document-row">
        <svg><use href="#icon-file"/></svg>
        <div class="document-name"><strong>${e(doc.label || docLabels[key] || key)}</strong><small>${doc.available === false ? "披露列表未提供" : (doc.error ? "官方链接暂不可用" : (doc.externalNotice ? "需到官网查看历史版本" : (doc.fileType === "xlsx" || doc.fileType === "xls" ? "官方表格文件" : "公开披露文件")))}</small></div>
        ${doc.available === false ? '<span class="document-unavailable">未提供</span>' : (doc.error && !doc.fileUrl && !doc.viewerUrl ? '<span class="document-unavailable">暂不可用</span>' : `<div class="document-links">
          ${doc.externalNotice ? `<a href="${e(doc.fileUrl || product.sourceListUrl)}" target="_blank" rel="noopener noreferrer">官网查看</a>` : (doc.fileUrl ? `<a href="${e(doc.fileUrl)}" target="_blank" rel="noopener noreferrer">${doc.fileType === "xlsx" || doc.fileType === "xls" ? "下载表格" : "官方原文"}</a>` : (doc.viewerUrl ? `<a href="${e(doc.viewerUrl)}" target="_blank" rel="noopener noreferrer">官方原文</a>` : ""))}
        </div>`)}
      </div>`).join("");

    return `
      <section class="detail-section">
        <div class="detail-section-heading"><span>01</span><h3>基本信息</h3></div>
        <div class="info-grid">${infoItems.map(([label, value]) => `<div class="info-item"><label>${label}</label><div>${e(value)}</div></div>`).join("")}</div>
        ${info.dataSourceNote ? `<p class="info-source-note">${e(info.dataSourceNote)}</p>` : ""}
        ${info.missingNote ? `<p class="info-missing-note">${e(info.missingNote)}</p>` : ""}
      </section>
      <section class="detail-section">
        <div class="detail-section-heading"><span>02</span><h3>保险责任概述</h3></div>
        <div class="responsibility-list">${responsibilities}</div>
        ${product.responsibilityNote ? `<p class="info-missing-note">${e(product.responsibilityNote)}</p>` : ""}
      </section>
      ${window.YieldModule ? window.YieldModule.section(product) : ""}
      <section class="detail-section">
        <div class="detail-section-heading"><span>04</span><h3>分类依据</h3></div>
        <div class="classification-box">
          <div class="classification-conclusion">归类：<strong>${e(product.mainCategory)} / ${e(product.subcategory)}</strong>${product.classificationReview ? "（待人工复核）" : ""}</div>
          <blockquote>${e(basis.quote || "请结合产品条款与说明书中的保险期间、保险责任及保额增长机制进行分类。")}</blockquote>
          <small class="source-citation">${e(sourceLabel(basis.source))}</small>
          ${basis.explanation ? `<p>${e(basis.explanation)}</p>` : ""}
        </div>
        ${product.mainCategory === "分红" ? '<div class="disclosure-note">红利利益为非保证利益，实际红利分配可能为零。本页面仅整理公开信息，不对未来红利作任何预测。</div>' : ""}
      </section>
      <section class="detail-section">
        <div class="detail-section-heading"><span>05</span><h3>公开资料来源</h3></div>
        <div class="document-list">${documents}</div>
      </section>
      <div class="detail-foot">
        <button class="act-btn" type="button" data-act="toggle" data-product-id="${e(product.id)}">收起</button>
      </div>`;
  }

  function renderResults() {
    const matches = filteredProducts();
    els.count.textContent = matches.length;
    els.results.hidden = matches.length === 0;
    els.empty.hidden = matches.length !== 0;
    const keepScroll = els.results.scrollTop;
    els.results.innerHTML = matches.map(({ product }, index) => {
      const open = expanded.has(product.id);
      const onCompare = inCompare(product.id);
      const isPinned = pinned.has(product.id);
      return `
      <article class="product-entry${open ? " is-open" : ""}${isPinned ? " is-pinned" : ""}" data-entry-id="${e(product.id)}" style="animation-delay:${Math.min(index, 8) * 25}ms">
        <div class="product-card" data-product-id="${e(product.id)}" role="button" tabindex="0" aria-expanded="${open}" aria-controls="detail-${e(product.id)}">
          <span class="product-number">${e(product.id)}</span>
          <span class="product-main">
            <span class="product-title-row">${tagMarkup(product)}</span>
            <h3>${e(product.name)}</h3>
            <span class="product-meta">
              <span>${e(product.insuranceType)} · ${e(product.disclosureClass)}</span>
              <span>披露 ${e(product.disclosureDate)}</span>
              <span>${e(product.basicInfo?.paymentPeriod)}</span>
            </span>
          </span>
          <span class="product-side">
            <button class="act-btn${isPinned ? " is-on" : ""}" type="button" data-act="pin" data-product-id="${e(product.id)}">${isPinned ? "取消置顶" : "置顶"}</button>
            <button class="act-btn${onCompare ? " is-on" : ""}" type="button" data-act="compare" data-product-id="${e(product.id)}">${onCompare ? "从产品对比中删除" : "加入产品对比"}</button>
            <svg class="product-arrow"><use href="#icon-arrow"/></svg>
          </span>
        </div>
        <div class="product-detail" id="detail-${e(product.id)}" ${open ? "" : "hidden"}></div>
      </article>`;
    }).join("");
    matches.forEach(({ product }) => {
      if (!expanded.has(product.id)) return;
      const detail = els.results.querySelector(`[data-entry-id="${product.id}"] .product-detail`);
      if (!detail) return;
      detail.innerHTML = detailMarkup(product);
      if (window.YieldModule) window.YieldModule.bind(detail, product);
    });
    els.results.scrollTop = keepScroll;
    renderActiveFilters();
  }

  function setEntryOpen(id, open) {
    const entry = els.results.querySelector(`[data-entry-id="${id}"]`);
    const product = products.find(item => item.id === id);
    if (!entry || !product) return;
    const detail = entry.querySelector(".product-detail");
    const card = entry.querySelector(".product-card");
    const isOpen = entry.classList.contains("is-open");
    if (open === isOpen) return;
    if (!open) {
      entry.classList.remove("is-open");
      card.setAttribute("aria-expanded", "false");
      detail.hidden = true;
      expanded.delete(id);
    } else {
      const fresh = !detail.innerHTML.trim();
      if (fresh) detail.innerHTML = detailMarkup(product);
      detail.hidden = false;
      entry.classList.add("is-open");
      card.setAttribute("aria-expanded", "true");
      expanded.add(id);
      // 只在首次渲染后绑定，避免重复展开时叠加事件监听；
      // 同时先显示再绑定，保证曲线能测到真实宽度。
      if (fresh && window.YieldModule) window.YieldModule.bind(detail, product);
    }
    entry.querySelectorAll('[data-act="toggle"]').forEach(btn => {
      btn.textContent = entry.classList.contains("is-open") ? "收起" : "展开";
    });
  }

  function toggleProduct(id) {
    const entry = els.results.querySelector(`[data-entry-id="${id}"]`);
    if (!entry) return;
    setEntryOpen(id, !entry.classList.contains("is-open"));
  }

  function setAllOpen(open) {
    const ids = filteredProducts().map(({ product }) => product.id);
    if (!ids.length) return;
    if (!open) {
      ids.forEach(id => setEntryOpen(id, false));
      toast("已收起全部产品");
      return;
    }
    // 一次性渲染上百个详情会卡住主线程，按帧分批展开
    let i = 0;
    const step = () => {
      const end = Math.min(i + 12, ids.length);
      for (; i < end; i += 1) setEntryOpen(ids[i], true);
      if (i < ids.length) requestAnimationFrame(step);
      else toast(`已展开 ${ids.length} 个产品`);
    };
    step();
  }

  function addAllToCompare() {
    if (!window.CompareModule) return;
    const ids = filteredProducts().map(({ product }) => product.id);
    if (!ids.length) return;
    if (ids.length > window.CompareModule.MAX) {
      toast(`超出产品对比数量上限，最多同时对比 ${window.CompareModule.MAX} 个产品`);
      return;
    }
    let added = 0;
    ids.forEach(id => {
      if (window.CompareModule.has(id)) return;
      if (window.CompareModule.toggle(id)) added += 1;
    });
    syncCompareButtons();
    toast(added ? `已加入 ${added} 个产品` : "所选产品均已在对比清单中");
  }

  function syncPinToolbar() {
    const btn = document.getElementById("onlyUnpinned");
    if (!btn) return;
    btn.classList.toggle("is-on", state.onlyUnpinned);
    btn.setAttribute("aria-pressed", String(state.onlyUnpinned));
  }

  function togglePin(id) {
    const product = products.find(item => item.id === id);
    if (pinned.has(id)) {
      pinned.delete(id);
      toast(`已取消置顶：${product ? product.name : id}`);
    } else {
      pinned.add(id);
      toast(`已置顶：${product ? product.name : id}`);
    }
    savePins();
    renderResults();
  }

  function pinAllVisible() {
    const ids = filteredProducts().map(({ product }) => product.id);
    let added = 0;
    ids.forEach(id => { if (!pinned.has(id)) { pinned.add(id); added += 1; } });
    savePins();
    renderResults();
    toast(added ? `已置顶 ${added} 个产品` : "当前列表中的产品都已置顶");
  }

  function unpinAll() {
    if (!pinned.size) { toast("当前没有置顶的产品"); return; }
    const count = pinned.size;
    pinned.clear();
    savePins();
    renderResults();
    toast(`已取消全部置顶（${count} 个）`);
  }

  function toggleOnlyUnpinned() {
    state.onlyUnpinned = !state.onlyUnpinned;
    syncPinToolbar();
    renderResults();
    toast(state.onlyUnpinned ? "已隐藏置顶的产品" : "已显示全部产品");
  }

  function addPinnedToCompare() {
    if (!window.CompareModule) return;
    const ids = [...pinned];
    if (!ids.length) { toast("还没有置顶任何产品"); return; }
    if (ids.length > window.CompareModule.MAX) {
      toast(`超出产品对比数量上限，最多同时对比 ${window.CompareModule.MAX} 个产品`);
      return;
    }
    let added = 0;
    ids.forEach(id => {
      if (window.CompareModule.has(id)) return;
      if (window.CompareModule.toggle(id)) added += 1;
    });
    syncCompareButtons();
    toast(added ? `已加入 ${added} 个置顶产品` : "置顶产品均已在对比清单中");
  }

  function clearCompareList() {
    if (!window.CompareModule) return;
    if (!window.CompareModule.count()) { toast("对比清单本来就是空的"); return; }
    window.CompareModule.clear();
    syncCompareButtons();
    toast("已清空对比清单");
  }

  function optionLabel(def, value) {
    const found = def.options.find(([val]) => val === value);
    return found ? found[1] : value;
  }

  function renderActiveFilters() {
    const chips = [];
    if (state.query) chips.push(`<button class="filter-chip" type="button" data-clear-filter="query">搜索：${e(state.query)} ×</button>`);
    FILTER_DEFS.forEach(def => {
      selected[def.key].forEach(value => {
        chips.push(`<button class="filter-chip" type="button" data-clear-filter="${def.key}" data-clear-value="${e(value)}">${e(optionLabel(def, value))} ×</button>`);
      });
    });
    els.activeFilters.innerHTML = chips.join("");
  }

  function syncField(def) {
    const field = document.querySelector(`.filter-field[data-key="${def.key}"]`);
    if (!field) return;
    const toggle = field.querySelector(".multi-toggle");
    const value = field.querySelector(".multi-value");
    const chosen = selected[def.key];
    toggle.setAttribute("aria-expanded", String(field.classList.contains("is-open")));
    if (!chosen.size) value.textContent = def.placeholder;
    else if (chosen.size === 1) value.textContent = optionLabel(def, [...chosen][0]);
    else value.textContent = `已选 ${chosen.size} 项`;
    if (chosen.size) value.classList.add("is-active");
    else value.classList.remove("is-active");
    field.querySelectorAll(".multi-option").forEach(label => {
      const on = chosen.has(label.dataset.value);
      label.classList.toggle("is-on", on);
      label.querySelector("input").checked = on;
    });
  }

  // 筛选栏现在是独立滚动容器，下拉菜单改用 fixed 定位，避免被滚动容器裁掉
  function placeMenu(toggle, menu) {
    const rect = toggle.getBoundingClientRect();
    const count = menu.querySelectorAll(".multi-option").length;
    const natural = Math.min(244, count * 33 + 12);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openUp = below < Math.min(natural, 200) && above > below;
    const height = Math.max(80, Math.min(natural, openUp ? above : below, window.innerHeight - 24));
    let top = openUp ? rect.top - height - 4 : rect.bottom + 4;
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    menu.style.position = "fixed";
    menu.style.left = `${rect.left}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.maxHeight = `${height}px`;
    menu.style.top = `${top}px`;
  }

  function closeMenus(except) {
    document.querySelectorAll(".filter-field.is-open").forEach(field => {
      if (field === except) return;
      field.classList.remove("is-open");
      const menu = field.querySelector(".multi-menu");
      if (menu) { menu.hidden = true; menu.removeAttribute("style"); }
      const def = FILTER_DEFS.find(item => item.key === field.dataset.key);
      if (def) syncField(def);
    });
  }

  function buildFilters() {
    FILTER_DEFS.forEach(def => {
      const field = document.querySelector(`.filter-field[data-key="${def.key}"]`);
      if (!field) return;
      field.innerHTML = `
        <span class="filter-label">${def.label}</span>
        <button class="multi-toggle" type="button" aria-expanded="false" aria-controls="menu-${def.key}">
          <span class="multi-value">${def.placeholder}</span>
          <svg class="multi-caret"><use href="#icon-arrow"/></svg>
        </button>
        <div class="multi-menu" id="menu-${def.key}" hidden>
          ${def.options.map(([value, label]) => `<label class="multi-option" data-value="${e(value)}"><input type="checkbox" value="${e(value)}"><span>${e(label)}</span></label>`).join("")}
        </div>`;

      const toggle = field.querySelector(".multi-toggle");
      const menu = field.querySelector(".multi-menu");
      toggle.addEventListener("click", event => {
        event.stopPropagation();
        const willOpen = !field.classList.contains("is-open");
        closeMenus();
        field.classList.toggle("is-open", willOpen);
        menu.hidden = !willOpen;
        if (willOpen) {
          placeMenu(toggle, menu);
          // 布局稳定后再校正一次，避免容器刚滚动完拿到旧坐标
          requestAnimationFrame(() => { if (!menu.hidden) placeMenu(toggle, menu); });
        } else menu.removeAttribute("style");
        syncField(def);
      });
      menu.addEventListener("click", event => event.stopPropagation());
      menu.addEventListener("change", event => {
        const input = event.target.closest("input[type=checkbox]");
        if (!input) return;
        if (input.checked) selected[def.key].add(input.value);
        else selected[def.key].delete(input.value);
        syncField(def);
        renderResults();
      });
    });
    document.addEventListener("click", () => closeMenus());
  }

  function resetAll() {
    FILTER_DEFS.forEach(def => selected[def.key].clear());
    state.onlyUnpinned = false;
    syncPinToolbar();
    FILTER_DEFS.forEach(syncField);
    state.query = "";
    els.search.value = "";
    els.clearSearch.hidden = true;
    expanded.clear();
    hideSuggestions();
    renderResults();
  }

  function hideSuggestions() {
    els.suggestions.hidden = true;
    els.search.setAttribute("aria-expanded", "false");
    activeSuggestion = -1;
  }

  function renderSuggestions() {
    const query = state.query.trim();
    if (!query) { hideSuggestions(); return; }
    suggestionItems = products.map(product => ({
      product,
      score: scoreProduct(product, query),
      rank: rankProduct(product, query)
    }))
      .filter(item => item.score > 0)
      .sort((a, b) => (a.rank - b.rank) || a.product.id.localeCompare(b.product.id))
      .slice(0, 6).map(item => item.product);
    if (!suggestionItems.length) { hideSuggestions(); return; }
    els.suggestions.innerHTML = suggestionItems.map((product, index) => `
      <button class="suggestion-item" type="button" role="option" data-product-id="${e(product.id)}" data-index="${index}" aria-selected="false">
        <span class="suggestion-id">${e(product.id)}</span><span class="suggestion-name">${e(product.name)}</span><span class="suggestion-type">${e(product.subcategory)} · ${e(product.status)}</span>
      </button>`).join("");
    els.suggestions.hidden = false;
    els.search.setAttribute("aria-expanded", "true");
    activeSuggestion = -1;
  }

  function updateActiveSuggestion() {
    const buttons = els.suggestions.querySelectorAll(".suggestion-item");
    buttons.forEach((button, index) => {
      const active = index === activeSuggestion;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      if (active) button.scrollIntoView({ block: "nearest" });
    });
  }

  function revealProduct(id) {
    const entry = els.results.querySelector(`[data-entry-id="${id}"]`);
    if (!entry) return;
    if (!entry.classList.contains("is-open")) toggleProduct(id);
    entry.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    els.clearSearch.hidden = !state.query;
    renderResults();
    renderSuggestions();
  });
  els.search.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !els.suggestions.hidden) {
      event.preventDefault(); activeSuggestion = (activeSuggestion + 1) % suggestionItems.length; updateActiveSuggestion();
    } else if (event.key === "ArrowUp" && !els.suggestions.hidden) {
      event.preventDefault(); activeSuggestion = (activeSuggestion - 1 + suggestionItems.length) % suggestionItems.length; updateActiveSuggestion();
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault(); hideSuggestions(); revealProduct(suggestionItems[activeSuggestion].id);
    } else if (event.key === "Escape") { hideSuggestions(); }
  });
  els.suggestions.addEventListener("click", event => {
    const button = event.target.closest("[data-product-id]");
    if (button) { hideSuggestions(); revealProduct(button.dataset.productId); }
  });
  function toggleCompare(id) {
    if (!window.CompareModule) return;
    const ok = window.CompareModule.toggle(id);
    if (!ok) {
      toast(`最多同时对比 ${window.CompareModule.MAX} 个产品`);
      return;
    }
    const on = window.CompareModule.has(id);
    document.querySelectorAll(`[data-act="compare"][data-product-id="${id}"]`).forEach(btn => {
      btn.classList.toggle("is-on", on);
      btn.textContent = on ? "从产品对比中删除" : "加入产品对比";
    });
  }

  els.results.addEventListener("click", event => {
    const act = event.target.closest("[data-act]");
    if (act) {
      event.preventDefault();
      event.stopPropagation();
      if (act.dataset.act === "toggle") toggleProduct(act.dataset.productId);
      else if (act.dataset.act === "compare") toggleCompare(act.dataset.productId);
      else if (act.dataset.act === "pin") togglePin(act.dataset.productId);
      return;
    }
    const card = event.target.closest(".product-card");
    if (card) toggleProduct(card.dataset.productId);
  });
  // 双击展开内容里的空白处：收起该产品，并把它滚到列表顶部
  els.results.addEventListener("dblclick", event => {
    const detail = event.target.closest(".product-detail");
    if (!detail) return;
    if (event.target.closest("button, a, input, select, label, [role='button']")) return;
    const entry = detail.closest(".product-entry");
    if (!entry || !entry.classList.contains("is-open")) return;
    event.preventDefault();
    const id = entry.dataset.entryId;
    setEntryOpen(id, false);
    // 收起后立刻按新布局重新定位，把这个产品顶到列表最上方
    const listRect = els.results.getBoundingClientRect();
    const entryRect = entry.getBoundingClientRect();
    els.results.scrollTop += entryRect.top - listRect.top;
  });

  els.results.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".product-card");
    if (card && event.target === card) {
      event.preventDefault();
      toggleProduct(card.dataset.productId);
    }
  });
  els.clearSearch.addEventListener("click", () => { state.query = ""; els.search.value = ""; els.clearSearch.hidden = true; hideSuggestions(); renderResults(); els.search.focus(); });

  els.activeFilters.addEventListener("click", event => {
    const chip = event.target.closest("[data-clear-filter]");
    if (!chip) return;
    const key = chip.dataset.clearFilter;
    if (key === "query") {
      state.query = ""; els.search.value = ""; els.clearSearch.hidden = true;
    } else {
      const def = FILTER_DEFS.find(item => item.key === key);
      if (def) {
        selected[key].delete(chip.dataset.clearValue);
        syncField(def);
      }
    }
    renderResults();
  });

  document.getElementById("resetFilters").addEventListener("click", resetAll);
  document.getElementById("emptyReset").addEventListener("click", resetAll);
  document.getElementById("collapseAll").addEventListener("click", () => setAllOpen(false));
  document.getElementById("addAllCompare").addEventListener("click", addAllToCompare);
  document.getElementById("pinAll").addEventListener("click", pinAllVisible);
  document.getElementById("unpinAll").addEventListener("click", unpinAll);
  document.getElementById("onlyUnpinned").addEventListener("click", toggleOnlyUnpinned);
  document.getElementById("addPinnedCompare").addEventListener("click", addPinnedToCompare);
  document.getElementById("clearCompareTop").addEventListener("click", clearCompareList);
  els.mobileFilterToggle.addEventListener("click", () => {
    const open = els.filterPanel.classList.toggle("open");
    els.mobileFilterToggle.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", event => { if (!event.target.closest(".search-shell")) hideSuggestions(); });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenus(); });

  // 筛选栏改成横向一条后不再有内部滚动，菜单位置随窗口变化时收起即可
  window.addEventListener("resize", () => closeMenus());

  function syncCompareButtons() {
    document.querySelectorAll('[data-act="compare"]').forEach(btn => {
      const on = window.CompareModule && window.CompareModule.has(btn.dataset.productId);
      btn.classList.toggle("is-on", on);
      btn.textContent = on ? "从产品对比中删除" : "加入产品对比";
    });
  }

  function switchView(view) {
    const isCompare = view === "compare";
    document.getElementById("listView").hidden = isCompare;
    document.getElementById("compareView").hidden = !isCompare;
    document.querySelectorAll(".view-btn").forEach(btn => {
      const on = btn.dataset.view === view;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    if (isCompare) {
      if (window.SimilarModule) window.SimilarModule.close();
      if (window.CompareModule) window.CompareModule.render();
    } else {
      syncCompareButtons();
    }
    window.scrollTo({ top: 0 });
  }

  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  const clearCmp = document.getElementById("clearCompare");
  if (clearCmp) clearCmp.addEventListener("click", () => {
    if (window.CompareModule) window.CompareModule.clear();
    syncCompareButtons();
    toast("已清空对比清单");
  });
  ["backToList", "compareGoList"].forEach(id => {
    const node = document.getElementById(id);
    if (node) node.addEventListener("click", () => switchView("list"));
  });

  window.AppAPI = {
    switchView,
    syncCompareButtons,
    toast,
    // 对比页的「置顶 / 取消置顶」按钮要读改同一份置顶集合
    isPinned: id => pinned.has(id),
    togglePin,
    focusProduct(id) {
      switchView("list");
      resetAll();
      requestAnimationFrame(() => revealProduct(id));
    }
  };
  if (window.CompareModule) window.CompareModule.bind();
  if (window.SimilarModule) window.SimilarModule.bind();

  buildFilters();
  FILTER_DEFS.forEach(syncField);
  syncPinToolbar();
  renderResults();
})();
