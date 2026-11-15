/* 「AIで分析」— 利用者自身のAPIキー（Anthropic / OpenAI）で、選択月の12指標の関係性をLLMに読ませる。
 * ・キーはブラウザ内だけ（既定 sessionStorage、任意で localStorage）。送信先は選んだプロバイダのAPIのみ。
 *   AwaIのサーバーは経由せず、キーをログ・画面出力・外部保存しない。
 * ・モデル一覧はプロバイダの Models API からその都度取得（新しい順、24時間キャッシュ）。取得できない場合のみ予備リスト。
 * ・ルールベースの整理（app.js）は常に残し、AIの結果は「AI生成」と明示して別枠に表示する。
 * ・ローカル版の scripts/generate_analysis.py（Claudeで月次レポートを作る個人用機能）の考え方を公開版向けに移植したもの。
 */
(function (root) {
  "use strict";
  const PROVIDERS = {
    anthropic: {
      label: "Anthropic（Claude）",
      keyHint: "sk-ant-...",
      modelsUrl: "https://api.anthropic.com/v1/models?limit=1000",
      chatUrl: "https://api.anthropic.com/v1/messages",
      fallback: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"],
    },
    openai: {
      label: "OpenAI（GPT）",
      keyHint: "sk-...",
      modelsUrl: "https://api.openai.com/v1/models",
      chatUrl: "https://api.openai.com/v1/chat/completions",
      fallback: ["gpt-5", "gpt-5-mini"],
    },
  };
  const CFG_KEY = "econ-ai-config-v1";        // provider / model / remember（キーは remember 時のみ）
  const KEY_SESSION = "econ-ai-key-v1";        // 既定のキー保存先（このタブのみ）
  const MODELS_CACHE = "econ-ai-models-v1";    // モデル一覧キャッシュ（キーは含めない）
  const MODELS_TTL = 24 * 3600 * 1000;

  const state = { provider: "anthropic", model: "", remember: false, keys: { anthropic: "", openai: "" },
    models: { anthropic: null, openai: null }, modelsNote: "", busy: false, results: {}, error: "" };

  function store(kind) { try { return root[kind] || null; } catch (e) { return null; } }

  function loadConfig() {
    const ls = store("localStorage"), ss = store("sessionStorage");
    try {
      const o = ls && JSON.parse(ls.getItem(CFG_KEY) || "null");
      if (o) {
        if (PROVIDERS[o.provider]) state.provider = o.provider;
        state.model = typeof o.model === "string" ? o.model : "";
        state.remember = !!o.remember;
        if (state.remember && o.keys) for (const p of Object.keys(PROVIDERS)) state.keys[p] = String(o.keys[p] || "");
      }
      const s = ss && JSON.parse(ss.getItem(KEY_SESSION) || "null");
      if (s) for (const p of Object.keys(PROVIDERS)) if (!state.keys[p] && s[p]) state.keys[p] = String(s[p]);
    } catch (e) { /* 壊れた保存値は無視 */ }
  }

  function saveConfig() {
    const ls = store("localStorage"), ss = store("sessionStorage");
    try {
      if (ls) ls.setItem(CFG_KEY, JSON.stringify({ provider: state.provider, model: state.model, remember: state.remember,
        keys: state.remember ? state.keys : {} }));
      if (ss) {
        if (!state.remember && (state.keys.anthropic || state.keys.openai)) ss.setItem(KEY_SESSION, JSON.stringify(state.keys));
        else ss.removeItem(KEY_SESSION);
      }
    } catch (e) { /* 保存できない環境ではメモリ上のみ */ }
  }

  function forgetKeys() {
    state.keys = { anthropic: "", openai: "" }; state.remember = false;
    try { store("sessionStorage")?.removeItem(KEY_SESSION); } catch (e) {}
    saveConfig();
  }

  // ---- モデル一覧（ライブ取得） -------------------------------------------
  const OPENAI_EXCLUDE = /(embed|whisper|tts|audio|realtime|transcribe|dall-e|image|moderation|search|davinci|babbage|instruct|codex|computer-use|sora|-vision)/i;
  function normalizeModels(provider, payload) {
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    if (provider === "anthropic") {
      return list.filter((m) => m && typeof m.id === "string")
        .map((m) => ({ id: m.id, name: m.display_name || m.id, t: Date.parse(m.created_at) || 0 }))
        .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
    }
    return list.filter((m) => m && typeof m.id === "string" && /^(gpt-|o\d|chatgpt-)/i.test(m.id) && !OPENAI_EXCLUDE.test(m.id))
      .map((m) => ({ id: m.id, name: m.id, t: (Number(m.created) || 0) * 1000 }))
      .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
  }

  function authHeaders(provider, key) {
    return provider === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }
      : { authorization: "Bearer " + key };
  }

  function readModelsCache(provider) {
    try {
      const all = JSON.parse(store("localStorage")?.getItem(MODELS_CACHE) || "{}");
      const c = all[provider];
      if (c && Array.isArray(c.models) && Date.now() - c.at < MODELS_TTL) return c;
    } catch (e) {}
    return null;
  }
  function writeModelsCache(provider, models) {
    try {
      const ls = store("localStorage"); if (!ls) return;
      const all = JSON.parse(ls.getItem(MODELS_CACHE) || "{}");
      all[provider] = { at: Date.now(), models };
      ls.setItem(MODELS_CACHE, JSON.stringify(all));
    } catch (e) {}
  }

  async function fetchModels(provider, key, { force = false, fetchImpl = root.fetch } = {}) {
    const p = PROVIDERS[provider];
    if (!force) { const c = readModelsCache(provider); if (c) return { models: c.models, source: "cache", at: c.at }; }
    if (!key) return { models: p.fallback.map((id) => ({ id, name: id })), source: "fallback", reason: "APIキーを入れると、最新のモデル一覧を取得します。" };
    try {
      const res = await fetchImpl(p.modelsUrl, { headers: authHeaders(provider, key) });
      if (!res.ok) throw new Error(res.status === 401 ? "APIキーが認証されませんでした（401）" : `HTTP ${res.status}`);
      const models = normalizeModels(provider, await res.json());
      if (!models.length) throw new Error("利用できるモデルが見つかりません");
      writeModelsCache(provider, models);
      return { models, source: "live", at: Date.now() };
    } catch (e) {
      return { models: p.fallback.map((id) => ({ id, name: id })), source: "fallback",
        reason: `最新のモデル一覧を取得できませんでした（${safeMessage(e)}）。予備の一覧を表示しています。` };
    }
  }

  // エラー文からキーらしき文字列を必ず取り除く
  function safeMessage(e) {
    return String((e && e.message) || e || "不明なエラー").replace(/sk-[A-Za-z0-9_\-]{6,}/g, "[key]").slice(0, 160);
  }

  // ---- プロンプト ---------------------------------------------------------
  const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
  function buildPayload(ctx) {
    const { month, indicators, series, scores, ruleCategories } = ctx;
    const rows = indicators.slice().sort((a, b) => a.no - b.no).map((ind) => {
      const s = ind.summary || null;
      const hist = (series[ind.key] || []).filter((p) => p.date.slice(0, 7) <= month).slice(-7).map((p) => [p.date.slice(0, 7), r3(p.value)]);
      return {
        no: ind.no, name: ind.name_ja, category: ind.category || "", unit: ind.unit || "", measure: ind.transform_label || "",
        frequency: ind.frequency || "", improving_direction: ind.good_direction || null,
        value: s ? r3(s.latest_value) : null, observed: s ? s.latest_date : null,
        previous: s ? r3(s.prev_value) : null, change: s ? r3(s.change) : null, direction: s ? s.direction : "no_data",
        recent: hist,
      };
    });
    return { month, indicators: rows, direction_score: scores, rule_based_categories: ruleCategories };
  }

  function buildPrompt(ctx) {
    const data = buildPayload(ctx);
    const system = "あなたは米国の経済統計を中立に読み解くエコノミストです。与えられたデータだけを根拠に、日本語で簡潔に書きます。" +
      "投資助言・売買推奨・特定銘柄や資産への言及・断定的な将来予測はしません。データに無い数値やニュースを作りません。";
    const user = `次のJSONは、米国の12の経済指標の ${data.month} 時点の値です（FRED、改定後の系列で再計算。観測日は指標ごとに異なる）。
change は変換後の値どうしの差、improving_direction は改善とみなす方向、recent は直近の推移、direction_score は独自の方向スコア（-100〜+100、景気判定ではない）です。

${JSON.stringify(data)}

12指標どうしの関係性（先行と一致、雇用と物価、消費と生産、住宅と受注などの整合・不整合）を読み解き、次の3観点で整理してください。
- current: 現状（直近の流れ）
- history: これまでの変遷（recent と direction_score の推移から）
- outlook: この先の示唆（先行性のある指標から言える範囲。確率的・条件付きの表現で）
各観点は1〜3項目。各項目の text は1〜2文で、主張の根拠にした指標の no（1〜12）を indicators に必ず列挙してください。
データが欠けている指標には触れないか、欠けていると明記してください。

次のJSONだけを出力してください（前後に文章やコードブロックを付けない）:
{"headline":"20字程度の中立な見出し","current":[{"text":"...","indicators":[1,12]}],"history":[{"text":"...","indicators":[]}],"outlook":[{"text":"...","indicators":[]}],"caveat":"データ上の注意を1文"}`;
    return { system, user };
  }

  // ---- 応答の検証 ---------------------------------------------------------
  function parseReport(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("AIの応答を読み取れませんでした");
    const o = JSON.parse(t.slice(a, b + 1));
    const items = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 4).map((x) => ({
      text: String((x && x.text) || "").slice(0, 600),
      indicators: [...new Set((Array.isArray(x && x.indicators) ? x.indicators : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12))],
    })).filter((x) => x.text);
    const report = { headline: String(o.headline || "").slice(0, 80), current: items(o.current), history: items(o.history),
      outlook: items(o.outlook), caveat: String(o.caveat || "").slice(0, 300) };
    if (!report.current.length && !report.history.length && !report.outlook.length) throw new Error("AIの応答に分析が含まれていませんでした");
    return report;
  }

  async function callModel(provider, key, model, prompt, fetchImpl = root.fetch) {
    const p = PROVIDERS[provider];
    let body;
    if (provider === "anthropic") {
      body = { model, max_tokens: 2000, system: prompt.system, messages: [{ role: "user", content: prompt.user }] };
    } else {
      body = { model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], response_format: { type: "json_object" } };
    }
    const res = await fetchImpl(p.chatUrl, { method: "POST", headers: { "content-type": "application/json", ...authHeaders(provider, key) }, body: JSON.stringify(body) });
    let data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = data && data.error && (data.error.message || data.error.type);
      throw new Error(res.status === 401 ? "APIキーが認証されませんでした（401）" : `HTTP ${res.status}${msg ? "：" + msg : ""}`);
    }
    const text = provider === "anthropic"
      ? (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
      : (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    return parseReport(text);
  }

  // ---- 画面 ---------------------------------------------------------------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function context() {
    const month = root.__econ.currentMonth();
    const inds = root.__econ.indicatorsAt(month);
    const months = root.__econ.months();
    const idx = months.indexOf(month);
    const at = (n) => (idx - n >= 0 ? root.__econ.scoreAt(months[idx - n]) : null);
    const a = root.__econ.ruleAnalysis();
    return { month, indicators: inds, series: root.__econ.series(),
      scores: { now: at(0), "3_months_ago": at(3), "12_months_ago": at(12) },
      ruleCategories: { strong: a.strongCats, weak: a.weakCats, mixed: a.mixedCats } };
  }

  function nameOf(no) {
    const ind = (root.__econ.manifest().indicators || []).find((i) => i.no === no);
    return ind ? ind.name_ja.replace(/（.*?）/g, "") : `No.${no}`;
  }

  function resultHtml(month) {
    const r = state.results[month];
    if (!r) return `<p class="ai-empty">${esc(month)} 時点の12指標を、選んだモデルで分析します。結果はこの画面にだけ表示し、保存しません。</p>`;
    const sec = (title, list) => list.length ? `<div class="analysis-section"><h3 class="analysis-h3">${title}</h3><ul class="ai-points">${list.map((x) =>
      `<li><p class="analysis-body">${esc(x.text)}</p>${x.indicators.length ? `<p class="ai-cite">根拠：${x.indicators.map((n) => `<span class="ai-chip">No.${n} ${esc(nameOf(n))}</span>`).join("")}</p>` : `<p class="ai-cite">根拠の指標の指定なし</p>`}</li>`).join("")}</ul></div>` : "";
    return `<div class="ai-result" aria-live="polite">
      <div class="analysis-head"><span class="analysis-avatar" aria-hidden="true">🧭</span><div>
        <div class="analysis-title"><span class="ai-badge">AI生成</span>${esc(r.report.headline || "12指標の関係性（AI分析）")}</div>
        <div class="analysis-meta">${esc(month)} 時点 / ${esc(PROVIDERS[r.provider].label)} ・ ${esc(r.model)} / ${esc(r.at)}</div></div></div>
      ${sec("現状（直近の流れ）", r.report.current)}${sec("これまでの変遷", r.report.history)}${sec("この先の示唆", r.report.outlook)}
      ${r.report.caveat ? `<p class="ai-caveat">${esc(r.report.caveat)}</p>` : ""}
      <p class="analysis-disclaimer">※AIが${esc(month)}時点の指標データから自動生成した文章です。誤りを含むことがあり、投資助言や売買の推奨ではありません。数値は各指標カードと出典でご確認ください。</p></div>`;
  }

  function settingsHtml() {
    const p = state.provider, models = state.models[p] || PROVIDERS[p].fallback.map((id) => ({ id, name: id }));
    const opts = models.map((m) => `<option value="${esc(m.id)}"${m.id === state.model ? " selected" : ""}>${esc(m.name === m.id ? m.id : `${m.name}（${m.id}）`)}</option>`).join("");
    return `<details class="ai-settings"${state.keys[p] ? "" : " open"}><summary>LLM設定（ご自身のAPIキー）</summary>
      <div class="ai-grid">
        <label class="ai-field"><span>プロバイダ</span><select id="ai-provider">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}"${k === p ? " selected" : ""}>${v.label}</option>`).join("")}</select></label>
        <label class="ai-field"><span>APIキー</span><input id="ai-key" type="password" autocomplete="off" spellcheck="false" placeholder="${PROVIDERS[p].keyHint}" value="${esc(state.keys[p])}"></label>
        <label class="ai-field ai-model"><span>モデル（新しい順）</span><span class="ai-row"><select id="ai-model">${opts}</select><button id="ai-refresh-models" type="button" class="ai-secondary">最新のモデルを取得</button></span></label>
        <label class="ai-check"><input id="ai-remember" type="checkbox"${state.remember ? " checked" : ""}> この端末のブラウザに保存する（既定はこのタブを閉じると消えます）</label>
      </div>
      <p class="ai-note" id="ai-models-note">${esc(state.modelsNote)}</p>
      <p class="ai-privacy">キーと指標データは、ブラウザから選んだプロバイダ（${PROVIDERS[p].label}）へ直接送信されます。AwaIのサーバーは経由せず、キーを記録しません。利用料金はご自身のAPIアカウントに発生します。 <button id="ai-forget" type="button" class="ai-link">保存したキーを消す</button></p>
    </details>`;
  }

  function render() {
    const host = root.document && root.document.getElementById("ai-analysis");
    if (!host || !root.__econ || !root.__econ.currentMonth()) return;
    const month = root.__econ.currentMonth();
    const p = state.provider, hasKey = !!state.keys[p];
    host.innerHTML = `<div class="analysis ai-panel">
      <div class="ai-panel-head"><h3 class="ai-panel-title">AIで分析<span class="ai-badge">β</span></h3><p class="ai-panel-sub">上のルールベースの整理はそのまま残し、LLMに12指標の数値と変化を渡して関係性を読ませます。</p></div>
      ${settingsHtml()}
      <div class="ai-actions"><button id="ai-run" type="button" class="ai-generate-btn"${hasKey && !state.busy ? "" : " disabled"}>${state.busy ? "分析中…" : `${esc(month)} をAIで分析`}</button>
        <span class="ai-generate-hint">${hasKey ? "1回の分析で数千トークン程度を使います。" : "APIキーを入れると分析できます。"}</span></div>
      ${state.error ? `<p class="ai-error" role="alert">${esc(state.error)}</p>` : ""}
      ${resultHtml(month)}</div>`;
    bind(host);
  }

  async function refreshModels(force) {
    const p = state.provider;
    const r = await fetchModels(p, state.keys[p], { force });
    state.models[p] = r.models;
    state.modelsNote = r.source === "live" ? `${PROVIDERS[p].label} から最新のモデル一覧を取得しました（${r.models.length}件）。`
      : r.source === "cache" ? `取得済みのモデル一覧を表示しています（${new Date(r.at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} JST 取得、24時間ごとに更新）。`
      : r.reason;
    if (!r.models.some((m) => m.id === state.model)) state.model = r.models[0] ? r.models[0].id : "";
    saveConfig(); render();
  }

  function bind(host) {
    const $ = (id) => host.querySelector("#" + id);
    $("ai-provider").onchange = (e) => { state.provider = e.target.value; state.model = ""; state.error = ""; saveConfig(); refreshModels(false); };
    let keyAtFocus = state.keys[state.provider];
    $("ai-key").onfocus = () => { keyAtFocus = state.keys[state.provider]; };
    $("ai-key").oninput = (e) => { state.keys[state.provider] = e.target.value.trim(); $("ai-run").disabled = !state.keys[state.provider] || state.busy; };
    $("ai-key").onchange = () => { saveConfig(); if (state.keys[state.provider] && state.keys[state.provider] !== keyAtFocus) refreshModels(true); };
    $("ai-model").onchange = (e) => { state.model = e.target.value; saveConfig(); };
    $("ai-remember").onchange = (e) => { state.remember = e.target.checked; saveConfig(); };
    $("ai-refresh-models").onclick = () => { const k = $("ai-key").value.trim(); if (k) state.keys[state.provider] = k; refreshModels(true); };
    $("ai-forget").onclick = () => { forgetKeys(); state.modelsNote = "保存したキーを消しました。"; render(); };
    $("ai-run").onclick = run;
  }

  async function run() {
    const p = state.provider, key = state.keys[p], month = root.__econ.currentMonth();
    if (!key || state.busy) return;
    if (!state.model) state.model = (state.models[p] || PROVIDERS[p].fallback.map((id) => ({ id })))[0].id;
    state.busy = true; state.error = ""; render();
    try {
      const report = await callModel(p, key, state.model, buildPrompt(context()));
      state.results[month] = { report, provider: p, model: state.model,
        at: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST 生成" };
    } catch (e) {
      state.error = `AI分析に失敗しました：${safeMessage(e)}。ルールベースの整理は上に表示しています。`;
    } finally { state.busy = false; render(); }
  }

  function init() { loadConfig(); const c = readModelsCache(state.provider); if (c) { state.models[state.provider] = c.models; } render(); if (!c && state.keys[state.provider]) refreshModels(false); }

  root.EconAI = { PROVIDERS, normalizeModels, fetchModels, buildPayload, buildPrompt, parseReport, callModel, safeMessage, render, init, _state: state };
})(typeof window !== "undefined" ? window : globalThis);
