/* 世界インフレ時代の経済指標ダッシュボード — フロントエンド
 * data/manifest.json を読んでカードを描画し、クリックで詳細チャートを開く。
 */

const DATA_BASE = "/data";
let MANIFEST = null;
let detailChart = null;
let periodChart = null;

// 全指標の完全な時系列を保持: SERIES[key] = [{date, value}, ...]（昇順）
const SERIES = {};
// 選択可能な月（全指標の観測月の和集合, 昇順 "YYYY-MM"）
let MONTHS = [];
// 現在選択中の月（カード・シグナルの「現在点」）
let currentMonth = null;
// 期間サマリの現在モード: "year" | "all" | "custom"
let periodMode = "year";
let customFrom = null, customTo = null;

// S&P500月次データ: { "YYYY-MM": {pct, level} }、イベント定義
let SP500 = {};
let EVENTS = [];
// AI生成レポート（analysis.json）。無ければnull→ルールベースにフォールバック
let AI_REPORT = null;
// グラフのオーバーレイ表示。S&Pは "off" | "pct"(月次騰落率) | "level"(価格)
let sp500Mode = "off";
let showEvents = false;

// 数値フォーマット
function fmtValue(v, unit) {
  if (v === null || v === undefined) return "—";
  const abs = Math.abs(v);
  let s;
  if (abs >= 1000) s = v.toLocaleString("ja-JP", { maximumFractionDigits: 0 });
  else if (abs >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return s;
}

function fmtChange(change, label) {
  if (change === null || change === undefined) return "";
  const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "→";
  const sign = change > 0 ? "+" : "";
  const val = Math.abs(change) >= 10 ? change.toFixed(1) : change.toFixed(2);
  return `<span class="arrow">${arrow}</span> ${sign}${val} <span class="card-unit">(${label})</span>`;
}

// 「良い方向」と実際の方向から色クラスを決める
function directionClass(direction, goodDirection) {
  if (direction === "flat" || !direction) return "dir-flat";
  if (!goodDirection) return direction === "up" ? "dir-up" : "dir-down";
  return direction === goodDirection ? "dir-up" : "dir-down";
}

// スパークライン（小さな折れ線）を canvas に描く
function drawSpark(canvas, data, color) {
  if (!data || data.length < 2) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * (w - 4) + 2;
    const y = h - 2 - ((v - min) / range) * (h - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ---- 月次の値・方向の算出 -----------------------------------------------
 * 既存の完全な時系列(SERIES)から、任意の月時点の値を引く。
 * 追加のデータ取得は不要。月切替・期間スコア推移の土台。
 */
function monthKey(dateStr) { return dateStr.slice(0, 7); } // "2026-05-01" -> "2026-05"

// key指標の、targetMonth(="YYYY-MM")「以前で最も新しい」観測とその一つ前を返す。
// → 値・前回比・方向を、その月時点として再現できる。
function valueAt(key, targetMonth) {
  const s = SERIES[key];
  if (!s || !s.length) return null;
  let idx = -1;
  for (let i = 0; i < s.length; i++) {
    if (monthKey(s[i].date) <= targetMonth) idx = i; else break;
  }
  if (idx < 0) return null; // その月以前に観測がない
  const cur = s[idx];
  const prev = idx > 0 ? s[idx - 1] : null;
  const change = prev ? cur.value - prev.value : null;
  let direction = "flat";
  if (change != null) direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return {
    latest_value: cur.value, latest_date: cur.date,
    prev_value: prev ? prev.value : null, change, direction,
  };
}

// targetMonth時点の各指標の表示用サマリ（manifestのind + その月のsummary）を返す。
function indicatorsAt(targetMonth) {
  return MANIFEST.indicators.map((ind) => {
    if (ind.status === "ok" && SERIES[ind.key]) {
      const sum = valueAt(ind.key, targetMonth);
      return { ...ind, summary: sum, _spark: sparkUpTo(ind.key, targetMonth) };
    }
    // manual / error はそのまま（月によらず固定表示）
    return { ...ind, _spark: null };
  });
}

// targetMonthまでの末尾60点をスパークライン用に返す
function sparkUpTo(key, targetMonth) {
  const s = SERIES[key];
  if (!s) return null;
  const upto = s.filter((p) => monthKey(p.date) <= targetMonth);
  return upto.slice(-60).map((p) => p.value);
}

function buildCard(ind) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.key = ind.key;
  card.tabIndex = 0; card.setAttribute("role", "button"); card.setAttribute("aria-label", `${ind.name_ja}の詳細`);
  card.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) {e.preventDefault(); openDetail(ind);} });

  const cat = ind.category ? `<span class="card-cat">${ind.category}</span>` : "";
  const head = `
    <div class="card-head">
      <span class="card-no">No.${ind.no}</span>
      ${cat}
    </div>
    <div class="card-name">${ind.name_ja}</div>
    <p class="card-name-en">${ind.name_en || ""}</p>
  `;

  let body = "";
  if (ind.status === "error") {
    body = `<div class="card-status-error">データ取得に失敗しました。</div>`;
  } else if (ind.status === "manual" && !ind.summary) {
    body = `<div class="card-status-manual">手動更新指標（FRED非対応）。最新値は未入力です。</div>`;
  } else if (ind.summary) {
    const s = ind.summary;
    const dirCls = directionClass(s.direction, ind.good_direction);
    const thr = (ind.threshold !== null && ind.threshold !== undefined)
      ? `<span class="threshold-tag">基準: ${ind.threshold}</span>` : "";
    body = `
      <div class="card-value-row">
        <span class="card-value">${fmtValue(s.latest_value, ind.unit)}</span>
        <span class="card-unit">${ind.unit || ""}</span>
      </div>
      <div class="card-change ${dirCls}">${fmtChange(s.change, ind.change_label || "前回表示値との差")}</div>
      <div class="card-date">${s.latest_date || "—"} 時点</div>
      ${thr}
      ${ind.stale_days ? `<p class="freshness-note">観測日の古い系列です。出典の更新状況を確認してください。</p>` : ""}
      ${ind._spark ? '<canvas class="spark" width="248" height="32"></canvas>' : ""}
    `;
  } else {
    body = `<div class="card-status-manual">この月にはデータがありません。</div>`;
  }

  card.innerHTML = head + body;

  // スパークライン描画（選択中の月までの推移）
  if (ind._spark && ind.summary) {
    const canvas = card.querySelector(".spark");
    if (canvas) {
      const dirCls = directionClass(ind.summary.direction, ind.good_direction);
      const color = dirCls === "dir-up" ? cssVar("--up")
        : dirCls === "dir-down" ? cssVar("--down") : cssVar("--flat");
      drawSpark(canvas, ind._spark, color);
    }
  }

  card.addEventListener("click", () => openDetail(ind));
  return card;
}

