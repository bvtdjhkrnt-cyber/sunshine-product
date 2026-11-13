/* 收益率分析模块
 * 数据来源：官方现价全表（元/千元年交保险费口径）
 * 保证口径：保费期初支付、目标年度末退保取回现金价值，不含红利、不含身故给付。
 * 含红利口径：仅使用说明书利益演示披露的含红利现价，且只在说明书示例模型点上成立。
 */
(function () {
  const DIM_MAP = { 交费期间: "pay", 交费年期: "pay", 缴费期间: "pay", 保险期间: "term", 保障期间: "term", 性别: "sex", 投保年龄: "age" };
  const state = {};

  // ── 按产品懒加载 ───────────────────────────────────────────────────────
  // 全量收益率数据 170MB，首屏只加载 data/index.js（约 346KB，含 has 标记与模型点区间），
  // 点开某个产品 / 把它加入对比时，才注入 data/p/{id}.js。
  const IDX = window.YDATA_INDEX || { has: {}, pts: {} };
  const DATA_DIR = "源文件/data/p/";
  const pending = {};

  function loaded(id) {
    return !!((window.YIELDS || {})[id] || (window.ANNUITY || {})[id]);
  }

  function hasYield(id) {
    return loaded(id) || !!(IDX.has && IDX.has[id]);
  }

  function ensure(id) {
    if (loaded(id)) return Promise.resolve();
    if (!hasYield(id)) return Promise.resolve();
    if (pending[id]) return pending[id];
    // 用 <script> 注入而不是 fetch：这样 file:// 双击打开也能用
    pending[id] = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = DATA_DIR + encodeURIComponent(id) + ".js";
      el.onload = () => { delete pending[id]; resolve(); };
      el.onerror = () => { delete pending[id]; reject(new Error("数据加载失败")); };
      document.head.appendChild(el);
    });
    return pending[id];
  }

  function rec(id) {
    return annuityRec(id) || (window.YIELDS || {})[id];
  }

  // 年金：把 build_annuity_data.py 生成的「模型点 → 现价曲线 + 给付参数」
  // 适配成与非年金一致的记录结构，界面与曲线渲染完全复用。
  // 「年满 60 周岁起领」「第 5 个保单周年日起领」这类是领取日，其余是保险期间
  const LEAD_RE = /起领|首个保单周年日|第.{1,3}个保单周年日|年满\s*\d{2,3}\s*周岁/;

  function splitTermLabel(t) {
    const out = { term: "", lead: "" };
    String(t || "").split("·").filter(Boolean).forEach(x => {
      if (LEAD_RE.test(x)) out.lead = x; else out.term = x;
    });
    return out;
  }

  function partOf(r, composite, part) {
    if (!r.termParts) return composite;
    const o = r.termParts.map[composite];
    return o ? (o[part] || "") : "";
  }

  function joinParts(r, obj) {
    const order = (r.termParts && r.termParts.order) || ["term", "lead"];
    return order.map(k => obj[k] || "").filter(Boolean).join("·");
  }

  // 某一部分的可选值（另一个部分保持当前选择，其余维度也一样）
  function partOptions(r, sel, part) {
    if (!r.termParts) return [];
    const other = part === "term" ? "lead" : "term";
    const cur = r.termParts.map[sel.term] || {};
    const out = [];
    Object.keys(r.curves).forEach(k => {
      const p = k.split("|");
      let ok = true;
      r.cols.forEach((col, i) => {
        const f = DIM_MAP[col];
        if (!ok || !f || f === "term") return;
        if (sel[f] !== undefined && sel[f] !== "" && p[i] !== sel[f]) ok = false;
      });
      if (!ok) return;
      const o = r.termParts.map[p[1]] || {};
      if (cur[other] && o[other] !== cur[other]) return;
      if (o[part] && out.indexOf(o[part]) < 0) out.push(o[part]);
    });
    return sortVals(out);
  }

  // 选某一个部分后，另一个部分尽量保持不动；该组合不存在时退到第一个可用组合
  function pickPart(r, sel, part, value) {
    if (!r.termParts) { sel.term = value; return; }
    const cur = r.termParts.map[sel.term] || {};
    const other = part === "term" ? "lead" : "term";
    const cands = [];
    Object.keys(r.curves).forEach(k => {
      const p = k.split("|");
      let ok = true;
      r.cols.forEach((col, i) => {
        const f = DIM_MAP[col];
        if (!ok || !f || f === "term") return;
        if (sel[f] !== undefined && sel[f] !== "" && p[i] !== sel[f]) ok = false;
      });
      if (!ok) return;
      const o = r.termParts.map[p[1]] || {};
      if (o[part] === value) cands.push(p[1]);
    });
    if (!cands.length) return;
    const keep = cands.find(c => (r.termParts.map[c] || {})[other] === cur[other]);
    sel.term = keep || cands[0];
  }

  const annCache = {};
  function annuityRec(id) {
    if (annCache[id] !== undefined) return annCache[id];
    const src = (window.ANNUITY || {})[id];
    if (!src || !src.points || !src.points.length) {
      // 不要缓存 null：数据是按产品懒加载的，首次调用时可能还没注入，
      // 缓存了以后即使加载完也永远读不到
      return null;
    }
    const curves = {};
    const ben = {};
    const defs = [];
    const seen = {};
    // 示例点仍来自说明书：把说明书的 defs 接回来，保证「示例点可看含红利」不丢
    const base = (window.YIELDS || {})[id];
    // 说明书只写「至105周岁」这类保险期间，现价表的维度却是「保证25年·年满60周岁起领」这种组合，
    // 默认选点必须换成匹配到的那条曲线的维度，否则会落到一个不存在的模型点上。
    const dterms = src.dterms || [];
    const baseDefs = ((base && base.defs) ? base.defs : []).map((d, i) => {
      if (!d.div) return d;
      // 示例点原本走 demoSeries（cvG/annG 命名），这里补齐成曲线版所需的 cv/ann
      const div = Object.assign({}, d.div);
      // 含红利列必须用「含红利现价 + 含红利累计领取」，不能拿保证列顶替
      if (div.cv === undefined) div.cv = div.cvD || div.cvG;
      if (div.ann === undefined) div.ann = div.annD || div.annG;
      const term = (dterms[i] || "").trim();
      return Object.assign({}, d, { div }, term ? { term } : {});
    });
    const fallbackTerm = baseDefs.length ? baseDefs[0].term : "—";
    src.points.forEach(p => {
      // [性别, 交费期间, 投保年龄, 额外维度, 现价曲线, 给付段数组, 一次性给付倍数]
      // 给付段：[起始保单年度, 终止保单年度, 年给付额, 递增年数]，递增年数>0 表示
      // 该段第 k 年给付「年给付额 × min(k, 递增年数) / 递增年数」（按已交保费逐年递增）
      const [sex, pay, age, extra, cv, segs, sp] = p;
      const term = extra || fallbackTerm;
      const key = `${pay}|${term}|${sex}|${age}`;
      curves[key] = cv;
      ben[key] = { segs: segs || [], sp: sp || 0, start: segs && segs.length ? segs[0][0] : 0 };
      const dk = `${sex}|${age}|${pay}|${term}`;
      if (!seen[dk]) {
        seen[dk] = 1;
        defs.push({ sex, age: String(age), pay, term });
      }
    });
    const dims = { sex: [], age: [], pay: [], term: [] };
    Object.keys(curves).forEach(key => {
      const [pay, term, sex, age] = key.split("|");
      if (dims.pay.indexOf(pay) < 0) dims.pay.push(pay);
      if (dims.term.indexOf(term) < 0) dims.term.push(term);
      if (dims.sex.indexOf(sex) < 0) dims.sex.push(sex);
      if (dims.age.indexOf(age) < 0) dims.age.push(age);
    });
    ["sex", "pay", "term"].forEach(k => dims[k].sort((a, b) => a.localeCompare(b, "zh")));
    dims.age.sort((a, b) => Number(a) - Number(b));
    // 现价表把「保险期间」和「年金起领日期」塞在同一个维度里（用 · 连接），
    // 界面上要拆成两行各自可选，这里把它们分出来。
    const tmap = {};
    Object.keys(curves).forEach(k => {
      const t = k.split("|")[1];
      if (!(t in tmap)) tmap[t] = splitTermLabel(t);
    });
    const tvals = { term: [], lead: [] };
    Object.keys(tmap).forEach(t => {
      if (tmap[t].term && tvals.term.indexOf(tmap[t].term) < 0) tvals.term.push(tmap[t].term);
      if (tmap[t].lead && tvals.lead.indexOf(tmap[t].lead) < 0) tvals.lead.push(tmap[t].lead);
    });
    const multi = Object.keys(tmap).find(t => t.indexOf("·") >= 0);
    const order = multi ? multi.split("·").map(x => (LEAD_RE.test(x) ? "lead" : "term")) : ["term", "lead"];
    annCache[id] = {
      termParts: { map: tmap, values: tvals, order },
      cols: ["交费期间", "保险期间", "性别", "投保年龄"],
      fixed: {},
      dims,
      curves,
      ben,
      // 年金记录先只保留保证口径：含红利仅披露在说明书示例点，且有独立的展示面板，
      // 混在曲线版里容易出现「含红利低于保证」的口径错位，等对比页改造时再统一。
      defs: (baseDefs.length ? baseDefs : defs),
      def: (baseDefs[0] || defs[0]),
      demoOnly: false,
      hasDiv: baseDefs.some(d => d.div),
      annuity: true,
      sourceUnit: null,
    };
    return annCache[id];
  }

  function irr(flows) {
    let lo = -0.999, hi = 1.5;
    const npv = r => flows.reduce((acc, cf, i) => acc + cf / Math.pow(1 + r, i), 0);
    let a = npv(lo);
    const b = npv(hi);
    if (a * b > 0) return null;
    for (let i = 0; i < 160; i += 1) {
      const mid = (lo + hi) / 2;
      const v = npv(mid);
      if (Math.abs(v) < 1e-7) return mid;
      if (v * a > 0) { lo = mid; a = v; } else { hi = mid; }
    }
    return (lo + hi) / 2;
  }

  function defsOf(r) {
    return (r.defs && r.defs.length) ? r.defs : [r.def];
  }

  function defaultSel(r, idx) {
    const d = defsOf(r)[idx || 0];
    return { sex: d.sex, age: d.age, pay: d.pay, term: d.term };
  }

  // 当前选择命中的是第几个说明书示例（无则 -1）
  function matchDef(r, sel) {
    const key = keyOf(r, sel);
    const list = defsOf(r);
    for (let i = 0; i < list.length; i += 1) {
      if (keyOf(r, defaultSel(r, i)) === key) return i;
    }
    return -1;
  }

  function selFor(id) {
    const r = rec(id);
    if (!r) return null;
    if (!state[id]) state[id] = { sel: defaultSel(r, 0), open: true, defIdx: 0, chartOpen: false };
    if (state[id].chartOpen === undefined) state[id].chartOpen = false;
    if (state[id].defIdx === undefined) state[id].defIdx = 0;
    return state[id];
  }

  function keyOf(r, sel) {
    return r.cols.map(col => {
      const field = DIM_MAP[col];
      if (field && sel[field] !== undefined && sel[field] !== "") return sel[field];
      return r.fixed[col] !== undefined ? r.fixed[col] : sel[field] || "";
    }).join("|");
  }

  function payYearsOf(r, sel) {
    // 现价表的交费列有时不叫「交费期间」而是「交费年期」，且整表只有一个交费年期
    // （写在 fixed 里、不参与维度选择），这时 sel.pay 是空串，直接取空串会当成趸交，
    // IRR 会虚高十几倍。
    let label = (sel && sel.pay) || "";
    if (!label && r && r.fixed) {
      label = r.fixed["交费年期"] || r.fixed["交费期间"] || r.fixed["缴费期间"] || "";
    }
    if (!label || /趸交|一次性/.test(label)) return 1;
    const age = parseInt(sel && sel.age, 10);
    let m = label.match(/交至\s*(\d{1,3})\s*周岁/);
    if (m && !isNaN(age)) return Math.max(Number(m[1]) - age, 1);
    m = label.match(/(\d{1,2})\s*年/);
    if (m) return Number(m[1]);
    return r.np && r.np[label] != null ? r.np[label] : 1;
  }



  // 现价全表是稀疏的（并非每个交费期间 × 保险期间组合都披露），
  // 选择器必须按真实存在的组合收敛，否则会落到空结果。
  function sortVals(vals) {
    return vals.slice().sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb) && String(na) === a && String(nb) === b) return na - nb;
      return String(a).localeCompare(String(b), "zh");
    });
  }

  function available(r, sel, field) {
    const idx = r.cols.findIndex(col => DIM_MAP[col] === field);
    if (idx < 0) return [];
    const vals = new Set();
    Object.keys(r.curves).forEach(k => {
      const parts = k.split("|");
      let ok = true;
      r.cols.forEach((col, i) => {
        const f = DIM_MAP[col];
        if (!ok || !f || f === field) return;
        if (sel[f] !== undefined && sel[f] !== "" && parts[i] !== sel[f]) ok = false;
      });
      if (ok) vals.add(parts[idx]);
    });
    return [...vals].sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb) && String(na) === a && String(nb) === b) return na - nb;
      return a.localeCompare(b, "zh");
    });
  }

  function normalize(r, sel) {
    ["sex", "age", "pay", "term"].forEach(field => {
      if (!r.dims[field] || !r.dims[field].length) return;
      const avail = available(r, sel, field);
      if (avail.length && avail.indexOf(sel[field]) < 0) sel[field] = avail[0];
    });
    return sel;
  }

  function seriesOf(r, sel) {
    const raw = r.curves[keyOf(r, sel)];
    if (!raw) return null;
    const cv = raw.split(",").map(Number);
    const np = payYearsOf(r, sel);
    const age0 = parseInt(sel.age, 10) || 0;
    const P = 1000;

    const defIdx = matchDef(r, sel);
    const def = defIdx >= 0 ? defsOf(r)[defIdx] : null;
    const div = def && def.div ? def.div : null;
    const divMap = {};
    if (div) div.years.forEach((y, i) => { divMap[y] = div.cv[i]; });
    // 累计领取（年金）：用于把"只看到期末现价"改成"累计领取＋现价"口径
    const annMap = {};
    const annDMap = {};
    if (div && div.annD) div.years.forEach((y, i) => { annDMap[y] = div.annD[i]; });
    let hasAnn = false;
    if (div && div.annG) {
      div.years.forEach((y, i) => {
        const a = div.annG[i] || 0;
        if (a > 0) hasAnn = true;
        annMap[y] = a;
      });
    }

    // 年金：该模型点的起领年与给付规则，来自官方现价全表 + 条款给付规则
    const ben = (r.ben && r.ben[keyOf(r, sel)]) || null;
    // 第 y 保单年度的年金给付额 = 各给付段在该年度的给付之和
    const annAt = y => {
      if (!ben || !ben.segs) return 0;
      let v = 0;
      for (let i = 0; i < ben.segs.length; i += 1) {
        const sg = ben.segs[i];
        if (y < sg[0] || y > sg[1]) continue;
        v += sg[3] ? sg[2] * Math.min(y - sg[0] + 1, sg[3]) / sg[3] : sg[2];
      }
      return v;
    };

    const rows = cv.map((value, i) => {
      const t = i + 1;
      const paid = Math.min(t, np) * P;
      // 现金流时点：t=0 是合同生效日。
      //   保费 → 各保单年度「年初」支付，第 k 年保费记在 t=k-1；
      //   生存金/年金 → 年度「年末」给付，第 y 年记在 t=y；
      //   退保现价 → 目标年度「年末」，也在 t=t。
      // 所以 3 年每年交 1 万 ≠ 趸交 3 万：前者 t=0/1/2 各 -1 万，后者 t=0 一次性 -3 万。
      const flows = new Array(t + 1).fill(0);
      for (let k = 0; k < t; k += 1) flows[k] = k < np ? -P : 0;
      let annPaid = 0;
      if (ben) {
        // 给付段由数据给出终止年，满期金已在现价里体现，不重复加
        const endY = Math.min(t, ben.segs[ben.segs.length - 1][1]);
        for (let y = ben.start; y <= endY; y += 1) {
          const amt = annAt(y);
          if (!amt) continue;
          flows[y] += amt;          // 年末给付
          annPaid += amt;
        }
        if (ben.sp && ben.start <= t) {
          const spAmt = annAt(ben.start) * ben.sp;
          flows[ben.start] += spAmt;
          annPaid += spAmt;   // 累计领取口径要把一次性给付算进去
        }
      }
      flows[t] += value;          // 年末退保价值（与当年给付同时点）
      const rate = irr(flows);

      let divRate = null;
      let divCv = null;
      if (div && divMap[t] !== undefined) {
        // 说明书披露的含红利现价是「元」，这里统一换算成每千元保费口径再展示；
        // IRR 用原始金额计算，与展示口径无关。
        const rawDiv = divMap[t];
        const dFlows = new Array(t + 1).fill(0);
        for (let k = 0; k < t; k += 1) dFlows[k] = k < np ? -div.prem : 0;
        // 年金的含红利口径同样要把「含红利累计领取」按年摊进现金流，
        // 否则这一列算的其实是退保口径，会低于含年金领取的保证列。
        if (r.annuity && div.annD) {
          let prevY = 0, prevA = 0;
          for (const y of div.years) {
            if (y > t) break;
            const a = annDMap[y] || 0;
            const n = y - prevY;
            if (n > 0) {
              const each = (a - prevA) / n;
              for (let yy = prevY + 1; yy <= y; yy += 1) dFlows[yy] += each;   // 年末
            }
            prevY = y; prevA = a;
          }
        }
        dFlows[t] += rawDiv;
        const dr = irr(dFlows);
        divRate = dr === null ? null : dr * 100;
        divCv = div.prem ? rawDiv * 1000 / div.prem : rawDiv;
      }

      const ann = ben ? annPaid : (hasAnn ? (annMap[t] || 0) * (div.prem ? 1000 / div.prem : 1) : 0);
      return {
        t, age: age0 + t, cv: value, paid, divCv, ann,
        total: value + ann,
        totalD: (divCv === null ? value : divCv) + ann,
        irr: rate === null ? null : rate * 100,
        divIrr: divRate,
      };
    });

    let breakEven = null, breakEvenCv = null, breakEvenAnn = null;
    // 年金领取来自 ANNUITY 的给付段时，`ben` 有值但 `div` 可能为空（非分红产品），
    // 这时也要用「累计领取＋现价」判回本，否则会出现「明明有年金却显示回本 —」
    const annIncome = hasAnn || !!ben;
    for (const row of rows) {
      if (breakEvenCv === null && row.cv >= row.paid) breakEvenCv = row.t;
      if (annIncome && breakEvenAnn === null && row.total >= row.paid) breakEvenAnn = row.t;
    }
    breakEven = annIncome ? breakEvenAnn : breakEvenCv;
    // 含红利口径：说明书只在部分年度披露含红利现价，末年缺值时取最后一个有值年度
    let breakEvenD = null;
    if (div) {
      for (const row of rows) {
        if (row.divCv !== null && row.totalD >= row.paid) { breakEvenD = row.t; break; }
      }
    }
    const withDiv = rows.filter(r => r.divCv !== null);
    const endD = withDiv.length ? withDiv[withDiv.length - 1] : null;
    return { rows, np, breakEven, breakEvenCv, breakEvenAnn, breakEvenD, hasAnn: hasAnn || !!ben,
      annuity: !!ben, end: rows[rows.length - 1], endD, div };
  }

  function fmtPct(v) { return v === null || v === undefined ? "—" : v.toFixed(2) + "%"; }
  function fmtNum(v) { return Math.round(v).toLocaleString("zh-CN"); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function selectHtml(name, label, options, current, disabled) {
    return `<label class="mp-field"><span>${label}</span>
      <select data-mp="${name}" ${disabled ? "disabled" : ""}>
        ${options.map(v => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v || "—")}</option>`).join("")}
      </select></label>`;
  }

  function milestoneAges(r) {
    const terms = (r.dims && r.dims.term) || [];
    return terms.some(t => t && t.indexOf("终身") >= 0) ? [60, 70, 80, 105] : [];
  }

  function dualValue(guaranteed, divRate) {
    if (divRate === undefined) return fmtPct(guaranteed);
    return `${fmtPct(guaranteed)}<span class="yield-div"> / ${fmtPct(divRate)}</span>`;
  }

  // 卡片固定展示第 5 / 10 / 20 个保单年度（现价表实际有的年度才显示）
  const CARD_YEARS = [5, 10, 20];

  // 回本文案：现价表跳年披露时只能给区间（上一个未达标年度 + 1 ~ 首个达标年度）
  function beTextOf(rows, year) {
    if (!year || !rows) return "未回本";
    return beRangeOf(rows, year);
  }

  // 含红利口径：年度网格只取「披露了含红利现价」的那些年，否则区间会被拉长到 20 年
  function beTextDiv(rows, year) {
    if (!year || !rows) return "未回本";
    const seg = rows.filter(r => r.divCv !== null && r.divCv !== undefined);
    return beRangeOf(seg, year);
  }

  function beRangeOf(rows, year) {
    const idx = rows.findIndex(r => r.t === year);
    if (idx > 0 && rows[idx].t - rows[idx - 1].t > 1) {
      return `第 ${rows[idx - 1].t + 1}–${year} 年`;
    }
    return `第 ${year} 年`;
  }

  function cardsHtml(r, data) {
    const hasDiv = !!data.div && !!data.endD;
    const cards = [];
    const years = CARD_YEARS.filter(t => data.rows.some(x => x.t === t));
    if (years.length) {
      const keyYear = years.indexOf(10) >= 0 ? 10 : years[0];
      years.forEach(t => {
        const row = data.rows.find(x => x.t === t);
        cards.push(`<div class="yield-card${t === keyYear ? " is-key" : ""}">
          <span class="yield-card-label">至第 ${t} 保单年度年化${hasDiv ? "（保证/含红利）" : ""}</span>
          <strong>${row ? dualValue(row.irr, hasDiv ? row.divIrr : undefined) : "—"}</strong>
        </div>`);
      });
    } else {
      cards.push(`<div class="yield-card is-key">
        <span class="yield-card-label">满期年化${hasDiv ? "（保证 / 含红利）" : ""}</span>
        <strong>${dualValue(data.end.irr, hasDiv ? data.end.divIrr : undefined)}</strong>
      </div>`);
    }
    const beText = beTextOf(data.rows, data.breakEven);
    const beDText = beTextDiv(data.rows, data.breakEvenD);
    cards.push(`<div class="yield-card">
      <span class="yield-card-label">回本年限${data.hasAnn ? "（含年金领取）" : ""}${hasDiv ? "（保证/含红利）" : ""}</span>
      <strong>${hasDiv ? `${beText} / ${beDText}` : beText}</strong>
    </div>`);
    return cards.join("");
  }

  // 曲线用"按容器实际宽度绘制"的方式，viewBox 宽度 = CSS 像素宽度，
  // 这样 SVG 不做非等比缩放，坐标轴文字不会被拉扁或拉长。
  function chartHost(open) {
    return `<div class="yield-chart-actions">
        <button class="ghost-btn" type="button" data-yield-chart-toggle aria-expanded="${open ? "true" : "false"}">${open ? "收起曲线" : "查看曲线"}</button>
      </div>
      <div class="yield-chart" data-chart${open ? "" : " hidden"}></div>`;
  }

  // 单调三次插值（Fritsch–Carlson）：曲线平滑，但不会在两个数据点之间越过端点，
  // 避免平滑把 IRR 画到根本不存在的高点或低点。
  function curvePath(points) {
    const n = points.length;
    if (n < 2) return "";
    if (n === 2) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
    const dx = [], slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = points[i + 1].x - points[i].x;
      slope[i] = dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i];
    }
    const m = new Array(n);
    m[0] = slope[0];
    m[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    }
    for (let i = 0; i < n - 1; i += 1) {
      if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / slope[i], b = m[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * a * slope[i];
        m[i + 1] = tau * b * slope[i];
      }
    }
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i += 1) {
      const c1x = points[i].x + dx[i] / 3;
      const c1y = points[i].y + (m[i] * dx[i]) / 3;
      const c2x = points[i + 1].x - dx[i] / 3;
      const c2y = points[i + 1].y - (m[i + 1] * dx[i]) / 3;
      d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${points[i + 1].x.toFixed(1)},${points[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  // opts.smooth：用平滑曲线连接（说明书示例按年跳点，只能平滑）
  // opts.caption：图下注脚
  function chartSvg(data, width, opts) {
    const o = opts || {};
    const pts = data.rows.filter(x => x.irr !== null && x.irr >= -15);
    if (pts.length < 2) return "";
    const W = Math.max(320, Math.round(width));
    const H = Math.max(180, Math.min(280, Math.round(W * 0.3)));
    const L = 62, R = 16, T = 14, B = 26;
    const values = pts.map(p => p.irr).concat(pts.map(p => p.divIrr).filter(v => v !== null && v !== undefined && v >= -15));
    let max = Math.max(...values);
    let min = Math.min(0, ...values);
    const span = (max - min) || 1;
    const pad = span * 0.14;
    max += pad;
    min = min < 0 ? min - pad * 0.5 : -pad * 0.5;
    // 横轴按保单年度定位：说明书示例是不连续年度，不能按序号排
    const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
    const x = t => L + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - L - R);
    const y = v => T + (1 - (Math.max(v, min) - min) / (max - min)) * (H - T - B);
    const segments = arr => arr.map(p => ({ x: x(p.t), y: y(p.v) }));
    const linePath = arr => (o.smooth ? curvePath(arr) : arr
      .map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));

    const path = linePath(segments(pts.map(p => ({ t: p.t, v: p.irr }))));
    let divPath = "";
    if (data.div) {
      const seg = pts.filter(p => p.divIrr !== null && p.divIrr !== undefined);
      if (seg.length > 1) divPath = linePath(segments(seg.map(p => ({ t: p.t, v: p.divIrr }))));
    }

    const crossesZero = min < 0 && max > 0;
    // 0% 与上下刻度太近时不再单独标注，否则文字会叠在一起
    const zeroLabelY = y(0);
    const crowded = Math.abs(zeroLabelY - y(min)) < 13 || Math.abs(zeroLabelY - y(max)) < 13;
    const zeroLine = crossesZero
      ? `<line x1="${L}" y1="${zeroLabelY}" x2="${W - R}" y2="${zeroLabelY}" stroke="#8a8574" stroke-width="1" stroke-dasharray="5 4"/>
         ${crowded ? "" : `<text x="${L - 8}" y="${zeroLabelY + 3.5}" text-anchor="end" class="yield-axis yield-zero">0%</text>`}`
      : "";
    const ticks = [max, min].map(v => `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="yield-axis">${v.toFixed(1)}%</text>`).join("");
    // 刻度按「年度步长」等距取整，避免跳年披露时标签挤在左边
    const spanT = tMax - tMin;
    const stepT = spanT > 60 ? 20 : spanT > 30 ? 10 : spanT > 12 ? 5 : 2;
    const tickYears = [];
    for (let t = Math.ceil(tMin / stepT) * stepT; t <= tMax; t += stepT) tickYears.push(t);
    if (!tickYears.length || tickYears[0] - tMin > spanT * 0.12) tickYears.unshift(tMin);
    if (tMax - tickYears[tickYears.length - 1] > spanT * 0.12) tickYears.push(tMax);
    const xTicks = tickYears
      .map(t => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" class="yield-axis">第${t}年</text>`).join("");

    const legendTxt = divPath ? "实线为保证口径，虚线为含红利口径" : "实线为保证口径";
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="各年度退保年化收益率曲线">
        ${zeroLine}
        <path d="${path}" fill="none" stroke="#a9812f" stroke-width="2" stroke-linejoin="round"/>
        ${divPath ? `<path d="${divPath}" fill="none" stroke="#245d4c" stroke-width="2" stroke-linejoin="round" stroke-dasharray="6 4"/>` : ""}
        ${ticks}${xTicks}
        <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#e5e0d4" stroke-width="1"/>
      </svg>
      <p class="yield-chart-caption">${esc(o.caption ? `${o.caption}；${legendTxt}` : legendTxt)}</p>`;
  }

  // 说明书示例 → 画图用的序列（irr 统一成百分数）
  function demoChartData(id, idx) {
    const ser = demoSeries(id, idx);
    if (!ser) return null;
    const rows = ser.rows.map(r => ({
      t: r.t,
      irr: r.irr === null ? null : r.irr * 100,
      divIrr: r.divIrr === null ? null : r.divIrr * 100,
    }));
    return { rows, div: ser.div, hasAnn: true };
  }

  function paintChart(sectionEl, sel) {
    const host = sectionEl.querySelector("[data-chart]");
    if (!host || host.hidden) return;      // 曲线默认收起，展开时才画（隐藏时量不到宽度）
    const r = rec(sectionEl.dataset.yieldSection);
    if (!r) return;
    const st = state[sectionEl.dataset.yieldSection] || {};
    const w = host.clientWidth || host.parentElement.clientWidth || 640;
    if (r.demoOnly) {
      const data = demoChartData(sectionEl.dataset.yieldSection, st.defIdx || 0);
      host.innerHTML = data
        ? chartSvg(data, w, { smooth: true, caption: "该曲线由平滑生成得到，与真实值可能有差异" })
        : "";
      return;
    }
    const data = seriesOf(r, sel);
    if (!data) { host.innerHTML = ""; return; }
    host.innerHTML = chartSvg(data, w);
  }

  function paintAll() {
    document.querySelectorAll("[data-yield-section]").forEach(sectionEl => {
      const id = sectionEl.dataset.yieldSection;
      const st = state[id];
      if (!st || !sectionEl.offsetParent) return;
      paintChart(sectionEl, st.sel);
    });
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paintAll, 160);
  });

  // 详细表：默认只显示关键节点，节点之间的年份按「区间」分段展开
  const KEY_YEARS = [5, 10, 20, 30];

  // 把年份切成「关键节点」和若干「节点之间的区间」，例如
  //   1-4 / 5 / 6-9 / 10 / 11-19 / 20 / 21-29 / 30 / 31-70
  // 只返回非空的区间，供分段展开使用
  function gapsOf(years) {
    const keys = KEY_YEARS.filter(k => years.indexOf(k) >= 0);
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

  function tableHtml(data, showDiv, divHint) {
    const all = data.rows;
    const years = all.map(r => r.t);
    const gaps = gapsOf(years);
    // 行 → 所属区间序号（关键节点不属于任何区间，始终显示）
    const gapOf = {};
    gaps.forEach((g, i) => g.years.forEach(y => { gapOf[y] = i; }));
    // 第一个区间（1–4 年，即第一个关键节点之前的年份）默认展开
    const openGap = 0;
    let marked = false;
    const line = row => {
      const be = !marked && row.cv >= row.paid;
      if (be) marked = true;
      const gi = gapOf[row.t];
      const hide = gi !== undefined && gi !== openGap;
      return `<tr${be ? ' class="is-breakeven"' : ""} data-t="${row.t}"${gi === undefined ? "" : ` data-gap="${gi}"`}${hide ? " hidden" : ""}>
        <td>${row.t}</td><td>${row.age}</td><td>${fmtNum(row.paid)}</td><td>${fmtNum(row.cv)}</td>
        ${data.hasAnn ? `<td>${fmtNum(row.ann)}</td><td>${fmtNum(row.total)}</td>` : ""}
        <td class="${row.irr !== null && row.irr >= 0 ? "pos" : ""}">${fmtPct(row.irr)}</td>
        ${showDiv ? `<td>${row.divCv === null || row.divCv === undefined ? "" : fmtNum(row.divCv)}</td>` : ""}
        ${showDiv ? `<td class="${row.divIrr !== null && row.divIrr !== undefined && row.divIrr >= 0 ? "pos" : ""}">${row.divIrr === null || row.divIrr === undefined ? "" : fmtPct(row.divIrr)}</td>` : ""}
      </tr>`;
    };
    const rows = all.map(line).join("");
    // 分段按钮放在表格外面（表格本身可滚动，放里面会被滚出视野）
    const tools = gaps.length
      ? `<div class="yield-table-tools">
          <span class="yield-table-hint">默认显示第 ${KEY_YEARS.filter(k => years.indexOf(k) >= 0).join("/")} 保单年度，点右侧分段展开</span>
          <div class="gap-chips" role="group" aria-label="按区间展开">
            ${gaps.map((g, i) => {
              const on = i === openGap;
              return `<button class="gap-chip${on ? " is-active" : ""}" type="button" data-yield-gap="${i}" aria-pressed="${on ? "true" : "false"}">
              <span class="gap-chip-mark">${on ? "−" : "+"}</span>${g.from === g.to ? `${g.from}` : `${g.from}–${g.to}`} 年</button>`;
            }).join("")}
          </div>
        </div>`
      : "";
    return `${divHint ? `<p class="yield-table-hint">${esc(divHint)}</p>` : ""}
      ${tools}
      <div class="yield-table-wrap">
      <table class="yield-table">
        <thead><tr><th>保单年度</th><th>年龄</th><th>累计保费</th><th>期末现金价值</th>${data.hasAnn ? "<th>累计领取</th><th>领取＋现价</th>" : ""}<th>退保年化</th>${showDiv ? "<th>含红利现价</th><th>含红利年化</th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function bodyHtml(r, st) {
    const data = seriesOf(r, st.sel);
    if (!data) {
      return `<p class="yield-missing">当前模型点组合在披露的现价全表中无对应数据，请切换其他模型点。</p>`;
    }
    const defIdx = matchDef(r, st.sel);
    const list = defsOf(r);
    let srcNote;
    if (defIdx >= 0 && list[defIdx].src === "说明书示例模型点") {
      srcNote = list.length > 1
        ? `当前为产品说明书示例 ${defIdx + 1}（共 ${list.length} 个示例）`
        : "示例模型点取自产品说明书的利益演示示例";
    } else if (defIdx >= 0) {
      srcNote = "该产品说明书未给出可解析的示例模型点，采用标准模型点";
    } else {
      srcNote = "当前模型点为手动调整，非说明书示例";
    }
    const adjustable = [];
    [["性别", "sex"], ["投保年龄", "age"], ["交费期间", "pay"]].forEach(([label, f]) => {
      if (available(r, st.sel, f).length > 1) adjustable.push(label);
    });
    if (r.termParts) {
      if (partOptions(r, st.sel, "term").length > 1) adjustable.push("保险期间");
      if (partOptions(r, st.sel, "lead").length > 1) adjustable.push("年金起领日期");
    } else if (available(r, st.sel, "term").length > 1) {
      adjustable.push("保险期间");
    }
    const adjustableNote = adjustable.length ? `可调整${adjustable.join("、")}。` : "该产品仅披露单一模型点。";
    const unitNote = r.sourceUnit
      ? `<br>原始现价表为${r.sourceUnit === "per1000sa" ? "每千元基本保险金额" : r.sourceUnit === "per10000sa" ? "每万元基本保险金额" : "每份"}口径；已按同一模型点的公开年交保险费率换算为每千元年交保费口径，费率缺失的模型点不展示。`
      : "";
    const hasAnyDiv = list.some(d => d.div);
    const cur = defIdx >= 0 ? list[defIdx] : null;
    const divMeta = cur && cur.div
      ? `<div class="yield-dividend-meta"><strong>红利方式：${esc(divMethod(cur) || "说明书未演示红利")}</strong><span>${cur.div.derived ? "含红利退保总利益＝保证现金价值＋累积红利（均取说明书披露值）" : "含红利现金价值直接取自说明书利益演示表"}。红利仅展示利益演示表中情况，为非保证利益。</span></div>`
      : "";
    let divNote = "";
    if (hasAnyDiv) {
      if (!(cur && cur.div)) {
        const where = list.filter(d => d.div)
          .map((d, i) => `${d.age} 岁${d.sex}、${d.pay}`).join("；");
        divNote = cur
          ? `<br>只能查看示例模型点的含红利IRR：当前示例未披露红利演示（已披露的有 ${esc(where)}），含红利列一律留空。`
          : `<br>只能查看示例模型点的含红利IRR：红利演示仅披露于说明书示例（${esc(where)}），当前模型点已调整，含红利列一律留空。`;
      }
    }

    // 详细表默认只展开这几个关键年度，其余折叠（76 行的表看着累）
    const divCols = !!(cur && cur.div);
    const divHint = hasAnyDiv && !divCols ? "仅示例模型点可展示含红利结果" : "";
    return `
      ${divMeta}
      <div class="yield-cards">${cardsHtml(r, data)}</div>
      ${tableHtml(data, divCols, divHint)}
      ${chartHost(st.chartOpen)}
      <p class="yield-footnote">
        示例模型点来源：${esc(srcNote)}；${adjustableNote}
      </p>
      <p class="yield-footnote">
        测算口径：按每千元年交保险费计，保费于各保单年度「年初」支付，生存金与退保现价计在「年末」，目标年度末退保一次性取回；不含身故给付。数据取自官方现价全表。${unitNote}${divNote}
      </p>`;
  }

  // 保险期间与年金起领日期各占一行；产品只有其中一个时只显示那一行
  function partSelects(r, sel) {
    const tv = partOptions(r, sel, "term");
    const lv = partOptions(r, sel, "lead");
    const out = [];
    if (tv.length) out.push(selectHtml("term", "保险期间", tv, partOf(r, sel.term, "term"), tv.length <= 1));
    if (lv.length) out.push(selectHtml("lead", "年金起领日期", lv, partOf(r, sel.term, "lead"), lv.length <= 1));
    if (!out.length) out.push(selectHtml("term", "保险期间", [sel.term], sel.term, true));
    return out.join("");
  }

  function panelHtml(r, st) {
    normalize(r, st.sel);
    const dims = r.dims;
    const opts = field => {
      const avail = available(r, st.sel, field);
      return avail.length ? avail : (dims[field] || []);
    };
    const termOpts = opts("term");
    return `
      <div class="yield-modelpoint">
        ${selectHtml("sex", "性别", opts("sex"), st.sel.sex, opts("sex").length <= 1)}
        ${selectHtml("age", "投保年龄", opts("age"), st.sel.age, opts("age").length <= 1)}
        ${selectHtml("pay", "交费期间", opts("pay"), st.sel.pay, opts("pay").length <= 1)}
        ${r.termParts
          ? partSelects(r, st.sel)
          : selectHtml("term", "保险期间", termOpts, st.sel.term, termOpts.length <= 1)}
        ${defsOf(r).map((d, i) => {
          const n = defsOf(r).length;
          const label = n > 1 ? `恢复示例${i + 1}` : "恢复示例";
          const active = matchDef(r, st.sel) === i ? " is-active" : "";
          return `<button class="yield-reset${active}" type="button" data-def-idx="${i}" title="${esc(d.age)} 岁${esc(d.sex)}、${esc(d.pay)}">${label}</button>`;
        }).join("")}
        <button class="yield-similar" type="button" data-similar>查看可比产品</button>
      </div>
      <div class="yield-body">${bodyHtml(r, st)}</div>`;
  }

  // 不参与测算的产品必须给出可核对的理由：详情页、对比页共用这一份文案
  function reasonOf(product) {
    if (!product) return "";
    if (hasYield(product.id)) return "";
    // 产品自带说明优先（其他保险公司的口径与阳光不同）
    if (product.yieldNote) return product.yieldNote;
    const sub = product.subcategory || "";
    const onSale = String(product.status || "").indexOf("在售") >= 0;
    const cv = (product.documents || {}).cash_values || {};
    const hasCv = !!cv.available;
    if (sub === "年金") {
      return "本产品是年金类产品，缺少年金给付数据，暂不进行分析";
    }
    if (sub === "其他") {
      if (!onSale) return "本产品是已停售的其他类产品，暂不进行分析";
      return hasCv
        ? "本产品是纯保障型定期寿险，保险期间届满现金价值归零，退保年化不具参考意义，暂不进行分析"
        : "本产品是纯保障型定期寿险，官方未披露现价全表，暂不进行分析";
    }
    if (!onSale) {
      return hasCv
        ? "该产品已停售，历史现价全表未能解析出可用曲线，暂不进行分析"
        : "该产品已停售，官方未披露现价全表，暂不进行分析";
    }
    return hasCv
      ? "该产品的现价全表未能解析出可用曲线，暂不进行分析"
      : "该产品官方未披露现价全表，暂不进行分析";
  }


  /* ---------- 年金：说明书利益演示口径（含年金领取） ---------- */
  // 说明书给出多个示例时，提供与其他产品一致的「示例N」切换按钮
  function demoSwitcherHtml(r, idx) {
    const list = defsOf(r);
    if (list.length <= 1) return "";
    const money = v => v >= 10000 ? (v / 10000) + "万" : String(v);
    const btn = (x, i) => {
      const prem = x.div && x.div.prem
        ? (/趸交/.test(x.pay) ? money(x.div.prem) : `${money(x.div.prem)}/年`)
        : "";
      const label = `示例 ${i + 1}｜${x.age} 岁${x.sex}｜${x.pay}｜${prem}`;
      return `<button class="yield-reset${i === idx ? " is-active" : ""}" type="button" data-def-idx="${i}">${esc(label)}</button>`;
    };
    return `<div class="yield-modelpoint">${list.map(btn).join("")}</div>`;
  }

  // 说明书示例 → 与非年金现价曲线同结构的时间序列（详情页与对比页共用）
  // 说明书没写红利方式时用数据形态反推：累计领取变大=交清增额，只有现价变大=累积生息，
  // 两列完全一致说明这次演示没走红利。返回 null 时界面上就说"无红利演示"。
  function divMethod(d) {
    const v = d && d.div;
    if (!v) return null;
    if (v.method) return v.method;
    if (!v.annD || !v.cvD || !v.annG || !v.cvG) return null;
    const annDiff = v.years.some((y, i) => Math.abs(v.annD[i] - v.annG[i]) > 0.5);
    const cvDiff = v.years.some((y, i) => Math.abs(v.cvD[i] - v.cvG[i]) > 0.5);
    if (!annDiff && !cvDiff) return null;
    return annDiff ? "交清增额" : "累积生息";
  }

  function demoSeries(id, idx) {
    const r = rec(id);
    if (!r) return null;
    const list = defsOf(r);
    const d = list[Math.max(0, Math.min(idx || 0, list.length - 1))];
    const div = d && d.div;
    if (!div || !div.years || !div.annG || !div.cvG) return null;
    const np = /趸交/.test(d.pay) ? 1 : (parseInt(d.pay, 10) || 1);
    const prem = div.prem;
    // 逐年现金流：相邻披露年度之间的累计领取按等额分摊到各年（年金为固定金额），
    // 末年另加当年现金价值（满期时即满期保险金）。
    const flowsTo = (i, annArr, cvv) => {
      const y = div.years[i];
      const f = new Array(y + 1).fill(0);
      for (let k = 0; k < Math.min(np, y); k += 1) f[k] -= prem;
      let prevY = 0, prevA = 0;
      for (let j = 0; j <= i; j += 1) {
        const yy = div.years[j], aa = annArr[j];
        const span = yy - prevY;
        if (span > 0) {
          const per = (aa - prevA) / span;
          for (let k = prevY + 1; k <= yy; k += 1) f[k] += per;
        }
        prevY = yy; prevA = aa;
      }
      f[y] += cvv;
      return f;
    };
    // 分红产品才有「保证 / 含红利」两种口径。说明书示例里的 D 列（含红利）对不
    // 分红产品是与 G 列完全相同的复制，不能因此把两种口径都摆出来。
    const hasDiv = !!(div.annD && div.cvD) && div.years.some((y, i) =>
      Math.abs((div.annD[i] + div.cvD[i]) - (div.annG[i] + div.cvG[i])) > 0.5);
    const rows = div.years.map((y, i) => {
      const annG = div.annG[i], annD = div.annD[i];
      const cvG = div.cvG[i], cvD = div.cvD[i];
      return {
        t: y, paid: div.paid[i], np,
        ann: annG, annD, cv: cvG, divCv: hasDiv ? cvD : null,
        total: annG + cvG, totalD: hasDiv ? annD + cvD : annG + cvG,
        irr: irr(flowsTo(i, div.annG, cvG)),
        divIrr: hasDiv ? irr(flowsTo(i, div.annD, cvD)) : null,
      };
    });
    let beG = null, beD = null;
    rows.forEach(x => {
      if (beG === null && x.total >= x.paid) beG = x.t;
      if (hasDiv && beD === null && x.totalD >= x.paid) beD = x.t;
    });
    const withDiv = rows.filter(x => x.divCv !== null);
    // 红利方式：说明书的红利演示不写方式，只能从数据形态判断——
    // 年金领取（保额）随红利变大的是交清增额，领取不变、只有现价变大的是累积生息。
    const annDiff = hasDiv && div.years.some((y, i) => Math.abs(div.annD[i] - div.annG[i]) > 0.5);
    const method = !hasDiv ? null : (div.method || (annDiff ? "交清增额" : "累积生息"));
    return {
      rows, np, prem, cf: div,
      div: hasDiv ? { method, derived: false } : null,
      hasDiv, def: d, hasAnn: true,
      breakEven: beG, breakEvenAnn: beG, breakEvenCv: null, breakEvenD: beD,
      end: rows[rows.length - 1], endD: withDiv.length ? withDiv[withDiv.length - 1] : null,
    };
  }

  function demoPanelHtml(r, product) {
    const list = defsOf(r);
    const st = selFor(product.id);
    const idx = Math.max(0, Math.min(st.defIdx || 0, list.length - 1));
    const d = list[idx] || r.def;
    const ser = demoSeries(product.id, idx);
    if (!ser) return `<p class="yield-na">说明书未披露可解析的年金利益演示。</p>`;
    const prem = ser.prem;
    const rows = ser.rows.map(x => ({
      y: x.t, paid: x.paid, annG: x.ann, annD: x.annD, cvG: x.cv, cvD: x.divCv,
      totG: x.total, totD: x.totalD, irrG: x.irr, irrD: x.divIrr,
    }));
    const at = y => rows.find(x => x.y === y) || null;
    const r10 = at(10) || rows[Math.min(9, rows.length - 1)];
    const r20 = at(20) || rows[rows.length - 1];
    // 回本：说明书若跳年披露，只能给出「上一个未达标年度+1 ~ 首个达标年度」的区间
    const beRange = key => {
      const hits = rows.filter(x => x[key] >= x.paid);
      if (!hits.length) return "未回本";
      const first = hits[0];
      const prev = rows.filter(x => x.y < first.y).pop();
      return (prev && first.y - prev.y > 1)
        ? `第 ${prev.y + 1}–${first.y} 年`
        : `第 ${first.y} 年`;
    };
    const pct = v => (v === null || v === undefined) ? "—" : (v * 100).toFixed(2) + "%";
    // 分红产品才有「保证 / 含红利」两种口径；不分红产品的 D 列只是 G 列的复制
    const hasDiv = !!ser.hasDiv;
    const dual = (a, b) => hasDiv ? `${fmtNum(a)} / ${fmtNum(b)}` : fmtNum(a);
    const dualPct = (a, b) => hasDiv ? `${pct(a)} / ${pct(b)}` : pct(a);
    const th = t => `<th>${t}${hasDiv ? "（保证/含红利）" : ""}</th>`;
    const sparse = rows.some((x, i) => i > 0 && x.y - rows[i - 1].y > 1);
    const capNote = (hasDiv
      ? "回本按「累计领取＋当年现金价值 ≥ 累计保费」判定；含红利列取说明书红利利益演示值。红利仅展示利益演示表中情况，为非保证利益。"
      : "回本按「累计领取＋当年现金价值 ≥ 累计保费」判定；该产品不分红，说明书利益演示只有保证利益一套数值。")
      + (sparse ? "说明书只披露部分保单年度。" : "");
    const card = (label, val, key) => `<div class="yield-card${key ? " is-key" : ""}">
      <span class="yield-card-label">${label}</span><strong>${val}</strong></div>`;
    const table = `<div class="yield-table-wrap"><table class="yield-table">
      <thead><tr><th>保单年度</th><th>累计保费</th>${th("累计领取")}${th("现金价值")}${th("合计")}${th("年化")}</tr></thead>
      <tbody>${rows.map(x => `<tr><td>${x.y}</td><td>${fmtNum(x.paid)}</td>
        <td>${dual(x.annG, x.annD)}</td>
        <td>${dual(x.cvG, x.cvD)}</td>
        <td>${dual(x.totG, x.totD)}</td>
        <td>${dualPct(x.irrG, x.irrD)}</td></tr>`).join("")}</tbody>
    </table></div>`;
    const dualSuffix = hasDiv ? "（保证/含红利）" : "";
    return `
      ${demoSwitcherHtml(r, idx)}
      <div class="yield-dividend-meta"><strong>口径：累计领取＋当年现金价值（含年金领取）</strong>
        <span>示例模型点：${esc(d.age)} 岁${esc(d.sex)}、${esc(d.pay)}、${esc(d.term || "见说明书")}；年交保费 ${fmtNum(prem)} 元。${list.length > 1 ? `当前为说明书示例 ${idx + 1}（共 ${list.length} 个）。` : ""}数据取自说明书利益演示表。</span></div>
      <div class="yield-cards">
        ${card(`至第 ${r10.y} 保单年度年化${dualSuffix}`, dualPct(r10.irrG, r10.irrD), true)}
        ${r20.y !== r10.y ? card(`至第 ${r20.y} 保单年度年化${dualSuffix}`, dualPct(r20.irrG, r20.irrD), false) : ""}
        ${card("回本年限（含年金领取）" + dualSuffix, hasDiv ? `${beRange("totG")} / ${beRange("totD")}` : beRange("totG"), false)}
      </div>
      ${table}
      ${chartHost(false)}
      <p class="yield-chart-caption" data-chart-caption hidden>${capNote}</p>`;
  }

  function section(product) {
    const r = rec(product.id);
    if (!r && hasYield(product.id)) {
      // 数据还没加载：先占位，加载完自动替换成完整面板
      ensure(product.id)
        .then(() => refreshSection(product))
        .catch(() => {
          const el = document.querySelector(`[data-yield-section="${product.id}"]`);
          if (el) el.querySelector(".yield-loading").textContent = "收益率数据加载失败，请刷新页面重试。";
        });
      return `
      <section class="detail-section" data-yield-section="${esc(product.id)}" data-yield-pending>
        <div class="detail-section-heading"><span>03</span><h3>收益率分析</h3></div>
        <p class="yield-loading">正在加载该产品的收益率数据…</p>
      </section>`;
    }
    if (!r) {
      return `
      <section class="detail-section" data-yield-section="${esc(product.id)}" data-yield-empty>
        <div class="detail-section-heading"><span>03</span><h3>收益率分析</h3></div>
        <p class="yield-na">${esc(reasonOf(product))}</p>
      </section>`;
    }
    const st = selFor(product.id);
    const stopped = String(product.status || "").indexOf("停售") >= 0;
    let html = r.demoOnly ? demoPanelHtml(r, product) : panelHtml(r, st);
    // 年金产品的「回本年限」只计现金价值、不含年金领取，标注清楚避免误读
    if (!r.demoOnly && product.subcategory === "年金") {
      // 年金现在已把生存金计入现金流，回本按「累计领取＋现价 ≥ 累计保费」判定
      html = html.replace(">回本年限<", ">回本年限（含年金领取）<");
    }
    // 年金但没还原出给付结构的产品：表里的年化其实只有退保口径，必须说清楚，
    // 否则会和「含累计领取」的产品混在一起比较（实际是同一列名、不同口径）。
    // 说明书利益演示里如果披露了生存给付（div.annG），那年金收入是算进去的，不算缺失。
    const hasDemoAnn = defsOf(r).some(d => d.div && d.div.annG && d.div.annG.some(v => v > 0));
    const annUnknown = product.subcategory === "年金"
      && !(window.ANNUITY && window.ANNUITY[product.id]) && !hasDemoAnn;
    return `
      <section class="detail-section" data-yield-section="${esc(product.id)}">
        <div class="detail-section-heading"><span>03</span><h3>收益率分析</h3></div>
        <div class="yield-panel">${html}</div>
        ${annUnknown ? '<p class="yield-stopped-note">该产品的年金给付结构未能从说明书中还原：表中的年化收益率只反映「退保」口径，未计入年金领取，会明显低于实际领取收益，不宜与其他年金产品横向比较。</p>' : ""}
        ${stopped ? '<p class="yield-stopped-note">该产品已停售，分析结果可能不准确。</p>' : ""}
      </section>`;
  }

  // 数据加载完成后，把占位的 section 换成真正的面板并重新绑定事件
  function refreshSection(product) {
    const el = document.querySelector(`[data-yield-section="${product.id}"]`);
    if (!el || !rec(product.id)) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = section(product);
    const fresh = wrap.firstElementChild;
    if (!fresh) return;
    el.replaceWith(fresh);
    bind(document, product);
    const st = selFor(product.id);
    requestAnimationFrame(() => paintChart(fresh, st.sel));
  }

  function rerender(sectionEl, product) {
    const r = rec(product.id);
    const st = selFor(product.id);
    if (r.demoOnly) {
      sectionEl.querySelector(".yield-panel").innerHTML = demoPanelHtml(r, product);
      paintChart(sectionEl, st.sel);
      return;
    }
    sectionEl.querySelector(".yield-panel").innerHTML = panelHtml(r, st);
    paintChart(sectionEl, st.sel);
    if (window.SimilarModule) window.SimilarModule.sync(product.id, st.sel);
  }

  function bind(root, product) {
    const sectionEl = root.querySelector(`[data-yield-section="${product.id}"]`);
    if (!sectionEl) return;
    const st0 = selFor(product.id);
    requestAnimationFrame(() => paintChart(sectionEl, st0.sel));
    sectionEl.addEventListener("change", event => {
      const sel = event.target.closest("[data-mp]");
      if (!sel) return;
      const st = selFor(product.id);
      const field = sel.dataset.mp;
      if (field === "term" || field === "lead") {
        pickPart(rec(product.id), st.sel, field, sel.value);
      } else {
        st.sel[field] = sel.value;
      }
      st.open = false;
      rerender(sectionEl, product);
    });
    sectionEl.addEventListener("click", event => {
      if (event.target.closest("[data-similar]")) {
        const st = selFor(product.id);
        if (window.SimilarModule) window.SimilarModule.open(product.id, st.sel);
        return;
      }
      // 曲线默认收起：点了才画（隐藏状态下量不到容器宽度）
      const chartBtn = event.target.closest("[data-yield-chart-toggle]");
      if (chartBtn) {
        const st = selFor(product.id);
        st.chartOpen = !st.chartOpen;
        const host = sectionEl.querySelector("[data-chart]");
        if (host) host.hidden = !st.chartOpen;
        const cap = sectionEl.querySelector("[data-chart-caption]");
        if (cap) cap.hidden = !st.chartOpen;
        chartBtn.textContent = st.chartOpen ? "收起曲线" : "查看曲线";
        chartBtn.setAttribute("aria-expanded", st.chartOpen ? "true" : "false");
        if (st.chartOpen) paintChart(sectionEl, st.sel);
        return;
      }
      // 详细表：按「关键节点之间」的区间分段展开
      const gapBtn = event.target.closest("[data-yield-gap]");
      if (gapBtn) {
        const on = gapBtn.getAttribute("aria-pressed") !== "true";
        const gi = gapBtn.dataset.yieldGap;
        sectionEl.querySelectorAll(`tbody tr[data-gap="${gi}"]`).forEach(tr => { tr.hidden = !on; });
        gapBtn.setAttribute("aria-pressed", on ? "true" : "false");
        gapBtn.classList.toggle("is-active", on);
        const mark = gapBtn.querySelector(".gap-chip-mark");
        if (mark) mark.textContent = on ? "−" : "+";
        return;
      }
      const reset = event.target.closest("[data-def-idx]");
      if (reset) {
        const st = selFor(product.id);
        const r0 = rec(product.id);
        const i = parseInt(reset.dataset.defIdx, 10);
        if (r0 && r0.demoOnly) {
          st.defIdx = i;
          rerender(sectionEl, product);
          return;
        }
        st.sel = defaultSel(r0, i);
        st.open = true;
        rerender(sectionEl, product);
        return;
      }
    });
  }

  window.YieldModule = {
    section,
    bind,
    reason: reasonOf,
    has: id => hasYield(id),
    isDemo: id => !!(rec(id) && rec(id).demoOnly),
    // 是否真有两个口径：说明书示例里的含红利列对不分红产品只是保证列的复制
    hasDiv: id => !!rec(id) && defsOf(rec(id)).some(d => {
      if (!d.div) return false;
      // 年金记录的保证列来自现价全表、含红利列来自说明书示例，两者口径来源不同，
      // 因此只要说明书的「含红利」与「保证」两列在披露年度上完全一致，就说明这个产品
      // 没有真正分红，不再展示含红利列，避免出现「含红利低于保证」的假象。
      if (!rec(id).demoOnly && !rec(id).annuity) return true;
      const v = d.div;
      if (!v.annD || !v.cvD) return false;
      return v.years.some((y, i) => Math.abs((v.annD[i] + v.cvD[i]) - (v.annG[i] + v.cvG[i])) > 0.5);
    }),
    hasTable: id => hasYield(id),
    record: id => rec(id) || null,
    // 懒加载：结构数据要等注入后才能用
    ensure,
    isLoaded: id => loaded(id),
    points: id => (IDX.pts && IDX.pts[id]) || [],
    defs: id => (rec(id) ? defsOf(rec(id)) : []),
    dims: id => (rec(id) ? rec(id).dims : {}),
    keyOf: (id, sel) => (rec(id) ? keyOf(rec(id), sel) : ""),
    matchDef: (id, sel) => (rec(id) ? matchDef(rec(id), sel) : -1),
    series: (id, sel) => (rec(id) ? seriesOf(rec(id), sel) : null),
    demoSeries,
    curvePath,
    beText: beTextOf,
    beTextDiv,
    options: (id, sel, field) => (rec(id) ? available(rec(id), sel || {}, field) : []),
    partOptions: (id, sel, part) => (rec(id) && rec(id).termParts ? partOptions(rec(id), sel || {}, part) : []),
    partOf: (id, composite, part) => (rec(id) ? partOf(rec(id), composite, part) : ""),
    pickPart: (id, sel, part, value) => { if (rec(id)) pickPart(rec(id), sel, part, value); },
    hasParts: id => !!(rec(id) && rec(id).termParts),
    payYears: (r, sel) => payYearsOf(r, sel),
    fmtPct,
    fmtNum,
  };
})();
