/* 可比产品边栏
 * 从"当前产品的当前模型点"出发，找出所有在现价全表里能取到同一模型点的产品。
 * 模型点匹配按语义归一到（性别 / 投保年龄 / 缴费年数 / 保险期间终点年龄），
 * 因为不同产品的标签写法并不统一（10年 vs 10年交、保至80周岁 vs 80岁）。
 */
(function () {
  const DIM = { 交费期间: "pay", 交费年期: "pay", 缴费期间: "pay", 保险期间: "term", 保障期间: "term", 性别: "sex", 投保年龄: "age" };
  const FILTERS = [
    ["attr", "同属性"],
    ["cat", "同分类"],
    ["status", "同状态"],
    ["payPeriod", "同缴费期间"],
    ["bucket", "同期间长度"],
    ["payMethod", "同缴费方式"],
  ];

  let cur = null; // { id, sel }
  const on = { attr: false, cat: false, status: false, payPeriod: false, bucket: false, payMethod: false };

  const $ = id => document.getElementById(id);

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

  function keyInfo(rec, key) {
    const parts = key.split("|");
    const o = {};
    rec.cols.forEach((c, i) => { if (DIM[c]) o[DIM[c]] = parts[i]; });
    const age = parseInt(o.age, 10);
    const hasPayDim = rec.cols.some(c => DIM[c] === "pay");
    // 现价表没有"交费期间"列的产品只可能是趸交，按 1 年处理，才能与其他产品的趸交对上
    const pay = hasPayDim ? window.YieldModule.payYears(rec, o) : 1;
    return {
      sex: o.sex,
      age: isNaN(age) ? null : age,
      pay,
      end: endAgeOf(o.term, isNaN(age) ? 0 : age),
    };
  }

  function targetInfo() {
    const rec = window.YieldModule.record(cur.id);
    const key = window.YieldModule.keyOf(cur.id, cur.sel);
    if (!rec || !key) return null;
    return keyInfo(rec, key);
  }

  // 懒加载后不再有全量曲线，改用索引里的「模型点区间」：
  //   "男|10年|至80周岁|18-60"  →  性别 / 交费期间 / 保险期间 / 年龄区间
  function payFromLabel(label, age) {
    if (!label) return 1;                       // 没有交费列 = 趸交
    if (/趸交|一次性/.test(label)) return 1;
    let m = label.match(/交至\s*(\d{1,3})\s*周岁/);
    if (m && age != null) return Math.max(Number(m[1]) - age, 1);
    m = label.match(/(\d{1,2})\s*年/);
    return m ? Number(m[1]) : 1;
  }

  function inRange(spec, age) {
    if (!spec) return false;
    const parts = String(spec).split(",");
    for (const seg of parts) {
      const m = seg.split("-");
      if (m.length === 2) {
        if (age >= Number(m[0]) && age <= Number(m[1])) return true;
      } else if (Number(seg) === age) return true;
    }
    return false;
  }

  function pointHit(entry, t) {
    const bits = String(entry).split("|");
    if (bits.length < 4) return false;
    const sex = bits[0], payLabel = bits[1], term = bits[2], ages = bits[3];
    if (sex !== t.sex) return false;
    if (endAgeOf(term, t.age) !== t.end) return false;
    if (payFromLabel(payLabel, t.age) !== t.pay) return false;
    return inRange(ages, t.age);
  }

  function labelOf(info) {
    if (!info) return "";
    const payTxt = info.pay == null ? "—" : (info.pay === 1 ? "趸交" : `${info.pay} 年交`);
    const endTxt = info.end === "WL" ? "保终身" : `保至 ${info.end} 岁`;
    return `${info.age} 岁${info.sex || ""} ｜ ${payTxt} ｜ ${endTxt}`;
  }

  function payYearsSet(text) {
    const out = new Set();
    const t = String(text || "").replace(/\s/g, "");
    if (/趸交|一次性/.test(t)) out.add(1);
    t.replace(/(\d{1,2})年/g, (m, d) => { out.add(Number(d)); return m; });
    return out;
  }

  // "同"按集合相等判断：缴费年数集合、期间档位、缴费方式都必须完全一致
  function sameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) { if (!b.has(x)) return false; }
    return true;
  }

  function sameArr(a, b) {
    return sameSet(new Set(a || []), new Set(b || []));
  }

  function selfProduct() {
    return (window.PRODUCTS || []).find(p => p.id === cur.id) || null;
  }

  function candidates() {
    const t = targetInfo();
    const self = selfProduct();
    if (!t || !self) return [];
    const YM = window.YieldModule;
    const out = [];
    (window.PRODUCTS || []).forEach(p => {
      if (p.id === cur.id) return;
      if (!YM.has(p.id)) return;
      const hit = (YM.points ? YM.points(p.id) : []).some(entry => pointHit(entry, t));
      if (!hit) return;
      if (on.attr && p.mainCategory !== self.mainCategory) return;
      if (on.cat && p.subcategory !== self.subcategory) return;
      if (on.status && p.status !== self.status) return;
      if (on.payPeriod && !sameSet(payYearsSet(p.basicInfo?.paymentPeriod), payYearsSet(self.basicInfo?.paymentPeriod))) return;
      if (on.bucket && !sameArr(p.basicInfo?.periodBuckets, self.basicInfo?.periodBuckets)) return;
      if (on.payMethod && !sameArr(p.basicInfo?.paymentDetails, self.basicInfo?.paymentDetails)) return;
      out.push(p);
    });
    // 排序：与当前产品披露日期越接近越靠前，同距离时按编号
    const base = dateOf(self);
    out.sort((a, b) => {
      const da = dateOf(a);
      const db = dateOf(b);
      if (base !== null && da !== null && db !== null) {
        const gap = Math.abs(da - base) - Math.abs(db - base);
        if (gap !== 0) return gap;
      } else if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return db - da;
      }
      return a.id.localeCompare(b.id);
    });
    return out;
  }

  function dateOf(product) {
    const t = Date.parse(product && product.disclosureDate ? product.disclosureDate : "");
    return isNaN(t) ? null : t;
  }

  function filtersHtml() {
    return FILTERS.map(([k, label]) =>
      `<button type="button" class="sim-filter${on[k] ? " is-on" : ""}" data-sim-filter="${k}" aria-pressed="${on[k]}">${label}</button>`
    ).join("");
  }

  function render() {
    if (!cur) return;
    const panel = $("similarPanel");
    if (!panel || panel.hidden) return;
    const t = targetInfo();
    const title = document.getElementById("similarTitle");
    const self = selfProduct();
    if (title) title.textContent = self ? `可比产品（${self.name}）` : "可比产品";
    $("similarMp").textContent = labelOf(t);
    $("similarFilters").innerHTML = filtersHtml();
    const list = candidates();
    const head = `<p class="sim-count">共 <strong>${list.length}</strong> 个产品可在同一模型点测算</p>`;
    if (!list.length) {
      $("similarBody").innerHTML = `${head}<p class="sim-empty">没有找到可在该模型点测算的其他产品。可以试着放宽筛选，或换一个缴费期间／投保年龄。</p>`;
      return;
    }
    const items = list.map(p => {
      const added = window.CompareModule && window.CompareModule.has(p.id);
      return `<li class="sim-item">
        <div class="sim-item-main">
          <span class="sim-id">${esc(p.id)}</span>
          <span class="sim-name">${esc(p.name)}</span>
          <span class="sim-tags">${esc(p.mainCategory)} · ${esc(p.subcategory)} · ${esc(p.status)}</span>
        </div>
        <button type="button" class="act-btn${added ? " is-on" : ""}" data-sim-add="${esc(p.id)}">${added ? "从对比中删除" : "加入产品对比"}</button>
      </li>`;
    }).join("");
    $("similarBody").innerHTML = `${head}<ul class="sim-list">${items}</ul>
      <p class="sim-note">按与本产品披露日期最接近排序，不按编号排列。</p>`;
  }

  function open(id, sel) {
    cur = { id, sel: Object.assign({}, sel) };
    const panel = $("similarPanel");
    const backdrop = $("similarBackdrop");
    if (!panel) return;
    panel.hidden = false;
    if (backdrop) backdrop.hidden = false;
    document.body.classList.add("has-similar");
    render();
  }

  function close() {
    const panel = $("similarPanel");
    const backdrop = $("similarBackdrop");
    if (panel) panel.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("has-similar");
    cur = null;
  }

  // 模型点变化时同步（若边栏正开着且是同一个产品）
  function sync(id, sel) {
    if (!cur || cur.id !== id) return;
    cur.sel = Object.assign({}, sel);
    render();
  }

  function bind() {
    const panel = $("similarPanel");
    if (!panel) return;
    panel.addEventListener("click", event => {
      const f = event.target.closest("[data-sim-filter]");
      if (f) {
        on[f.dataset.simFilter] = !on[f.dataset.simFilter];
        render();
        return;
      }
      const add = event.target.closest("[data-sim-add]");
      if (add) {
        if (!window.CompareModule) return;
        const targetId = add.dataset.simAdd;
        const cmp = window.CompareModule;
        const toast = msg => { if (window.AppAPI && window.AppAPI.toast) window.AppAPI.toast(msg); };
        // 已在对比里：点一次就移除
        if (cmp.has(targetId)) { cmp.toggle(targetId); render(); return; }
        const originId = cur ? cur.id : null;
        const self = selfProduct();
        const originName = (self && self.name) || originId || "";
        const targetProduct = (window.PRODUCTS || []).find(p => p.id === targetId);
        const needOrigin = originId && !cmp.has(originId);
        const need = (needOrigin ? 1 : 0) + 1;
        if (cmp.count() + need > cmp.MAX) {
          // 原产品没能一起进去时，提示里点名原产品
          toast(`超出产品对比数量上限，${needOrigin ? originName : (targetProduct ? targetProduct.name : targetId)}未能成功加入`);
          return;
        }
        if (needOrigin) cmp.toggle(originId);
        cmp.toggle(targetId);
        render();
      }
    });
    const closeBtn = $("similarClose");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = $("similarBackdrop");
    if (backdrop) backdrop.addEventListener("click", close);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && cur) close();
    });
  }

  window.SimilarModule = { open, close, sync, bind };
})();