async function openDetail(ind) {
  const modal = document.getElementById("modal");
  document.getElementById("modal-title").textContent = `No.${ind.no} ${ind.name_ja}`;
  document.getElementById("modal-source").href = ind.source_url || "https://fred.stlouisfed.org/";
  const s = ind.summary;
  document.getElementById("modal-sub").textContent =
    s ? `最新 ${fmtValue(s.latest_value, ind.unit)} ${ind.unit || ""}（${s.latest_date}）` : "データなし";
  document.getElementById("modal-desc").textContent = ind.description || "";
  document.getElementById("modal-howto").textContent = ind.how_to_read || "";
  const fb = document.getElementById("modal-fallback");
  fb.textContent = ind.fallback_note || "";
  fb.style.display = ind.fallback_note ? "block" : "none";

  modal.classList.remove("hidden");

  // 時系列を描画（ロード済みのSERIESを再利用）
  if (detailChart) { detailChart.destroy(); detailChart = null; }
  if (ind.status === "ok" && SERIES[ind.key]) {
    try {
      // 期間タブで選んでいる範囲（年間/全期間/指定期間）にチャートを合わせる
      const months = periodMonths();
      const from = months[0], to = months[months.length - 1];
      let series = SERIES[ind.key];
      if (from && to) {
        series = series.filter((p) => {
          const m = monthKey(p.date);
          return m >= from && m <= to;
        });
      }
      // 期間内に観測が無い指標（四半期データ等で範囲が狭い場合）は全期間にフォールバック
      // Preserve the selected range even when it contains zero or one observation.

      // 期間ラベルをサブタイトルに反映
      const periodLabel = periodMode === "all" ? "全期間" : periodMode === "custom" ? "指定期間" : "過去12ヶ月";
      const baseSub = document.getElementById("modal-sub").textContent;
      document.getElementById("modal-sub").textContent =
        `${baseSub}　／　表示期間: ${periodLabel}（${from} 〜 ${to}）`;

      const labels = series.map((p) => p.date);
      const values = series.map((p) => p.value);
      const ctx = document.getElementById("detail-chart").getContext("2d");
      detailChart = new Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: `${ind.name_ja}（${ind.transform_label || ""}）`,
            data: values,
            borderColor: cssVar("--accent"),
            backgroundColor: "rgba(245,179,1,0.08)",
            fill: true, pointRadius: 0, borderWidth: 2, tension: 0.15,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: cssVar("--text-dim") } } },
          scales: {
            x: { ticks: { color: cssVar("--text-dim"), maxTicksLimit: 8 }, grid: { color: "rgba(255,255,255,0.04)" } },
            y: { ticks: { color: cssVar("--text-dim") }, grid: { color: "rgba(255,255,255,0.06)" } },
          },
        },
      });
    } catch (e) {
      console.error("チャート読込失敗", e);
    }
  }
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  if (detailChart) { detailChart.destroy(); detailChart = null; }
}

/* ---- 指標の解説（12指標一覧） -----------------------------------------
 * manifest の description（何を表すか）と how_to_read（見る観点）を一覧表示。
 */
function renderGuide() {
  const host = document.getElementById("guide-list");
  if (!host || !MANIFEST) return;
  const goodWord = (g) => g === "up" ? "上昇＝良い" : g === "down" ? "低下＝良い" : "—";
  host.innerHTML = MANIFEST.indicators
    .slice().sort((a, b) => a.no - b.no)
    .map((ind) => {
      const meta = [ind.category, ind.frequency, ind.unit].filter(Boolean).join(" / ");
      const thr = (ind.threshold != null) ? ` ・基準値 ${ind.threshold}` : "";
      const fb = ind.fallback_note ? `<p class="guide-fallback">※ ${escapeHtml(ind.fallback_note)}</p>` : "";
      return `
        <div class="guide-item">
          <div class="guide-item-head">
            <span class="guide-no">No.${ind.no}</span>
            <span class="guide-name">${escapeHtml(ind.name_ja)}</span>
            <span class="guide-en">${escapeHtml(ind.name_en || "")}</span>
          </div>
          <div class="guide-meta">${escapeHtml(meta)}${thr}・方向の目安: ${goodWord(ind.good_direction)}</div>
          <p class="guide-desc"><strong>どんな指標か:</strong> ${escapeHtml(ind.description || "")}</p>
          <p class="guide-howto"><strong>見る観点:</strong> ${escapeHtml(ind.how_to_read || "")}</p>
          ${fb}
        </div>`;
    }).join("");
}

/* ---- 景気の総合シグナル -------------------------------------------------
 * 各指標が「良い方向(good_direction)」に動いていれば +1、逆なら -1、
 * 横ばい・データなし・手動未入力は集計から除外する。
 * 集計対象の平均を -100〜+100% に正規化し、3段階の信号色に落とす。
 * manifest を直接読むので、指標を差し替えても自動で再計算される。
 */
function computeSignal(indicators) {
  let plus = 0, minus = 0, neutral = 0, counted = 0;
  const detail = [];
  for (const ind of indicators) {
    const s = ind.summary;
    // 集計対象外: エラー / 手動値なし / サマリなし / 方向定義なし
    if (!s || !ind.good_direction || s.direction === "flat" || s.direction == null) {
      neutral++;
      continue;
    }
    counted++;
    const good = s.direction === ind.good_direction;
    if (good) plus++; else minus++;
    detail.push({ no: ind.no, name: ind.name_ja, good });
  }
  const net = plus - minus;
  const score = counted ? Math.round((net / counted) * 100) : 0;
  return { score, plus, minus, neutral, counted, ...scoreLevel(score), detail };
}

// スコア → 信号レベル/ラベル/色（複数箇所で共有）
function scoreLevel(score) {
  if (score >= 25) return { level: "expand", label: "改善方向の指標が多め", color: "var(--up)" };
  if (score <= -25) return { level: "contract", label: "悪化方向の指標が多め", color: "var(--down)" };
  return { level: "neutral", label: "中立・まちまち", color: "var(--accent)" };
}

