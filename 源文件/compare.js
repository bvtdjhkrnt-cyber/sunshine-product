/* 产品对比模块
 * 结构沿用单个产品的三段：基本信息 / 保险责任概述 / 收益率分析。
 * 收益率分析要求所有参与对比的产品取同一个模型点，因此模型点以"归一化的四元组"
 * （性别 / 投保年龄 / 缴费年数 / 保险期间终点年龄）为唯一标识，取各产品实际存在
 * 曲线的四元组的交集，保证选出来的点每家都算得出。
 */
(function () {
  const MAX = 4;
  const DIM = { 交费期间: "pay", 交费年期: "pay", 缴费期间: "pay", 保险期间: "term", 保障期间: "term", 性别: "sex", 投保年龄: "age" };
  const DIM_LIST = [
    ["sex", "性别"],
    ["age", "投保年龄"],
    ["pay", "交费期间"],
    ["end", "保险期间"],
  ];
  const COLORS = ["#a9812f", "#245d4c", "#b4451f", "#2f6ea8"];

  const state = { ids: [], tuple: null, detailOpen: false, chartOpen: false, mode: null, picks: {} };

  const el = () => ({
    body: document.getElementById("compareBody"),
    empty: document.getElementById("compareEmpty"),
    sub: document.getElementById("compareSub"),
    badge: document.getElementById("compareBadge"),
  });

  function products() { return Array.isArray(window.PRODUCTS) ? window.PRODUCTS : []; }
  function byId(id) { return products().find(p => p.id === id) || null; }
  function withYield() { return state.ids.filter(id => window.YieldModule && window.YieldModule.has(id)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function endAgeOf(term, age) {
    if (!term) return null;
    if (term.indexOf("终身") >= 0) return "WL";
    let m = term.match(/(\d{2,3})\s*周岁/);
    if (m) return Number(m[1]);
    m = term.match(/(\d+)\s*年/);
    if (m) return age + Number(m[1]);
    return null;
  }

  function partsOf(rec, key) {
    const parts = key.split("|");
    const o = {};
    rec.cols.forEach((c, i) => { if (DIM[c]) o[DIM[c]] = parts[i]; });
    return o;
  }

  function tupleOf(rec, key) {
    if (!rec || !key) return null;
    const o = partsOf(rec, key);
    const age = parseInt(o.age, 10);
    if (isNaN(age)) return null;
    const hasPay = rec.cols.some(c => DIM[c] === "pay");
    const payYears = hasPay ? window.YieldModule.payYears(rec, o) : 1;
    const end = endAgeOf(o.term, age);
    if (end === null) return null;
    return { sex: o.sex, age, pay: payYears, end };
  }

  function tupleId(t) { return [t.sex, t.age, t.pay, t.end].join("|"); }

  function payYearsOfText(pay) {
    if (!pay) return null;
    if (String(pay).indexOf("趸") >= 0 || String(pay).indexOf("一次性") >= 0) return 1;
    const m = String(pay).match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  // 说明书示例模型点 → 四元组（与现价曲线同一套判定）
  function tupleOfDef(d) {
    if (!d) return null;
    const age = parseInt(d.age, 10);
    if (isNaN(age)) return null;
    const pay = payYearsOfText(d.pay);
    const end = endAgeOf(d.term, age);
    if (pay === null || end === null) return null;
    return { sex: d.sex, age, pay, end };
  }

  function isDemo(id) { return !!(window.YieldModule && window.YieldModule.isDemo(id)); }

  // 该产品实际可用于「同一模型点」的四元组
  function tuplesOf(id) {
    const rec = window.YieldModule.record(id);
    const map = new Map();
    if (!rec) return map;
    if (rec.demoOnly) {
      (rec.defs || []).forEach((d, i) => {
        const t = tupleOfDef(d);
        if (!t) return;
        const tid = tupleId(t);
        if (!map.has(tid)) map.set(tid, { defIdx: i });
      });
      return map;
    }
    Object.keys(rec.curves).forEach(key => {
      const t = tupleOf(rec, key);
      if (!t) return;
      const tid = tupleId(t);
      if (!map.has(tid)) map.set(tid, { key });
    });
    return map;
  }

  // 所有参与产品共有的四元组
  function intersectTuples() {
    const ids = withYield();
    if (!ids.length) return new Map();
    let acc = null;
    ids.forEach(id => {
      const map = tuplesOf(id);
      if (acc === null) acc = new Map(map);
      else {
        for (const k of Array.from(acc.keys())) {
          if (!map.has(k)) acc.delete(k);
        }
      }
    });
    return acc || new Map();
  }

  function tupleInfo(tid) {
    const [sex, age, pay, end] = tid.split("|");
    return { sex, age: Number(age), pay: pay === "null" ? null : Number(pay), end: end === "WL" ? "WL" : Number(end) };
  }

  function labelFor(info) {
    if (!info) return "";
    const payTxt = info.pay == null ? "—" : (info.pay === 1 ? "趸交" : `${info.pay} 年交`);
    const endTxt = info.end === "WL" ? "保终身" : `保至 ${info.end} 岁`;
    return `${info.age} 岁${info.sex || ""} ｜ ${payTxt} ｜ ${endTxt}`;
  }

  function currentInfo() { return state.tuple ? tupleInfo(state.tuple) : null; }

  function defTuple(id, idx) {
    const def = window.YieldModule.defs(id)[idx];
    const rec = window.YieldModule.record(id);
    if (!def || !rec) return null;
    if (rec.demoOnly) {
      const t = tupleOfDef(def);
      return t ? tupleId(t) : null;
    }
    const key = window.YieldModule.keyOf(id, def);
    return tupleOf(rec, key) ? tupleId(tupleOf(rec, key)) : null;
  }

  // 公共模型点是否存在（只看各产品自身能力，与当前选择无关）
  function sameCapable() {
    return intersectTuples().size > 0;
  }

  // 进入/切换产品组合时决定默认模式：能同一模型点就同一，否则不同。
  // 手动把各列调成同一点后也允许停在「同一模型点」模式。
  function ensureMode() {
    const capable = sameCapable();
    if (state.mode !== "same" && state.mode !== "diff") state.mode = capable ? "same" : "diff";
    if (state.mode === "same" && !capable && !alignedNow()) state.mode = "diff";
    return capable;
  }

  // 「同一模型点」按钮是否可点：产品本身有公共点，或当前各列恰好一致
  function canSame() {
    return sameCapable() || !!alignedNow();
  }

  function ensureSel() {
    const inter = intersectTuples();
    if (!inter.size) { state.tuple = null; return inter; }
    if (!state.tuple || !inter.has(state.tuple)) {
      let picked = null;
      const first = withYield()[0];
      if (first) {
        const n = window.YieldModule.defs(first).length;
        for (let i = 0; i < n; i += 1) {
          const tid = defTuple(first, i);
          if (tid && inter.has(tid)) { picked = tid; break; }
        }
      }
      state.tuple = picked || inter.keys().next().value;
    }
    return inter;
  }

  // 每个产品在当前四元组下对应的标签组合
  function selFor(id) {
    const rec = window.YieldModule.record(id);
    if (!rec || !state.tuple) return null;
    if (rec.demoOnly) {
      const defs = window.YieldModule.defs(id);
      for (let i = 0; i < defs.length; i += 1) {
        if (defTuple(id, i) === state.tuple) return { defIdx: i };
      }
      return null;
    }
    const keys = Object.keys(rec.curves);
    for (const key of keys) {
      const t = tupleOf(rec, key);
      if (!t || tupleId(t) !== state.tuple) continue;
      const o = partsOf(rec, key);
      return { sex: o.sex, age: o.age, pay: o.pay, term: o.term };
    }
    return null;
  }

  // ---------- 逐产品模型点（不同模型点模式） ----------

  function initPicks() {
    const next = {};
    withYield().forEach(id => {
      const d = defaultPickOf(id);
      if (d) next[id] = d;
    });
    state.picks = next;
  }

  // 产品的示例模型点：自由设定类取现价表里说明书给的示例点（可能有多套），年金取第 1 个示例
  function defaultPicksOf(id) {
    const rec = window.YieldModule.record(id);
    if (!rec) return [];
    if (rec.demoOnly) return [{ defIdx: 0 }];
    const list = (rec.defs && rec.defs.length) ? rec.defs : (rec.def ? [rec.def] : []);
    return list.map(d => ({ sex: d.sex, age: d.age, pay: d.pay, term: d.term }));
  }

  function defaultPickOf(id) {
    return defaultPicksOf(id)[0] || null;
  }

  // 当前各列停在第几套示例模型点上；-1 表示已改动
  function defaultMatch(id) {
    const list = defaultPicksOf(id);
    const p = pickOf(id);
    if (!p || !list.length) return -1;
    for (let i = 0; i < list.length; i += 1) {
      const d = list[i];
      const hit = d.defIdx !== undefined
        ? (p.defIdx || 0) === d.defIdx
        : ["sex", "age", "pay", "term"].every(k => String(p[k]) === String(d[k]));
      if (hit) return i;
    }
    return -1;
  }

  // 从当前「同一模型点」切到逐列设定时，先把各列对齐到同一点，避免跳变
  function seedPicksFromTuple() {
    const next = {};
    withYield().forEach(id => {
      const rec = window.YieldModule.record(id);
      if (!rec) return;
      if (rec.demoOnly) {
        const defs = window.YieldModule.defs(id);
        let idx = 0;
        if (state.tuple) {
          for (let i = 0; i < defs.length; i += 1) {
            if (defTuple(id, i) === state.tuple) { idx = i; break; }
          }
        }
        next[id] = { defIdx: idx };
        return;
      }
      const sel = state.tuple ? selFor(id) : null;
      if (sel && sel.sex !== undefined) next[id] = { sex: sel.sex, age: sel.age, pay: sel.pay, term: sel.term };
      else {
        const d0 = (rec.defs && rec.defs[0]) ? rec.defs[0] : rec.def;
        next[id] = { sex: d0.sex, age: d0.age, pay: d0.pay, term: d0.term };
      }
    });
    state.picks = next;
  }

  function pickOf(id) {
    const rec = window.YieldModule.record(id);
    if (!rec) return null;
    if (!state.picks[id]) state.picks[id] = defaultPickOf(id) || {};
    return state.picks[id];
  }

  // 当前每个产品实际使用的四元组（不同模型点模式下判断是否"恰好一致"）
  function pickTuple(id) {
    const rec = window.YieldModule.record(id);
    if (!rec) return null;
    if (rec.demoOnly) return defTuple(id, pickOf(id).defIdx);
    const p = pickOf(id);
    const pay = window.YieldModule.payYears(rec, p);
    const end = endAgeOf(p.term, parseInt(p.age, 10));
    if (end === null) return null;
    return [p.sex, parseInt(p.age, 10), pay, end].join("|");
  }

  function alignedNow() {
    const ids = withYield();
    if (ids.length < 2) return null;
    let first = null;
    for (const id of ids) {
      const tid = pickTuple(id);
      if (!tid) return null;
      if (first === null) first = tid;
      else if (tid !== first) return null;
    }
    return first;
  }

  // 年金示例序列的 irr 是小数，现价曲线序列是百分数，这里统一成百分数
  function demoForCompare(id, idx) {
    const s = window.YieldModule.demoSeries(id, idx);
    if (!s) return null;
    const rows = s.rows.map(r => Object.assign({}, r, {
      irr: r.irr === null ? null : r.irr * 100,
      divIrr: r.divIrr === null ? null : r.divIrr * 100,
    }));
    const byT = new Map(rows.map(r => [r.t, r]));
    return Object.assign({}, s, {
      rows,
      end: byT.get(s.end.t) || rows[rows.length - 1],
      endD: s.endD ? (byT.get(s.endD.t) || null) : null,
    });
  }

  // 参与对比的产品各自的时间序列
  function seriesFor(id) {
    if (!window.YieldModule.has(id)) return null;
    if (state.mode === "same") {
      const sel = selFor(id);
      if (!sel) return null;
      return isDemo(id) ? demoForCompare(id, sel.defIdx) : window.YieldModule.series(id, sel);
    }
    const p = pickOf(id);
    if (isDemo(id)) return demoForCompare(id, p.defIdx);
    return window.YieldModule.series(id, p);
  }

  function updateBadge() {
    const { badge, sub } = el();
    if (badge) {
      badge.textContent = String(state.ids.length);
      badge.hidden = state.ids.length === 0;
    }
    if (sub) sub.textContent = state.ids.length ? `　${state.ids.length} 个产品` : "";
  }

  function toggle(id) {
    const i = state.ids.indexOf(id);
    if (i >= 0) state.ids.splice(i, 1);
    else {
      if (state.ids.length >= MAX) return false;
      state.ids.push(id);
      state.tuple = null;
    }
    state.mode = null;
    ensureSel();
    ensureMode();
    initPicks();
    updateBadge();
    saveIds();
    render();
    if (window.AppAPI && window.AppAPI.syncCompareButtons) window.AppAPI.syncCompareButtons();
    return true;
  }

  function remove(id) {
    const i = state.ids.indexOf(id);
    if (i >= 0) state.ids.splice(i, 1);
    state.tuple = null;
    state.mode = null;
    ensureSel();
    ensureMode();
    initPicks();
    updateBadge();
    saveIds();
    render();
    if (window.AppAPI && window.AppAPI.syncCompareButtons) window.AppAPI.syncCompareButtons();
  }

  function clear() {
    state.ids = [];
    state.tuple = null;
    state.mode = null;
    state.picks = {};
    updateBadge();
    saveIds();
    render();
  }

  function has(id) { return state.ids.indexOf(id) >= 0; }
  function count() { return state.ids.length; }

  // 对比列表存本地，刷新后仍在（与「置顶」同一套做法，但键名独立）
  const STORE_KEY = "sinosig.compareIds.v1";

  function saveIds() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.ids));
    } catch (e) { /* 隐私模式下写入失败时不影响页面 */ }
  }

  function restoreIds() {
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    } catch (e) { saved = []; }
    if (!Array.isArray(saved)) return;
    const valid = saved.filter(id => byId(id)).slice(0, MAX);
    if (!valid.length) return;
    state.ids = valid;
    state.tuple = null;
    state.mode = null;
    ensureSel();
    ensureMode();
    initPicks();
    updateBadge();
    render();
    if (window.AppAPI && window.AppAPI.syncCompareButtons) window.AppAPI.syncCompareButtons();
  }

  function colgroup(n) {
    return `<colgroup><col class="col-label">${Array.from({ length: n }, () => '<col class="col-prod">').join("")}</colgroup>`;
  }

  function infoRows() {
    return [
      ["产品分类", p => `${p.mainCategory} / ${p.subcategory}`],
      ["销售状态", p => p.status],
      ["可投保年龄", p => p.basicInfo?.age],
      ["缴费期间", p => p.basicInfo?.paymentPeriod],
      ["保险期间", p => p.basicInfo?.insurancePeriod],
      ["交费方式", p => p.basicInfo?.paymentMethod],
      ["披露日期", p => p.disclosureDate],
    ];
  }

  // 每个产品表头下方的三个操作按钮：删除 / 置顶 / 查看详情
  function actButtons(id) {
    const pinOn = !!(window.AppAPI && window.AppAPI.isPinned && window.AppAPI.isPinned(id));
    return `<div class="cmp-pactions">
          <button type="button" class="chip-btn" data-cmp-remove="${esc(id)}">删除</button>
          <button type="button" class="chip-btn${pinOn ? " is-on" : ""}" data-cmp-pin="${esc(id)}">${pinOn ? "取消置顶" : "置顶"}</button>
          <button type="button" class="chip-btn" data-cmp-jump="${esc(id)}">查看详情</button>
        </div>`;
  }

  function headCells() {
    return state.ids.map(id => {
      const p = byId(id);
      if (!p) return "";
      return `<th class="cmp-product-head">
        <div class="cmp-pid">${esc(p.id)}</div>
        <div class="cmp-pname">${esc(p.name)}</div>
        ${actButtons(p.id)}
      </th>`;
    }).join("");
  }

  function basicTable() {
    return `<div class="cmp-block">
      <h3 class="cmp-title">基本信息</h3>
      <div class="cmp-table-wrap"><table class="cmp-table">
        ${colgroup(state.ids.length)}
        <thead><tr><th class="cmp-label"></th>${headCells()}</tr></thead>
        <tbody>${infoRows().map(([label, get]) => `<tr>
          <th class="cmp-label">${label}</th>
          ${state.ids.map(id => `<td>${esc(get(byId(id)) || "未见明确披露")}</td>`).join("")}
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  }

  function respTable() {
    const cells = state.ids.map(id => {
      const p = byId(id);
      const list = (p.responsibilities || []).map(r =>
        `<li><strong>${esc(r.name)}</strong><span>${esc(r.summary)}</span></li>`).join("");
      return `<td class="cmp-resp-cell"><ul class="cmp-resp">${list || "<li>本次收录文件中未提取到可确认的责任摘要。</li>"}</ul></td>`;
    }).join("");
    return `<div class="cmp-block">
      <h3 class="cmp-title">保险责任概述</h3>
      <div class="cmp-table-wrap"><table class="cmp-table cmp-table-resp">
        ${colgroup(state.ids.length)}
        <thead><tr><th class="cmp-label"></th>${headCells()}</tr></thead>
        <tbody><tr><th class="cmp-label">责任内容</th>${cells}</tr></tbody>
      </table></div>
    </div>`;
  }

  // ---------- 对比模式：同一模型点 / 不同模型点 ----------
  function yieldHead(capable) {
    const sameCls = state.mode === "same" ? " is-on" : (capable ? "" : " is-off");
    const diffCls = state.mode === "diff" ? " is-on" : "";
    return `<div class="cmp-yield-head">
      <h3 class="cmp-title">收益率分析</h3>
      <div class="cmp-mode" role="group" aria-label="对比模式">
        <button type="button" class="cmp-mode-btn${sameCls}" data-cmp-mode="same">同一模型点</button>
        <button type="button" class="cmp-mode-btn${diffCls}" data-cmp-mode="diff">不同模型点</button>
      </div>
    </div>`;
  }

  function modelPointBar(inter) {
    const ids = withYield();
    if (!ids.length || !inter || !inter.size) return "";
    const cur = currentInfo();

    const opts = {};
    DIM_LIST.forEach(([dim]) => {
      const seen = {};
      for (const tid of inter.keys()) {
        const i = tupleInfo(tid);
        const v = dim === "end" ? (i.end === "WL" ? "WL" : String(i.end)) : String(i[dim]);
        seen[v] = true;
      }
      opts[dim] = Object.keys(seen).sort((a, b) => {
        if (a === "WL") return 1;
        if (b === "WL") return -1;
        if (dim === "sex") return a.localeCompare(b, "zh");
        return Number(a) - Number(b);
      });
    });

    const pretty = (dim, v) => {
      if (dim === "pay") return v === "null" ? "—" : (Number(v) === 1 ? "趸交" : `${v} 年交`);
      if (dim === "end") return v === "WL" ? "保终身" : `保至 ${v} 岁`;
      return v;
    };

    const selects = DIM_LIST.filter(([dim]) => opts[dim].length > 1).map(([dim, label]) => {
      const v = dim === "end" ? (cur.end === "WL" ? "WL" : String(cur.end))
        : dim === "sex" ? cur.sex : String(cur[dim]);
      return `<label class="cmp-mp-field"><span>${label}</span>
        <select data-cmp-mp="${dim}">
          ${opts[dim].map(o => `<option value="${esc(o)}"${String(o) === v ? " selected" : ""}>${esc(pretty(dim, o))}</option>`).join("")}
        </select></label>`;
    }).join("");

    const resets = ids.map(id => {
      const defs = window.YieldModule.defs(id);
      const p = byId(id);
      if (!defs.length) return "";
      return defs.map((d, i) => {
        const label = ids.length > 1
          ? `${esc(p?.id || "")}-${i + 1}`
          : (defs.length > 1 ? `恢复示例${i + 1}` : "恢复示例");
        return `<button type="button" class="cmp-reset" data-cmp-reset="${esc(id)}" data-cmp-idx="${i}"
          title="${esc(`${p?.name || ""}｜${d.age} 岁${d.sex}、${d.pay}`)}">${label}</button>`;
      }).join("");
    }).join("");

    return `<div class="cmp-mp">
      <div class="cmp-mp-main">
        <span class="cmp-mp-title">对比模型点</span>
        ${selects}
        <span class="cmp-mp-value">${esc(labelFor(cur))}</span>
      </div>
      <div class="cmp-mp-reset"><span class="cmp-mp-title">恢复示例</span>${resets}</div>
    </div>`;
  }

  // 不同模型点模式：每个产品各自设定（年金只能切换说明书示例）
  function mpTableHtml(ids) {
    if (!ids.length) return "";
    const anyDemo = ids.some(isDemo);
    const head = ids.map(id => {
      const p = byId(id);
      return `<th class="cmp-product-head">
        <div class="cmp-pid">${esc(p?.id || "")}</div>
        <div class="cmp-pname">${esc(p?.name || "")}</div>${actButtons(id)}</th>`;
    }).join("");

    const demoDef = id => {
      const defs = window.YieldModule.defs(id);
      return defs[pickOf(id).defIdx] || defs[0] || null;
    };

    const dimRow = (label, field, pretty) => [`${label}`, id => {
      if (isDemo(id)) {
        const d = demoDef(id);
        const v = d ? (d[field] || "") : "";
        return `<select class="cmp-mp-sel" disabled><option>${esc(v || "—")}</option></select>`;
      }
      const cur = pickOf(id);
      const opts = window.YieldModule.options(id, cur, field);
      if (!opts.length) return `<select class="cmp-mp-sel" disabled><option>—</option></select>`;
      // 改了某一维后其余维可能失效，这里把选择回落到仍可用的取值
      let v = String(cur[field]);
      if (opts.indexOf(v) < 0) { v = String(opts[0]); cur[field] = v; }
      return `<select class="cmp-mp-sel" data-cmp-pick="${esc(id)}" data-cmp-field="${field}">
        ${opts.map(o => `<option value="${esc(o)}"${String(o) === v ? " selected" : ""}>${esc(pretty ? pretty(o) : o)}</option>`).join("")}
      </select>`;
    }];

    const partRow = (label, part, fallbackRow) => [label, id => {
      if (isDemo(id)) {
        if (part !== "term") return "\u2014";
        const d = demoDef(id);
        const v = d ? (d.term || "") : "";
        return `<select class="cmp-mp-sel" disabled><option>${esc(v || "\u2014")}</option></select>`;
      }
      const cur = pickOf(id);
      if (!window.YieldModule.hasParts(id)) {
        if (part !== "term") return "\u2014";
        return fallbackRow("保险期间", "term")[1](id);
      }
      const opts = window.YieldModule.partOptions(id, cur, part);
      if (!opts.length) return "\u2014";
      let v = window.YieldModule.partOf(id, cur.term, part);
      if (opts.indexOf(v) < 0) v = opts[0];
      return `<select class="cmp-mp-sel" data-cmp-pick="${esc(id)}" data-cmp-field="${part}">
        ${opts.map(o => `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(o)}</option>`).join("")}
      </select>`;
    }];

    const rows = [];
    // 示例/示例模型点：年金在这里切换说明书示例，自由设定的产品提供「恢复示例」
    if (anyDemo || ids.some(id => !isDemo(id))) {
      rows.push(["示例模型点", id => {
        if (!isDemo(id)) {
          const list = defaultPicksOf(id);
          if (!list.length) return "\u2014";
          const hit = defaultMatch(id);
          return `<div class="cmp-mp-resets">${list.map((d, i) => {
            const label = list.length > 1 ? `恢复示例${i + 1}` : "恢复示例";
            const on = i === hit;
            const tip = `${d.age} 岁${d.sex}、${d.pay}、${d.term}`;
            return `<button type="button" class="cmp-mp-reset${on ? " is-default" : ""}"
              data-cmp-defreset="${esc(id)}" data-cmp-idx="${i}"${on ? " disabled" : ""}
              title="${esc(on ? `当前即为示例模型点：${tip}` : `恢复到示例模型点：${tip}`)}">${label}</button>`;
          }).join("")}</div>`;
        }
        const defs = window.YieldModule.defs(id);
        const cur = pickOf(id).defIdx || 0;
        return `<div class="cmp-mp-resets">${defs.map((d, i) => {
          const on = i === cur;
          const tip = `${d.age} 岁${d.sex}、${d.pay}、${d.term}`;
          return `<button type="button" class="cmp-mp-reset${on ? " is-active" : ""}"
            data-cmp-defidx="${esc(id)}" data-cmp-idx="${i}"${on || defs.length < 2 ? " disabled" : ""}
            title="${esc(tip)}">示例${i + 1}</button>`;
        }).join("")}</div>`;
      }]);
    }
    rows.push(dimRow("性别", "sex"));
    rows.push(dimRow("投保年龄", "age"));
    rows.push(dimRow("交费期间", "pay"));
    // 保险期间与年金起领日期分开两行：年金产品的现价表把两者挤在同一个维度里，
    // 对比时按「参与对比产品的可调项并集」出两行，没有该选项的产品留空。
    rows.push(partRow("保险期间", "term", dimRow));
    rows.push(partRow("年金起领日期", "lead", dimRow));

    return `<div class="cmp-block cmp-mp-block">
      <h4 class="cmp-subtitle">${anyDemo ? "示例模型点信息" : "对比模型点"}</h4>
      <div class="cmp-table-wrap"><table class="cmp-table cmp-mp-table">
        ${colgroup(ids.length)}
        <thead><tr><th class="cmp-label"></th>${head}</tr></thead>
        <tbody>${rows.map(([label, get]) => `<tr>
          <th class="cmp-label">${label}</th>
          ${ids.map(id => `<td>${get(id)}</td>`).join("")}
        </tr>`).join("")}</tbody>
      </table></div>
      ${anyDemo ? '<p class="cmp-mp-note">标为「示例 N」的产品暂无示例模型点以外的收益率分析，只能在其说明书示例之间切换；其余产品可自由设定，或点击「恢复示例」回到说明书示例。</p>' : ""}
    </div>`;
  }

  function money(v) {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    if (isNaN(n)) return String(v);
    return n >= 10000 ? `${(n / 10000).toLocaleString("zh-CN")} 万` : n.toLocaleString("zh-CN");
  }

  let chartCtx = null;
  let cmpResizeTimer = null;

  function chartBlock(ids, series) {
    chartCtx = { ids, series };
    // 图下注脚：缺数据的产品要说明「无曲线」，平滑生成的要说明与真实值的差异
    const notes = ids.map(id => {
      const p = byId(id);
      const label = `${esc(p?.id || "")} ${esc(p?.name || "")}`;
      if (!series[id]) return `<li class="is-off">${label} 无收益率分析曲线</li>`;
      if (isDemo(id)) return `<li>${label} 对应曲线由平滑生成得到，与真实值可能有差异</li>`;
      return "";
    }).filter(Boolean).join("");
    return `<div class="cmp-chart" data-cmpchart></div>
      ${notes ? `<ul class="cmp-chart-notes">${notes}</ul>` : ""}`;
  }

  function chartSvg(ids, series, width) {
    const drawn = ids.filter(id => series[id]);
    if (!drawn.length) return "";
    const curve = id => ({
      smooth: isDemo(id),
      pts: series[id].rows.filter(r => r.irr !== null && r.irr >= -15).map(r => ({ t: r.t, v: r.irr })),
      div: series[id].rows.filter(r => r.divIrr !== null && r.divIrr !== undefined && r.divIrr >= -15).map(r => ({ t: r.t, v: r.divIrr })),
    });
    const cs = drawn.map(curve);
    const allPts = cs.reduce((acc, c) => acc.concat(c.pts), []);
    if (allPts.length < 2) return "";
    const tMin = Math.min.apply(null, allPts.map(p => p.t));
    const tMax = Math.max.apply(null, allPts.map(p => p.t));
    if (tMax <= tMin) return "";

    const allV = allPts.map(p => p.v).concat(
      cs.reduce((acc, c) => acc.concat(c.div.map(p => p.v)), []));
    let max = Math.max.apply(null, allV);
    let min = Math.min(0, Math.min.apply(null, allV));
    const span = (max - min) || 1;
    const pad = span * 0.14;
    max += pad;
    min = min < 0 ? min - pad * 0.5 : -pad * 0.5;

    const W = Math.max(420, Math.round(width)), H = 240, L = 58, R = 18, T = 16, B = 30;
    const px = t => L + ((t - tMin) / (tMax - tMin)) * (W - L - R);
    const py = v => T + (1 - (Math.max(v, min) - min) / (max - min)) * (H - T - B);
    const toXY = arr => arr.map(p => ({ x: px(p.t), y: py(p.v) }));
    const linePath = (arr, smooth) => {
      const xy = toXY(arr);
      if (xy.length < 2) return "";
      return smooth ? window.YieldModule.curvePath(xy)
        : xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    };

    const zero = (min < 0 && max > 0)
      ? `<line x1="${L}" y1="${py(0)}" x2="${W - R}" y2="${py(0)}" stroke="#8a8574" stroke-width="1" stroke-dasharray="5 4"/>`
      : "";
    const yTicks = [max, (max + min) / 2, min].map(v =>
      `<text x="${L - 8}" y="${py(v) + 4}" text-anchor="end" class="yield-axis">${v.toFixed(1)}%</text>`).join("");
    const step = tMax > 60 ? 20 : tMax > 30 ? 10 : tMax > 12 ? 5 : 2;
    let xTicks = "";
    for (let t = Math.max(1, Math.ceil(tMin / step) * step); t <= tMax; t += step) {
      xTicks += `<text x="${px(t)}" y="${H - 8}" text-anchor="middle" class="yield-axis">${t}</text>`;
    }
    const lines = drawn.map((id, i) => {
      const c = cs[i];
      const color = COLORS[i % COLORS.length];
      const solid = linePath(c.pts, c.smooth);
      const dashed = linePath(c.div, c.smooth);
      return `${solid ? `<path d="${solid}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
        ${dashed ? `<path d="${dashed}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="6 4" opacity="0.75"/>` : ""}`;
    }).join("");
    const legend = drawn.map((id, i) => {
      const p = byId(id);
      return `<li><span class="cmp-dot" style="background:${COLORS[i % COLORS.length]}"></span>
        <span class="cmp-leg-id">${esc(p?.id || "")}</span>
        <span class="cmp-leg-name">${esc(p?.name || "")}</span></li>`;
    }).join("");
    const hasDashed = cs.some(c => c.div.length > 1);
    const legendTxt = hasDashed ? "实线为保证口径，虚线为含红利口径。" : "曲线为保证口径（所选产品在该模型点没有可用的含红利数据）。";

    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="各产品退保年化收益率曲线对比">
        ${zero}${lines}${yTicks}${xTicks}
        <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#e5e0d4" stroke-width="1"/>
      </svg>
      <ul class="cmp-legend-list">${legend}</ul>
      <p class="cmp-chart-note">横轴为保单年度，纵轴为该年度末退保的年化收益率；${legendTxt}首年退保年化低于 −15% 的点未绘出，纵轴按各产品共同范围缩放。</p>`;
  }

  const pct = v => (v === null || v === undefined ? "—" : Number(v).toFixed(2) + "%");
  const num = v => (v === null || v === undefined ? "—" : Math.round(v).toLocaleString("zh-CN"));

  // 收益率分析明细：按保单年度罗列各产品 IRR，并标出各自回本年度
  // 年度取所有产品的并集；默认只显示关键节点，节点之间的年份分段展开
  const DETAIL_KEY_YEARS = [5, 10, 20, 30];

  function detailGaps(years) {
    const keys = DETAIL_KEY_YEARS.filter(k => years.indexOf(k) >= 0);
    if (!keys.length) return [];
    const bounds = [0].concat(keys).concat([years[years.length - 1] + 1]);
    const out = [];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const from = bounds[i] + 1;
      const to = bounds[i + 1] - 1;
      const list = years.filter(y => y >= from && y <= to);
      if (list.length) out.push({ from: list[0], to: list[list.length - 1], years: list });
    }
    return out;
  }

  function detailTable(ids, series, anyDiv) {
    const drawn = ids.filter(id => series[id]);
    if (!drawn.length) return "";
    const years = Array.from(new Set(
      drawn.reduce((acc, id) => acc.concat(series[id].rows.map(r => r.t)), [])
    )).sort((a, b) => a - b);
    const head = ids.map(id => {
      const p = byId(id);
      const off = series[id] ? "" : " is-off";
      return `<th class="cmp-product-head${off}"><div class="cmp-pid">${esc(p?.id || "")}</div>
        <div class="cmp-pname">${esc(p?.name || "")}</div>${actButtons(id)}</th>`;
    }).join("");
    const gaps = detailGaps(years);
    const gapOf = {};
    gaps.forEach((g, i) => g.years.forEach(y => { gapOf[y] = i; }));
    // 第一个区间（1–4 年）默认展开
    const openGap = 0;
    let body = "";
    years.forEach(t => {
      const gi = gapOf[t];
      const hide = gi !== undefined && gi !== openGap;
      const cells = ids.map(id => {
        const s = series[id];
        if (!s) return '<td class="cmp-na"></td>';
        const row = s.rows.find(r => r.t === t);
        if (!row) return '<td class="cmp-na"></td>';
        const be = s.breakEven === t;
        const val = anyDiv && row.divIrr !== null && row.divIrr !== undefined
          ? `${pct(row.irr)} <em>/ ${pct(row.divIrr)}</em>`
          : pct(row.irr);
        return `<td class="${be ? "is-breakeven" : ""}">${val}${be ? '<span class="cmp-be-flag">回本</span>' : ""}</td>`;
      }).join("");
      body += `<tr${gi === undefined ? "" : ` data-cmp-gap="${gi}"`}${hide ? " hidden" : ""}><th class="cmp-label">第 ${t} 保单年度</th>${cells}</tr>`;
    });
    const tools = gaps.length
      ? `<div class="yield-table-tools">
          <span class="yield-table-hint">默认显示第 ${DETAIL_KEY_YEARS.filter(k => years.indexOf(k) >= 0).join("/")} 保单年度，点右侧分段展开</span>
          <div class="gap-chips" role="group" aria-label="按区间展开">
            ${gaps.map((g, i) => {
              const on = i === openGap;
              return `<button class="gap-chip${on ? " is-active" : ""}" type="button" data-cmp-gap-btn="${i}" aria-pressed="${on ? "true" : "false"}">
              <span class="gap-chip-mark">${on ? "−" : "+"}</span>${g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`} 年</button>`;
            }).join("")}
          </div>
        </div>`
      : "";
    return `${tools}<div class="cmp-detail-wrap"><table class="cmp-table cmp-detail-table">
      ${colgroup(ids.length)}
      <thead><tr><th class="cmp-label">保单年度</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  // 红利方式：年金随示例变化（交清增额 / 累积生息），非年金是产品层面的固定属性，
  // 即使当前模型点没有红利演示也照常显示。
  // 说明书演示里没写红利方式时，用数据形态反推：
  // 含红利后「累计领取」变大 → 交清增额（保额/年金随红利增长）；
  // 只有「现金价值」变大 → 累积生息；两列完全一致 → 这次演示根本没走红利。
  function inferDivMethod(d) {
    const v = d && d.div;
    if (!v || !v.annD || !v.cvD || !v.annG || !v.cvG) return null;
    const annDiff = v.years.some((y, i) => Math.abs(v.annD[i] - v.annG[i]) > 0.5);
    const cvDiff = v.years.some((y, i) => Math.abs(v.cvD[i] - v.cvG[i]) > 0.5);
    if (!annDiff && !cvDiff) return null;
    return annDiff ? "交清增额" : "累积生息";
  }

  function divMethodOf(id) {
    const rec = window.YieldModule.record(id);
    if (!rec) return null;
    if (rec.demoOnly) {
      const s = seriesFor(id);
      return s && s.div ? (s.div.method || "未明确") : null;
    }
    const defs = window.YieldModule.defs(id);
    const p = pickOf(id);
    const idx = p ? window.YieldModule.matchDef(id, p) : -1;
    const hit = (idx >= 0 && defs[idx] && defs[idx].div) ? defs[idx]
      : defs.find(d => d.div && (d.div.method || inferDivMethod(d)));
    if (!hit || !hit.div) return null;
    return hit.div.method || inferDivMethod(hit) || null;
  }

  function beLabel(s) {
    if (!s) return "未回本";
    return window.YieldModule.beText(s.rows, s.breakEven);
  }

  // 含红利口径的回本年限（含红利现价只在部分年度披露，区间按披露年度算）
  function beLabelD(s) {
    if (!s || !s.div) return "\u2014";
    return window.YieldModule.beTextDiv(s.rows, s.breakEvenD);
  }

  function yieldBody(inter) {
    const ids = withYield();
    if (!ids.length) return "";
    const series = {};
    ids.forEach(id => { series[id] = seriesFor(id); });
    const anyDiv = ids.some(id => series[id] && series[id].div);
    const drawn = ids.filter(id => series[id]);

    if (!drawn.length) {
      const mp = state.mode === "diff" ? mpTableHtml(ids) : (modelPointBar(inter) || "");
      return `${mp}<p class="cmp-na">当前模型点下没有可用的收益率数据。</p>`;
    }

    const cellAtYear = (id, t) => {
      const s = series[id];
      if (!s) return "\u2014";
      const row = s.rows.find(r => r.t === t);
      if (!row) return "\u2014";
      return anyDiv && row.divIrr !== null && row.divIrr !== undefined
        ? `${pct(row.irr)} <em>/ ${pct(row.divIrr)}</em>`
        : pct(row.irr);
    };

    const rows = [5, 10, 20]
      .filter(t => ids.some(id => series[id] && series[id].rows.some(r => r.t === t)))
      .map(t => [`至第 ${t} 保单年度年化`, id => cellAtYear(id, t)]);
    rows.push(["满期年化", id => {
      const s = series[id];
      if (!s) return "\u2014";
      const isWhole = !isDemo(id) && (window.YieldModule.dims(id).term || []).some(t => t.indexOf("终身") >= 0);
      if (isWhole) return "\u2014（终身无满期）";
      return anyDiv && s.end.divIrr !== null && s.end.divIrr !== undefined
        ? `${pct(s.end.irr)} <em>/ ${pct(s.end.divIrr)}</em>`
        : pct(s.end.irr);
    }]);
    rows.push(["回本年限", id => {
      const s = series[id];
      if (!s) return "\u2014";
      const g = beLabel(s);
      if (!anyDiv || !s.div) return g;
      return `${g} <em>/ ${beLabelD(s)}</em>`;
    }]);
    if (ids.some(id => window.YieldModule.record(id)?.sourceUnit)) {
      rows.push(["现价表口径", id => {
        const rec = window.YieldModule.record(id);
        if (!rec) return "\u2014";
        if (!rec.sourceUnit) return "千元年交保费";
        return `${rec.sourceUnit === "per1000sa" ? "每千元保额" : rec.sourceUnit === "per10000sa" ? "每万元保额" : "每份"}，已按费率表折算`;
      }]);
    }

    const head = state.ids.map(id => {
      const p = byId(id);
      const s = series[id];
      const hasY = window.YieldModule.has(id);
      const note = s ? "" : (hasY ? '<div class="cmp-off">该模型点无数据</div>' : '<div class="cmp-off">暂不进行收益率分析</div>');
      return `<th class="cmp-product-head${s ? "" : " is-off"}">
        <div class="cmp-pid">${esc(p?.id || "")}</div>
        <div class="cmp-pname">${esc(p?.name || "")}</div>
        ${note}${actButtons(id)}
      </th>`;
    }).join("");

    const mpBlock = state.mode === "same" ? (modelPointBar(inter) || "") : mpTableHtml(ids);
    // 只要有一个产品算得出曲线就画；算不出的在产品注脚里单独说明
    const showChart = drawn.length > 0;
    const chartOpen = !!state.chartOpen;
    const chart = showChart
      ? `<div class="yield-chart-actions">
          <button class="ghost-btn" type="button" data-cmp-chart-toggle aria-expanded="${chartOpen ? "true" : "false"}">${chartOpen ? "收起曲线" : "查看曲线"}</button>
        </div>
        <div data-cmp-chart-wrap${chartOpen ? "" : " hidden"}>${chartBlock(state.ids, series)}</div>`
      : "";
    const divNote = anyDiv
      ? '<p class="cmp-legend cmp-divnote">斜杠后为含红利口径。</p>'
      : "";
    const note = state.mode === "diff"
      ? '<p class="cmp-footnote">不同模型点模式下各列条件不同，仅供横向观察，不等同于同一条件下的收益比较。</p>'
      : "";

    return `<div class="cmp-yield-body">
      ${mpBlock}
      <div class="cmp-table-wrap"><table class="cmp-table">
        ${colgroup(state.ids.length)}
        <thead><tr><th class="cmp-label"></th>${head}</tr></thead>
        <tbody>${rows.map(([label, get]) => `<tr>
          <th class="cmp-label">${label}</th>
          ${state.ids.map(id => {
            const p = byId(id);
            if (!p) return "<td>\u2014</td>";
            if (!window.YieldModule.has(id)) return '<td class="cmp-na">\u2014</td>';
            return `<td>${get(id)}</td>`;
          }).join("")}
        </tr>`).join("")}</tbody>
      </table></div>
      ${detailTable(state.ids, series, anyDiv)}
      ${chart}
      ${divNote}
      ${note}
      </div>`;
  }

  function paintCompareCharts() {
    const host = document.querySelector("[data-cmpchart]");
    if (!host || !chartCtx) return;
    if (host.closest("[hidden]")) return;   // 曲线默认收起，隐藏时量不到宽度
    const cs = getComputedStyle(host);
    const inner = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const w = inner > 320 ? inner : (host.clientWidth || 760);
    host.innerHTML = chartSvg(chartCtx.ids, chartCtx.series, w);
  }

  window.addEventListener("resize", () => {
    clearTimeout(cmpResizeTimer);
    cmpResizeTimer = setTimeout(paintCompareCharts, 160);
  });

  // 对比里没有收益率数据的产品，逐条列出不测算的原因
  function naNote() {
    if (!window.YieldModule) return "";
    const list = state.ids
      .map(id => byId(id))
      .filter(p => p && !window.YieldModule.has(p.id));
    if (!list.length) return "";
    const items = list.map(p =>
      `<li><strong>${esc(p.name)}</strong><span>${esc(window.YieldModule.reason(p))}</span></li>`).join("");
    return `<div class="cmp-na-reason"><strong>以下产品暂不进行收益率分析</strong><ul>${items}</ul></div>`;
  }

  function render() {
    const { body, empty } = el();
    if (!body || !empty) return;
    // 收益率数据是按产品懒加载的：先让缺数据的先加载，完成后自动重渲染一次
    const YM = window.YieldModule;
    if (YM && YM.ensure) {
      const missing = state.ids.filter(id => YM.has(id) && !YM.isLoaded(id));
      if (missing.length) {
        Promise.all(missing.map(id => YM.ensure(id).catch(() => {}))).then(() => render());
      }
    }
    updateBadge();
    if (!state.ids.length) {
      body.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const capable = ensureMode();
    const sameOk = canSame();
    const inter = state.mode === "same" ? ensureSel() : intersectTuples();
    const anyYield = withYield().length > 0;
    let inner = "";
    if (anyYield) {
      inner = yieldBody(inter) || '<p class="cmp-na">所选产品没有可用的收益率数据。</p>';
    }
    const yieldBlock = `<div class="cmp-block">${yieldHead(sameOk)}${naNote()}${inner}</div>`;
    const stoppedNotes = state.ids
      .map(id => byId(id))
      .filter(p => p && String(p.status || "").indexOf("停售") >= 0)
      .map(p => `<p>${esc(p.name)}已停售，分析结果可能不准确。</p>`)
      .join("");
    const stoppedBlock = stoppedNotes
      ? `<div class="cmp-stopped-note"><strong>停售提示</strong>${stoppedNotes}</div>`
      : "";
    body.innerHTML = `${basicTable()}${respTable()}${yieldBlock}${stoppedBlock}`;
    paintCompareCharts();
  }

  function bind() {
    const root = document.getElementById("compareView");
    if (!root) return;
    root.addEventListener("change", event => {
      const pick = event.target.closest("[data-cmp-pick]");
      if (pick) {
        const id = pick.dataset.cmpPick;
        const field = pick.dataset.cmpField;
        const p = pickOf(id);
        if (!p) return;
        if (field === "defIdx") p.defIdx = parseInt(pick.value, 10) || 0;
        else if (field === "term" || field === "lead") window.YieldModule.pickPart(id, p, field, pick.value);
        else p[field] = pick.value;
        render();
        return;
      }
      const sel = event.target.closest("[data-cmp-mp]");
      if (!sel || !state.tuple) return;
      const dim = sel.dataset.cmpMp;
      const val = sel.value;
      const inter = intersectTuples();
      // 在满足新取值的四元组里，优先保留其余维度跟当前选择一致的，避免"改一个跳一个"
      const curInfo = tupleInfo(state.tuple);
      let picked = null;
      let bestScore = -1;
      for (const tid of inter.keys()) {
        const i = tupleInfo(tid);
        const v = dim === "end" ? (i.end === "WL" ? "WL" : String(i.end))
          : dim === "sex" ? i.sex : String(i[dim]);
        if (v !== String(val)) continue;
        let score = 0;
        if (i.sex === curInfo.sex) score += 1;
        if (String(i.age) === String(curInfo.age)) score += 1;
        if (String(i.pay) === String(curInfo.pay)) score += 1;
        if (String(i.end) === String(curInfo.end)) score += 1;
        if (score > bestScore) { bestScore = score; picked = tid; }
      }
      if (picked) {
        state.tuple = picked;
        render();
      }
    });
    root.addEventListener("click", event => {
      const rm = event.target.closest("[data-cmp-remove]");
      if (rm) { remove(rm.dataset.cmpRemove); return; }
      const jump = event.target.closest("[data-cmp-jump]");
      if (jump && window.AppAPI) { window.AppAPI.focusProduct(jump.dataset.cmpJump); return; }
      const pinBtn = event.target.closest("[data-cmp-pin]");
      if (pinBtn) {
        const id = pinBtn.dataset.cmpPin;
        if (window.AppAPI && window.AppAPI.togglePin) window.AppAPI.togglePin(id);
        render();
        return;
      }
      const modeBtn = event.target.closest("[data-cmp-mode]");
      if (modeBtn) {
        const want = modeBtn.dataset.cmpMode;
        const capable = sameCapable();
        if (want === "same") {
          if (!capable) {
            const tid = alignedNow();
            if (!tid) {
              if (window.AppAPI && window.AppAPI.toast) window.AppAPI.toast("无公共模型点可用");
              return;
            }
            state.mode = "same";
            state.tuple = tid;
            render();
            return;
          }
          state.mode = "same";
          state.tuple = null;
          ensureSel();
          render();
          return;
        }
        state.mode = "diff";
        seedPicksFromTuple();
        render();
        return;
      }
      const chartBtn = event.target.closest("[data-cmp-chart-toggle]");
      if (chartBtn) {
        state.chartOpen = !state.chartOpen;
        const wrap = document.querySelector("[data-cmp-chart-wrap]");
        if (wrap) wrap.hidden = !state.chartOpen;
        chartBtn.textContent = state.chartOpen ? "收起曲线" : "查看曲线";
        chartBtn.setAttribute("aria-expanded", state.chartOpen ? "true" : "false");
        if (state.chartOpen) paintCompareCharts();
        return;
      }
      const gapBtn = event.target.closest("[data-cmp-gap-btn]");
      if (gapBtn) {
        const on = gapBtn.getAttribute("aria-pressed") !== "true";
        const gi = gapBtn.dataset.cmpGapBtn;
        document.querySelectorAll(`.cmp-detail-table tbody tr[data-cmp-gap="${gi}"]`)
          .forEach(tr => { tr.hidden = !on; });
        gapBtn.setAttribute("aria-pressed", on ? "true" : "false");
        gapBtn.classList.toggle("is-active", on);
        const mark = gapBtn.querySelector(".gap-chip-mark");
        if (mark) mark.textContent = on ? "−" : "+";
        return;
      }
      const defPick = event.target.closest("[data-cmp-defidx]");
      if (defPick) {
        const id = defPick.dataset.cmpDefidx;
        const i = parseInt(defPick.dataset.cmpIdx, 10) || 0;
        const p = pickOf(id);
        if (p) { p.defIdx = i; render(); }
        return;
      }
      const defReset = event.target.closest("[data-cmp-defreset]");
      if (defReset) {
        const id = defReset.dataset.cmpDefreset;
        const i = parseInt(defReset.dataset.cmpIdx, 10) || 0;
        const d = defaultPicksOf(id)[i];
        if (d) {
          state.picks[id] = d;
          render();
        }
        return;
      }
      const reset = event.target.closest("[data-cmp-reset]");
      if (reset) {
        const id = reset.dataset.cmpReset;
        const idx = parseInt(reset.dataset.cmpIdx, 10);
        const tid = defTuple(id, idx);
        const inter = intersectTuples();
        if (tid && inter.has(tid)) {
          state.tuple = tid;
          render();
        } else if (window.AppAPI && window.AppAPI.toast) {
          window.AppAPI.toast("该示例模型点不在所有产品的公共取值内");
        }
      }
    });
    restoreIds();
  }

  window.CompareModule = { toggle, remove, clear, has, count, render, bind, MAX };
})();