// targetMonth時点の総合スコアを返す（期間チャートで各月に対して呼ぶ）
function computeSignalAt(targetMonth) {
  return computeSignal(indicatorsAt(targetMonth));
}

function renderSignal(sig) {
  const host = document.getElementById("signal");
  if (!host) return;
  // スコアバー（-100〜+100 を 0〜100% にマップ）
  const barPct = Math.round(((sig.score + 100) / 200) * 100);
  host.innerHTML = `
    <div class="signal-inner">
      <div class="signal-main">
        <span class="signal-dot" style="background:${sig.color}"></span>
        <div class="signal-text">
          <div class="signal-label" style="color:${sig.color}">${sig.label}</div>
          <div class="signal-sub">方向スコア（独自の参考値）
            <strong style="color:${sig.color}">${sig.score > 0 ? "+" : ""}${sig.score}</strong>
            （改善方向 ${sig.plus} / 悪化方向 ${sig.minus} / 中立・除外 ${sig.neutral}）
          </div>
        </div>
      </div>
      <div class="signal-bar">
        <div class="signal-bar-track">
          <div class="signal-bar-mid"></div>
          <div class="signal-bar-fill" style="left:50%;width:${Math.abs(barPct - 50)}%;
               ${sig.score >= 0 ? "" : "transform:translateX(-100%);"}
               background:${sig.color}"></div>
        </div>
        <div class="signal-bar-labels"><span>悪化方向 −100</span><span>0</span><span>+100 改善方向</span></div>
      </div>
    </div><p class="method-note">（改善方向の数 − 悪化方向の数）÷ 方向が変化した指標数 × 100。横ばい・欠測は除外。成長率の加速・減速も含む独自集計で、景気判定や売買シグナルではありません。</p>`;
}

/* ---- 12指標の関係性に関するフラットな分析 ------------------------------
 * カテゴリ別に各指標の方向を集約し、12指標の状況・変遷・先行きの示唆を
 * 中立的な視点（特定の投資哲学に寄せない）でルール生成する。
 */
// currentMonth から nMonths 前の月のスコアを返す（範囲外はnull）
function scoreMonthsAgo(nMonths) {
  const idx = monthIndex(currentMonth) - nMonths;
  if (idx < 0) return null;
  return computeSignalAt(MONTHS[idx]).score;
}

// 先行指標とされるカテゴリ（先行きの示唆に使う）
const LEADING_CATEGORIES = ["住宅", "景況感", "センチメント", "生産・投資"];

function buildAnalysis() {
  const inds = indicatorsAt(currentMonth);

  // 1) カテゴリ別に「良い方向に動いている指標」を集計
  const byCat = {};
  inds.forEach((ind) => {
    const s = ind.summary;
    if (!s || !ind.good_direction || s.direction === "flat" || s.direction == null) return;
    const c = ind.category || "その他";
    byCat[c] = byCat[c] || { good: 0, bad: 0, names: [] };
    const good = s.direction === ind.good_direction;
    good ? byCat[c].good++ : byCat[c].bad++;
    byCat[c].names.push({ name: ind.name_ja, good });
  });
  // カテゴリの強弱を判定
  const catState = (c) => {
    const v = byCat[c]; if (!v) return null;
    const net = v.good - v.bad;
    if (net > 0) return "良好";
    if (net < 0) return "弱い";
    return "まちまち";
  };
  const cats = Object.keys(byCat);
  const strongCats = cats.filter((c) => catState(c) === "良好");
  const weakCats = cats.filter((c) => catState(c) === "弱い");
  const mixedCats = cats.filter((c) => catState(c) === "まちまち");

  // 2) 変遷：固定の3ヶ月/1年/3年ではなく、利用可能なデータ範囲から
  //    意味のある区切り（足元・中期・転換点）を動的に拾う。
  const now = computeSignalAt(currentMonth).score;
  const endIdx = monthIndex(currentMonth);
  // 現在月までのスコア系列を作る
  const path = MONTHS.slice(0, endIdx + 1).map((m) => ({ m, s: computeSignalAt(m).score }));
  const history = analyzePath(path);

  // 3) 先行指標カテゴリの向き（先行きの示唆）
  let leadGood = 0, leadBad = 0;
  LEADING_CATEGORIES.forEach((c) => { if (byCat[c]) { leadGood += byCat[c].good; leadBad += byCat[c].bad; } });
  const leadNet = leadGood - leadBad;

  return { now, byCat, catState, strongCats, weakCats, mixedCats, history, leadNet, leadGood, leadBad };
}

// スコア系列から「足元の向き」「中期の基調」「直近の転換点」を抽出する。
// データの長さに応じて参照する窓を自動調整し、固定期間に縛られない。
function analyzePath(path) {
  const n = path.length;
  if (n < 2) return { enough: false };
  const cur = path[n - 1].s;

  // 期間の長さを言葉で表す（月→「Nヶ月」/「N年」）
  const spanWord = (months) => months >= 24 ? `約${Math.round(months / 12)}年`
    : months >= 12 ? "約1年" : `約${months}ヶ月`;
  const word = (d) => d > 18 ? "大きく改善" : d > 8 ? "改善" :
    d < -18 ? "大きく悪化" : d < -8 ? "悪化" : "ほぼ横ばい";

  // 足元の向き：直近min(3, n-1)ヶ月の変化
  const recentWin = Math.min(3, n - 1);
  const recentDiff = cur - path[n - 1 - recentWin].s;

  // 中期の基調：データ全体の長さに応じた窓（最大36ヶ月、最小は足元より長く）
  const midWin = Math.min(n - 1, 36);
  const midDiff = cur - path[n - 1 - midWin].s;

  // 直近の転換点：後ろから見て、傾きの符号が反転する最後の点を探す（簡易な山/谷検出）
  // しきい値を超える「向きの持続」が変わった位置を転換点とみなす。
  let pivot = null;
  if (n >= 6) {
    const dir = (a, b) => { const d = b - a; return d > 4 ? 1 : d < -4 ? -1 : 0; };
    // 直近の支配的な向き
    let lastDir = 0;
    for (let i = n - 1; i >= 1; i--) {
      const d = dir(path[i - 1].s, path[i].s);
      if (d === 0) continue;
      if (lastDir === 0) { lastDir = d; continue; }
      if (d !== lastDir) { pivot = { m: path[i].m, fromDir: d, toDir: lastDir }; break; }
    }
  }

  return {
    enough: true, cur, word, spanWord,
    recentWin, recentDiff,
    midWin, midDiff,
    pivot,
    fullMonths: n - 1,
  };
}

// ① 現状の文章
function analysisCurrent(a) {
  // カテゴリ名自体に「・」を含むものがある（生産・投資）ため、区切りは「／」を使う
  const join = (arr) => arr.join("／");
  const parts = [];
  if (a.strongCats.length) parts.push(`<strong>${join(a.strongCats)}</strong>が相対的に堅調`);
  if (a.weakCats.length) parts.push(`<strong>${join(a.weakCats)}</strong>が弱含み`);
  if (a.mixedCats.length) parts.push(`${join(a.mixedCats)}はまちまち`);
  if (!parts.length) return "各指標の方向感が定まらず、分野ごとの強弱は判然としない。";
  let s = `12指標を分野別に見ると、${parts.join("、")}という構図だ。`;
  // 分野間の整合/不整合に言及
  if (a.strongCats.length && a.weakCats.length) {
    s += `好調な分野と弱い分野が併存しており、景気の力強さと脆さが同居している。`;
  } else if (a.strongCats.length && !a.weakCats.length) {
    s += `弱い分野が見当たらず、幅広い指標が同じ方向（拡大側）を向いている。`;
  } else if (a.weakCats.length && !a.strongCats.length) {
    s += `堅調な分野が乏しく、悪化が広い範囲に及んでいる。`;
  }
  return s;
}

// ② 変遷の文章（固定期間に縛られず、データ範囲に応じて柔軟に言及）
function analysisHistory(a) {
  const h = a.history;
  if (!h || !h.enough) return "比較できる過去データが十分でなく、変遷は評価しきれない。";

  const segs = [];
  // 中期の基調（窓が足元より十分長いときだけ別途言及）
  if (h.midWin > h.recentWin + 2) {
    segs.push(`${h.spanWord(h.midWin)}のスパンで見ると${h.word(h.midDiff)}`);
  }
  // 足元の向き
  segs.push(`直近${h.spanWord(h.recentWin)}では${h.word(h.recentDiff)}`);
  let s = `12指標を束ねた総合の流れは、${segs.join("、")}している。`;

  // 転換点があれば「～頃を境に」と具体的に触れる
  if (h.pivot) {
    const turn = h.pivot.toDir > 0 ? "持ち直しに転じた" : "下押しに転じた";
    s += `${h.pivot.m}頃を境に${turn}動きが見て取れる。`;
  } else {
    // 転換点がない＝一貫した流れ。中期と足元の整合/不整合で締める
    const r = h.recentDiff, m = h.midDiff;
    if (r > 8 && m < -8) s += `中期では下押しが続く一方、足元では持ち直しの兆しが出ている。`;
    else if (r < -8 && m > 8) s += `中期の改善基調に対し、ここへ来て息切れの感がある。`;
    else if (r < -8 && m < -8) s += `中期・足元ともに弱含みで、減速が定着しつつある。`;
    else if (r > 8 && m > 8) s += `中期・足元がそろって上向き、拡大の勢いが続いている。`;
    else s += `大きな転換は見られず、緩やかな地合いが続いている。`;
  }
  return s;
}

// ③ 先行きの示唆の文章
function analysisOutlook(a) {
  const leadNames = LEADING_CATEGORIES.filter((c) => a.byCat[c]);
  const leadPhrase = leadNames.length ? `先行性の高い${leadNames.join("／")}` : "先行指標";
  if (a.leadGood === 0 && a.leadBad === 0) {
    return `先行指標の方向感が乏しく、当面は現状の地合いが続くかどうかを見極める段階だ。`;
  }
  if (a.leadNet > 0) {
    return `${leadPhrase}が上向きに傾いており、数ヶ月先にかけて景気が底堅く推移する可能性を示唆している。`
      + `ただし物価や金利の動向次第では、この先行性が打ち消される点には留意が要る。`;
  }
  if (a.leadNet < 0) {
    return `${leadPhrase}が下を向いており、数ヶ月先にかけて減速が広がるリスクをはらむ。`
      + `遅行性のある雇用や生産が後追いで弱まるか、先行指標が下げ止まるかが今後の分岐点となる。`;
  }
  return `${leadPhrase}は強弱が拮抗しており、当面は方向感の乏しいもみ合いが続きやすい。`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// サーバーAPI（server.py）が使えるか。生成ボタンの可否判定に使う。
let API_AVAILABLE = false;
// 生成が許可されているか（公開モードでは false）
let CAN_GENERATE = false;

// サーバー設定を一度だけ確認（server.py のAPIが使えるか／公開モードか）。
// /api/config が JSON で返ったときだけ「APIあり」と判定する。
// GitHub Pages 等の静的配信では 404（HTMLページ）になり API_AVAILABLE は false のまま。
async function detectServerConfig() {
  try {
    const cfg = await fetch(`/api/config`);
    if (cfg.ok) {
      const ct = cfg.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const c = await cfg.json();
        API_AVAILABLE = true;
        CAN_GENERATE = !!c.can_generate;
      }
    }
  } catch (e) { /* 静的配信ならAPIなし */ }
}

// 指定月（省略時は最新）のAIレポートを読み込む。
// API_AVAILABLE（=server.py）なら /api/analysis、それ以外は静的ファイル data/analysis/。
async function loadAIReport(month) {
  AI_REPORT = null;
  if (API_AVAILABLE) {
    // server.py 経由
    try {
      const q = month ? `?month=${month}` : "";
      const res = await fetch(`/api/analysis${q}`);
      if (res.ok) AI_REPORT = await res.json();
      // 404 はその月が未生成 → AI_REPORT は null のまま（ボタン表示へ）
    } catch (e) { /* 通信失敗 → ルールベース */ }
    return;
  }
  // 静的配信（GitHub Pages 等）: 月別ファイル → latest
  try {
    const url = month ? `${DATA_BASE}/analysis/${month}.json` : `${DATA_BASE}/analysis/latest.json`;
    const res = await fetch(url);
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      // 静的サーバの404はHTMLを返すことがあるのでJSONか確認
      if (ct.includes("json") || ct === "") AI_REPORT = await res.json();
    }
  } catch (e) { /* レポートなし → ルールベース */ }
}

// 生成ボタンのハンドラ。POST /api/analysis/generate を叩く。
async function generateAIReport() {
  const btn = document.getElementById("ai-generate-btn");
  const note = document.getElementById("ai-generate-note");
  if (btn) { btn.disabled = true; btn.textContent = "生成中…（10〜30秒）"; }
  if (note) note.textContent = `Claudeが最安モデルで ${currentMonth} の分析を生成しています…`;
  const month = currentMonth;
  const onLatest = month === MONTHS[MONTHS.length - 1];
  try {
    const res = await fetch(`/api/analysis/generate?month=${month}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === "generated") {
      await loadAIReport(onLatest ? null : month);
      renderAnalysis();
      return;
    }
    if (res.status === 409) {
      if (note) note.textContent = "この月のレポートは既に保管されています。再読み込みします…";
      await loadAIReport(onLatest ? null : month); renderAnalysis(); return;
    }
    if (res.status === 422) {
      if (note) note.textContent = "生成できるのは直近12ヶ月のみです。";
    } else if (res.status === 400 && data.status === "no_api_key") {
      if (note) note.textContent = "ANTHROPIC_API_KEY が未設定です。.env に設定してください。";
    } else if (res.status === 501 || res.status === 405) {
      // 簡易サーバ（python -m http.server）で開いている＝POST非対応
      if (note) note.innerHTML = "このページは簡易サーバで開かれているため生成できません。" +
        "<code>python3 scripts/server.py 8000</code> で起動し直し、" +
        "<code>http://localhost:8000/web/</code> を開いてください。";
    } else {
      if (note) note.textContent = "生成に失敗しました: " + (data.message || data.reason || res.status);
    }
  } catch (e) {
    if (note) note.textContent = "サーバーに接続できません。server.py で起動してください。";
  }
  if (btn) { btn.disabled = false; btn.textContent = "AIレポートを生成"; }
}

// AI生成レポート（4観点）を描画。表示中の月のレポートがあるときに使う。
function renderAIReport(host) {
  const r = AI_REPORT.report || {};
  const meta = AI_REPORT.based_on_month
    ? `${AI_REPORT.based_on_month} 時点 / AI分析（${AI_REPORT.model || "Claude"}）`
    : `AI分析（${AI_REPORT.model || "Claude"}）`;
  const sec = (h, body) => body
    ? `<div class="analysis-section"><h3 class="analysis-h3">${h}</h3><p class="analysis-body">${escapeHtml(body)}</p></div>`
    : "";
  host.innerHTML = `
    <div class="analysis-head">
      <span class="analysis-avatar">🧭</span>
      <div>
        <div class="analysis-title">12指標の関係性レポート${r.headline ? `：${escapeHtml(r.headline)}` : ""}</div>
        <div class="analysis-meta">${meta}</div>
      </div>
    </div>
    ${sec("景気サイクルの位置", r.cycle)}
    ${sec("インフレと金融政策の向き", r.inflation)}
    ${sec("米株（S&P500）との関係", r.equity)}
    ${sec("日本の投資家への含意", r.jpy)}
    <p class="analysis-disclaimer">※AIが${AI_REPORT.month || "当該月"}時点の指標データから生成した分析であり、特定の投資を推奨するものではありません。</p>`;
}

// currentMonth が直近12ヶ月以内か（生成を許可する範囲）
function isWithinLast12() {
  const idx = MONTHS.indexOf(currentMonth);
  return idx >= 0 && idx >= MONTHS.length - 12;
}

function renderAnalysis() {
  const host = document.getElementById("analysis");
  if (!host) return;

  // 表示中の月のAIレポートがあればAI版を優先（最新月に限らず、過去月でも）
  const reportMatchesMonth = AI_REPORT && AI_REPORT.report &&
    (!AI_REPORT.month || AI_REPORT.month === currentMonth);
  if (reportMatchesMonth) {
    renderAIReport(host);
    return;
  }

  const a = buildAnalysis();
  // 直近12ヶ月以内・未生成・生成許可（公開モードでない）なら生成ボタンを出す
  const showGenerate = isWithinLast12() && API_AVAILABLE && CAN_GENERATE && !reportMatchesMonth;
  const genBlock = showGenerate ? `
    <div class="ai-generate">
      <button id="ai-generate-btn" class="ai-generate-btn" type="button">AIレポートを生成</button>
      <span class="ai-generate-hint">Claude（最安モデル）が4観点で${currentMonth}時点の関係性を分析します。生成は1回・保管後は再生成しません。</span>
      <p id="ai-generate-note" class="ai-generate-note"></p>
    </div>` : "";
  host.innerHTML = `
    <div class="analysis-head">
      <span class="analysis-avatar">📊</span>
      <div>
        <div class="analysis-title">12指標の関係性レポート</div>
        <div class="analysis-meta">${currentMonth} 時点 / 分野別に見た景況の整理</div>
      </div>
    </div>
    <div class="analysis-section">
      <h3 class="analysis-h3">現状（直近の流れ）</h3>
      <p class="analysis-body">${analysisCurrent(a)}</p>
    </div>
    <div class="analysis-section">
      <h3 class="analysis-h3">これまでの変遷</h3>
      <p class="analysis-body">${analysisHistory(a)}</p>
    </div>
    <div class="analysis-section">
      <h3 class="analysis-h3">この先の示唆</h3>
      <p class="analysis-body">${analysisOutlook(a)}</p>
    </div>
    ${genBlock}
    <p class="analysis-disclaimer">※各指標の方向と分野別の集計から機械的に生成した整理であり、特定の投資を推奨するものではありません。</p>`;

  // 生成ボタンのイベントを結線
  const genBtn = document.getElementById("ai-generate-btn");
  if (genBtn) genBtn.addEventListener("click", generateAIReport);
}

/* ---- 月ナビゲーション ---------------------------------------------------- */
function monthIndex(m) { return MONTHS.indexOf(m); }

function renderMonthNav() {
  const host = document.getElementById("month-nav");
  if (!host) return;
  const idx = monthIndex(currentMonth);
  const hasPrev = idx > 0, hasNext = idx >= 0 && idx < MONTHS.length - 1;
  host.innerHTML = `
    <button id="month-prev" class="month-btn" ${hasPrev ? "" : "disabled"} aria-label="前の月">◀</button>
    <div class="month-current">
      <span class="month-value">${currentMonth}</span>
      <span class="month-caption">この月時点の指標とシグナル</span>
    </div>
    <button id="month-next" class="month-btn" ${hasNext ? "" : "disabled"} aria-label="次の月">▶</button>
    <button id="month-latest" class="month-latest" ${hasNext ? "" : "disabled"}>最新へ</button>`;
  document.getElementById("month-prev").onclick = () => { if (hasPrev) setMonth(MONTHS[idx - 1]); };
  document.getElementById("month-next").onclick = () => { if (hasNext) setMonth(MONTHS[idx + 1]); };
  document.getElementById("month-latest").onclick = () => setMonth(MONTHS[MONTHS.length - 1]);
}

/* ---- 期間スコア推移チャート --------------------------------------------- */
// 現在の periodMode と currentMonth から、描画する月の配列を決める。
function periodMonths() {
  const endIdx = monthIndex(currentMonth);
  if (endIdx < 0) return [];
  if (periodMode === "all") return MONTHS.slice(0, endIdx + 1);
  if (periodMode === "custom") {
    const fi = monthIndex(customFrom), ti = monthIndex(customTo);
    if (fi < 0 || ti < 0) return MONTHS.slice(0, endIdx + 1);
    const [a, b] = fi <= ti ? [fi, ti] : [ti, fi];
    return MONTHS.slice(a, b + 1);
  }
  // year: 終点(currentMonth)から過去12ヶ月
  return MONTHS.slice(Math.max(0, endIdx - 11), endIdx + 1);
}

// イベント縦線・帯と、重ならないラベルを描く Chart.js プラグイン
const EVENT_LABEL_FONT = "10px sans-serif";
const EVENT_LANE_H = 14;     // ラベル1段の高さ
const EVENT_LABEL_GAP = 6;   // ラベル同士の最小水平すき間

const eventLinePlugin = {
  id: "eventLines",
  afterDatasetsDraw(chart) {
    if (!showEvents || !EVENTS.length) return;
    const { ctx, chartArea: area, scales } = chart;
    const xs = scales.x;
    const labels = chart.data.labels;
    const idxOf = (m) => labels.indexOf(m);

    ctx.save();

    // 1) まず縦線・帯（背景）を描き、ラベル情報を集める
    const labelItems = [];
    EVENTS.forEach((ev) => {
      const color = ev.color || (ev.type === "span" ? "#ff5d5d" : "#9aa3b2");
      let anchorX;
      if (ev.type === "span") {
        const fi = idxOf(ev.from), ti = idxOf(ev.to);
        const a = fi >= 0 ? fi : (idxOf(ev.to) >= 0 ? 0 : -1);
        const b = ti >= 0 ? ti : (fi >= 0 ? labels.length - 1 : -1);
        if (a < 0 || b < 0) return;
        const x1 = xs.getPixelForValue(labels[a]);
        const x2 = xs.getPixelForValue(labels[b]);
        ctx.fillStyle = color + "22";
        ctx.fillRect(x1, area.top, x2 - x1, area.bottom - area.top);
        anchorX = (x1 + x2) / 2;
      } else {
        const i = idxOf(ev.month);
        if (i < 0) return;
        anchorX = xs.getPixelForValue(labels[i]);
        ctx.beginPath();
        ctx.moveTo(anchorX, area.top); ctx.lineTo(anchorX, area.bottom);
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1; ctx.stroke();
        ctx.setLineDash([]);
      }
      labelItems.push({ x: anchorX, color, text: ev.label });
    });

    // 2) ラベルを段(lane)に振り分けて重なりを回避。
    //    ラベルはプロット領域の「上」に確保した余白(layout.padding.top)に描く。
    ctx.font = EVENT_LABEL_FONT;
    ctx.textBaseline = "top";
    labelItems.sort((a, b) => a.x - b.x);
    const placed = labelItems.map((it) => {
      const t = it.text.length > 16 ? it.text.slice(0, 15) + "…" : it.text;
      const w = ctx.measureText(t).width;
      let left = it.x - w / 2;
      left = Math.max(area.left + 1, Math.min(left, area.right - w - 1));
      return { ...it, t, w, left, right: left + w };
    });
    const laneRightEdge = [];
    placed.forEach((p) => {
      let lane = 0;
      while (lane < laneRightEdge.length && p.left < laneRightEdge[lane] + EVENT_LABEL_GAP) lane++;
      laneRightEdge[lane] = p.right;
      p.lane = lane;
    });
    const nLanes = laneRightEdge.length;
    // 最上段(lane0)を一番上に、最下段をプロット直上に置く
    placed.forEach((p) => {
      const y = area.top - 4 - (nLanes - 1 - p.lane) * EVENT_LANE_H - EVENT_LANE_H;
      // アンカー(縦線/帯中央)からラベルへ引き出し線
      ctx.beginPath();
      ctx.moveTo(p.x, area.top);
      ctx.lineTo(p.x, y + EVENT_LANE_H);
      ctx.strokeStyle = p.color + "66"; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.textAlign = "left";
      ctx.fillText(p.t, p.left, y);
    });

    ctx.restore();
  },
};

// ヘッダーで選択中の月（現在点）をチャート上に明示するプラグイン。
// 期間内に currentMonth があれば、アクセント色の実線＋下部に「現在 YYYY-MM」を描く。
const currentMonthPlugin = {
  id: "currentMonthMarker",
  afterDatasetsDraw(chart) {
    // 指定期間モードのときだけ表示（年間・全期間では現在月＝右端で自明なため不要）
    if (periodMode !== "custom") return;
    const { ctx, chartArea: area, scales } = chart;
    const labels = chart.data.labels;
    const i = labels.indexOf(currentMonth);
    if (i < 0) return; // 表示範囲外なら描かない
    const x = scales.x.getPixelForValue(labels[i]);
    const accent = cssVar("--accent");

    ctx.save();
    // 縦の実線
    ctx.beginPath();
    ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom);
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();

    // 下部のラベルピル「現在 YYYY-MM」
    ctx.font = "bold 10px sans-serif";
    ctx.textBaseline = "middle";
    const text = `現在 ${currentMonth}`;
    const tw = ctx.measureText(text).width;
    const padX = 6, h = 16;
    let left = x - (tw + padX * 2) / 2;
    left = Math.max(area.left, Math.min(left, area.right - (tw + padX * 2)));
    const top = area.bottom - h - 2;
    ctx.fillStyle = accent;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(left, top, tw + padX * 2, h, 4); ctx.fill(); }
    else { ctx.fillRect(left, top, tw + padX * 2, h); }
    ctx.fillStyle = cssVar("--bg");
    ctx.textAlign = "left";
    ctx.fillText(text, left + padX, top + h / 2);
    ctx.restore();
  },
};

// 表示中のlabels(月配列)に対して、イベントラベルが必要とする段数を見積もる。
// 実描画前に上部余白を決めるための概算（プロット幅は未確定なのでcanvas幅で代用）。
function estimateEventLanes(labels) {
  if (!EVENTS.length) return 0;
  const canvas = document.getElementById("period-chart");
  if (!canvas) return 1;
  const ctx = canvas.getContext("2d");
  ctx.save(); ctx.font = EVENT_LABEL_FONT;
  const w = canvas.clientWidth || canvas.width || 600;
  const plotLeft = 48, plotRight = w - 12;     // 左軸ぶんを概算で除外
  const n = labels.length;
  const xOf = (m) => {
    const i = labels.indexOf(m);
    if (i < 0) return null;
    return plotLeft + (i / Math.max(1, n - 1)) * (plotRight - plotLeft);
  };
  const items = [];
  EVENTS.forEach((ev) => {
    let x;
    if (ev.type === "span") {
      const a = labels.indexOf(ev.from), b = labels.indexOf(ev.to);
      if (a < 0 && b < 0) return;
      const xa = a >= 0 ? xOf(labels[a]) : plotLeft;
      const xb = b >= 0 ? xOf(labels[b]) : plotRight;
      x = (xa + xb) / 2;
    } else {
      x = xOf(ev.month);
      if (x == null) return;
    }
    const t = ev.label.length > 16 ? ev.label.slice(0, 15) + "…" : ev.label;
    const tw = ctx.measureText(t).width;
    let left = Math.max(plotLeft, Math.min(x - tw / 2, plotRight - tw));
    items.push({ left, right: left + tw });
  });
  ctx.restore();
  items.sort((p, q) => p.left - q.left);
  const laneRight = [];
  items.forEach((it) => {
    let lane = 0;
    while (lane < laneRight.length && it.left < laneRight[lane] + EVENT_LABEL_GAP) lane++;
    laneRight[lane] = it.right;
  });
  return Math.max(1, laneRight.length);
}

function renderPeriodChart() {
  const months = periodMonths();
  const labels = months;
  const scores = months.map((m) => computeSignalAt(m).score);
  const canvas = document.getElementById("period-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (periodChart) { periodChart.destroy(); periodChart = null; }

  // 点ごとに信号色で塗り分け
  const pointColors = scores.map((sc) =>
    sc >= 25 ? cssVar("--up") : sc <= -25 ? cssVar("--down") : cssVar("--accent"));

  const datasets = [{
    label: "総合スコア", yAxisID: "y",
    data: scores,
    borderColor: cssVar("--text-dim"),
    backgroundColor: "rgba(255,255,255,0.04)",
    fill: true, borderWidth: 2, tension: 0.2,
    pointRadius: months.length <= 24 ? 4 : 0,
    pointBackgroundColor: pointColors, pointBorderColor: pointColors,
  }];

  // S&P500オーバーレイ（右軸）。sp500Mode = "pct"(月次騰落率) | "level"(価格)
  const spOn = sp500Mode === "pct" || sp500Mode === "level";
  const spLabel = sp500Mode === "level" ? "S&P500 価格" : "S&P500 月次騰落率(%)";
  if (spOn) {
    datasets.push({
      label: spLabel, yAxisID: "y1",
      data: months.map((m) => (m in SP500 ? SP500[m][sp500Mode] : null)),
      borderColor: cssVar("--accent"),
      borderWidth: 1.5, tension: 0.2, pointRadius: 0, fill: false, spanGaps: true,
    });
  }

  const scales = {
    x: { ticks: { color: cssVar("--text-dim"), maxTicksLimit: 10 }, grid: { color: "rgba(255,255,255,0.04)" } },
    y: { position: "left", min: -100, max: 100, ticks: { color: cssVar("--text-dim"), stepSize: 50 },
         grid: { color: "rgba(255,255,255,0.06)" }, title: { display: true, text: "総合スコア", color: cssVar("--text-dim") } },
  };
  if (spOn) {
    scales.y1 = { position: "right", ticks: { color: cssVar("--accent") },
      grid: { drawOnChartArea: false },
      title: { display: true, text: sp500Mode === "level" ? "S&P500 指数" : "S&P500 %", color: cssVar("--accent") } };
  }

  // イベントラベルが必要とする段数を見積もり、その分だけ上部に余白を確保する
  // （ラベルがスコア線に重ならないよう、プロット領域の上にラベル帯を作る）
  const topPad = showEvents ? estimateEventLanes(labels) * EVENT_LANE_H + 6 : 4;

  periodChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: topPad } },
      plugins: { legend: { display: spOn, labels: { color: cssVar("--text-dim"), boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => {
          if (c.dataset.yAxisID !== "y1") return `スコア ${c.parsed.y > 0 ? "+" : ""}${c.parsed.y}`;
          return sp500Mode === "level"
            ? `S&P500 ${c.parsed.y.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`
            : `S&P500 ${c.parsed.y > 0 ? "+" : ""}${c.parsed.y}%`;
        } } } },
      scales,
    },
    plugins: [eventLinePlugin, currentMonthPlugin],
  });

  // 期間の見出し（始点→終点のスコア変化）
  const cap = document.getElementById("period-caption");
  if (cap && scores.length) {
    const first = scores[0], last = scores[scores.length - 1];
    const diff = last - first;
    const lbl = periodMode === "all" ? "全期間" : periodMode === "custom" ? "指定期間" : "過去12ヶ月";
    cap.innerHTML = `${lbl}（${months[0]} → ${months[months.length - 1]}）: `
      + `スコア ${first > 0 ? "+" : ""}${first} → <strong>${last > 0 ? "+" : ""}${last}</strong> `
      + `<span class="${diff >= 0 ? "dir-up" : "dir-down"}">(${diff >= 0 ? "+" : ""}${diff})</span>`;
  }
}

/* ---- 期間タブ・指定期間UI ----------------------------------------------- */
function renderPeriodControls() {
  // タブのアクティブ状態
  document.querySelectorAll(".period-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.mode === periodMode);
  });
  // 指定期間のドロップダウンは custom のときだけ表示
  const cust = document.getElementById("custom-range");
  if (cust) cust.style.display = periodMode === "custom" ? "flex" : "none";

  // 初回のみドロップダウンを構築
  const fromSel = document.getElementById("range-from");
  const toSel = document.getElementById("range-to");
  if (fromSel && fromSel.options.length === 0) {
    const opts = MONTHS.map((m) => `<option value="${m}">${m}</option>`).join("");
    fromSel.innerHTML = opts; toSel.innerHTML = opts;
    fromSel.value = customFrom; toSel.value = customTo;
    fromSel.onchange = () => { customFrom = fromSel.value; renderPeriodChart(); };
    toSel.onchange = () => { customTo = toSel.value; renderPeriodChart(); };
  }
}

/* ---- 中央の再描画 ------------------------------------------------------- */
function setMonth(m) {
  currentMonth = m;
  rerender();
  // 選択月のAIレポートを非同期で読み込み、来たら分析セクションだけ再描画
  refreshAIReportForMonth(m);
}

// 選択月のAIレポートを読み込んで分析セクションを更新する。
async function refreshAIReportForMonth(month) {
  const onLatest = month === MONTHS[MONTHS.length - 1];
  await loadAIReport(onLatest ? null : month);
  // 読み込み中に別の月へ切り替わっていなければ再描画
  if (month === currentMonth) renderAnalysis();
}

function rerender() {
  const inds = indicatorsAt(currentMonth);
  renderMonthNav();
  renderSignal(computeSignal(inds));
  renderAnalysis();
  renderPeriodControls();
  renderPeriodChart();

  const grid = document.getElementById("cards");
  grid.innerHTML = "";
  inds.sort((a, b) => a.no - b.no).forEach((ind) => grid.appendChild(buildCard(ind)));
}

async function init() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // 指標の解説モーダル
  const guideModal = document.getElementById("guide-modal");
  document.getElementById("guide-open")?.addEventListener("click", () => {
    renderGuide();
    guideModal.classList.remove("hidden");
  });
  document.getElementById("guide-close")?.addEventListener("click", () => guideModal.classList.add("hidden"));
  guideModal?.addEventListener("click", (e) => { if (e.target.id === "guide-modal") guideModal.classList.add("hidden"); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") guideModal?.classList.add("hidden"); });

  try {
    const res = await fetch(`${DATA_BASE}/manifest.json`);
    if (!res.ok) throw new Error(res.status);
    MANIFEST = await res.json();
  } catch (e) {
    document.getElementById("status-message").innerHTML =
      "<strong>データを読み込めませんでした。</strong> 時間をおいて再読み込みしてください。";
    return;
  }

  const meta = MANIFEST.meta || {};
  if (meta.title) document.getElementById("title").textContent = meta.title;
  document.getElementById("subtitle").textContent = meta.subtitle || "";
  document.getElementById("source-note").textContent = meta.source_note || "";
  document.getElementById("generated-at").textContent =
    "データ取得: " + (MANIFEST.generated_at ? new Date(MANIFEST.generated_at).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo"}) + " JST" : "不明");
  const age = Date.now() - new Date(MANIFEST.generated_at).getTime();
  document.getElementById("status-message").textContent = `${age > 48*3600000 ? "データの更新が遅れています。 " : ""}毎日10:15 JSTに取得を試行。指標の観測日は公表頻度によって異なります。過去月も改定後の値を含みます。`;
  const badge = document.getElementById("mode-badge");
  if (MANIFEST.mode === "sample") {
    badge.textContent = "サンプルデータ";
    badge.classList.add("sample");
  } else {
    badge.textContent = "FRED";
  }

  // 全指標の完全な時系列を並行ロード（月切替・期間チャートの土台）
  const monthSet = new Set();
  await Promise.all(MANIFEST.indicators.map(async (ind) => {
    if (ind.status !== "ok") return;
    try {
      const res = await fetch(`${DATA_BASE}/${ind.key}.json`);
      const payload = await res.json();
      if (!res.ok || !Array.isArray(payload.series)) throw Error("invalid series");
      SERIES[ind.key] = payload.series;
      payload.series.forEach((p) => monthSet.add(monthKey(p.date)));
    } catch (e) {
      ind.status = "error"; ind.summary = null; console.error(`系列読込失敗: ${ind.key}`);
    }
  }));

  // S&P500月次騰落率とイベント定義をロード（オーバーレイ用・任意）
  try {
    const sp = await (await fetch(`${DATA_BASE}/sp500_monthly.json`)).json();
    sp.series.forEach((p) => { SP500[p.month] = { pct: p.pct, level: p.level }; });
  } catch (e) { console.warn("S&P500データなし", e); }
  try {
    const ev = await (await fetch(`/config/events.json`)).json();
    EVENTS = ev.events || [];
  } catch (e) { console.warn("イベント定義なし", e); }
  await detectServerConfig();
  await loadAIReport();   // 既定は最新月

  MONTHS = [...monthSet].sort();
  if (!MONTHS.length) {
    document.getElementById("status-message").textContent =
      "時系列データを読み込めませんでした。時間をおいて再読み込みしてください。";
    return;
  }
  currentMonth = MONTHS[MONTHS.length - 1];     // 既定は最新月
  customTo = currentMonth;
  customFrom = MONTHS[Math.max(0, MONTHS.length - 12)];

  // 期間タブのイベント
  document.querySelectorAll(".period-tab").forEach((tab) => {
    tab.onclick = () => { periodMode = tab.dataset.mode; renderPeriodControls(); renderPeriodChart(); };
  });
  // S&P500オーバーレイの3択ラジオ（off/pct/level）
  document.querySelectorAll("input[name='sp500-mode']").forEach((r) => {
    r.checked = (r.value === sp500Mode);
    r.onchange = () => { if (r.checked) { sp500Mode = r.value; renderPeriodChart(); } };
  });
  // イベント表示トグル
  const evToggle = document.getElementById("toggle-events");
  if (evToggle) { evToggle.checked = showEvents; evToggle.onchange = () => { showEvents = evToggle.checked; renderPeriodChart(); }; }

  rerender();
}

init();

let modalOrigin = null;
for (const modal of document.querySelectorAll('.modal')) {
  new MutationObserver(() => {
    if (!modal.classList.contains('hidden')) {modalOrigin=document.activeElement;modal.querySelector('button')?.focus();}
    else if(modalOrigin) {modalOrigin.focus();modalOrigin=null;}
  }).observe(modal,{attributes:true,attributeFilter:['class']});
  modal.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const items=[...modal.querySelectorAll('button,a[href],select,input')].filter(x=>!x.disabled);const first=items[0],last=items.at(-1);if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}});
}
