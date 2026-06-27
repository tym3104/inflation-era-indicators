#!/usr/bin/env python3
"""
12指標の最新状況を Claude に渡し、日本の投資家視点の分析レポートを生成して
data/analysis/<YYYY-MM>.json に月別保存する。

特徴:
- 利用可能なモデルのうち「一番コストが軽いモデル」を Models API から自動選択。
- その月のレポートが既に存在する場合は再生成しない（API再課金を防ぐ）。
- data/analysis/latest.json に最新月のコピーを置き、Webが既定で読む。

呼び出し方:
    fetch_data.py 内から自動、server.py のボタン経由、または単体実行:
        python scripts/generate_analysis.py
    強制再生成:
        python scripts/generate_analysis.py --force

前提:
    .env か環境変数に ANTHROPIC_API_KEY。未設定なら何もしない。
    pip install anthropic
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ANALYSIS_DIR = DATA_DIR / "analysis"

# 既知モデルの入力単価（$/1M tokens）。安い順に並べ、Models APIで
# 「実際に利用可能」なものと突き合わせて最安を選ぶ。新しい安価モデルが
# 出たらここに1行足すだけで自動追従できる。
KNOWN_INPUT_PRICE = {
    "claude-haiku-4-5": 1.0,
    "claude-haiku-4-5-20251001": 1.0,
    "claude-sonnet-4-6": 3.0,
    "claude-sonnet-4-5": 3.0,
    "claude-opus-4-8": 5.0,
    "claude-opus-4-7": 5.0,
    "claude-opus-4-6": 5.0,
    "claude-opus-4-5": 5.0,
    "claude-fable-5": 10.0,
}
# adaptive thinking 非対応のモデル（Haikuなど）には thinking/effort を付けない
ADAPTIVE_THINKING_MODELS = {
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-4-6", "claude-fable-5",
}


def load_env():
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def has_api_key():
    k = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return bool(k) and not k.startswith("ここに")


def target_month(manifest):
    """レポート対象の年月（=画面の最新月）。
    画面側 MONTHS は全指標の観測月の和集合の最大なので、ここでも
    全指標の時系列を走査して「最も新しい観測月」を返す（ICSA等の速報含む）。"""
    latest = ""
    for ind in manifest.get("indicators", []):
        # まず時系列ファイルの最終観測月
        fpath = DATA_DIR / f"{ind['key']}.json"
        if fpath.exists():
            try:
                series = json.load(open(fpath, encoding="utf-8")).get("series", [])
                if series:
                    m = series[-1]["date"][:7]
                    if m > latest:
                        latest = m
                    continue
            except Exception:
                pass
        # フォールバック: manifest の summary
        s = ind.get("summary")
        if s and s.get("latest_date"):
            m = s["latest_date"][:7]
            if m > latest:
                latest = m
    return latest or datetime.today().strftime("%Y-%m")


def pick_cheapest_model(client):
    """Models APIで利用可能なモデルを取得し、既知価格表で最安を選ぶ。"""
    try:
        available = {m.id for m in client.models.list()}
    except Exception as e:
        print(f"[analysis] モデル一覧取得失敗（既定Haikuにフォールバック）: {e}", file=sys.stderr)
        return "claude-haiku-4-5"
    # 価格表に載っていて、かつ利用可能なものを安い順に
    candidates = sorted(
        ((mid, price) for mid, price in KNOWN_INPUT_PRICE.items() if mid in available),
        key=lambda x: x[1],
    )
    if candidates:
        return candidates[0][0]
    # 価格表に一致が無ければ、idに 'haiku' を含む最初のもの、無ければ任意
    haiku = [mid for mid in available if "haiku" in mid]
    return haiku[0] if haiku else (next(iter(available)) if available else "claude-haiku-4-5")


def model_family(model_id):
    """日付サフィックスを落としたファミリーキー（価格表・対応表の照合用）。"""
    for fam in ADAPTIVE_THINKING_MODELS:
        if model_id.startswith(fam):
            return fam
    return model_id


def value_at_month(key, month):
    """指標 key の、month（YYYY-MM）以前で最も新しい観測と前回値を時系列から引く。
    戻り値: その月時点の summary 相当 dict、無ければ None。"""
    fpath = DATA_DIR / f"{key}.json"
    if not fpath.exists():
        return None
    series = json.load(open(fpath, encoding="utf-8")).get("series", [])
    idx = -1
    for i, p in enumerate(series):
        if p["date"][:7] <= month:
            idx = i
        else:
            break
    if idx < 0:
        return None
    cur = series[idx]
    prev = series[idx - 1] if idx > 0 else None
    change = round(cur["value"] - prev["value"], 3) if prev else None
    direction = "flat"
    if change is not None:
        direction = "up" if change > 0 else "down" if change < 0 else "flat"
    return {"latest_value": cur["value"], "latest_date": cur["date"],
            "prev_value": prev["value"] if prev else None,
            "change": change, "direction": direction}


def build_indicator_summary(manifest, month=None):
    """month 指定時はその月時点の値で、未指定なら manifest の最新値で組む。"""
    lines = []
    for ind in sorted(manifest["indicators"], key=lambda x: x["no"]):
        # 月指定があり、自動取得指標なら時系列からその月時点の値を引く
        s = ind.get("summary")
        if month and ind.get("status") == "ok":
            v = value_at_month(ind["key"], month)
            if v:
                s = v
        if not s:
            lines.append(f"- No.{ind['no']} {ind['name_ja']}（{ind.get('category','')}）: データなし")
            continue
        good = ind.get("good_direction")
        dirj = {"up": "上昇", "down": "低下", "flat": "横ばい"}.get(s.get("direction"), "—")
        good_dir = "良い方向に動いている" if (good and s.get("direction") == good) else \
                   "悪い方向に動いている" if good and s.get("direction") in ("up", "down") else "中立"
        lines.append(
            f"- No.{ind['no']} {ind['name_ja']}（分野:{ind.get('category','')}/単位:{ind.get('unit','')}）: "
            f"値 {s.get('latest_value')}（{s.get('latest_date')}）、"
            f"前回比 {s.get('change')}、方向={dirj}、判定={good_dir}"
        )
    # S&P500 も対象月以前で最新の月次を使う
    sp_path = DATA_DIR / "sp500_monthly.json"
    if sp_path.exists():
        sp = json.load(open(sp_path, encoding="utf-8")).get("series", [])
        if month:
            sp = [p for p in sp if p["month"] <= month]
        if sp:
            last = sp[-1]
            lines.append(f"- 参考: S&P500 月次騰落率 {last['pct']}%（{last['month']}、終値 {last['level']}）")
    return "\n".join(lines)


def build_prompt(manifest, month):
    indicators_text = build_indicator_summary(manifest, month=month)
    return f"""あなたは米国経済指標に精通したマクロアナリストです。日本在住の個人投資家に向けて、
エミン・ユルマズ『世界インフレ時代の経済指標』第2章の「米国の12の経済指標」の{month}時点の状況をもとに、
フラットで中立的な分析レポートを書いてください。特定銘柄の売買推奨はしないでください。
※これは {month} 時点の指標値に基づく分析です（最新ではなくその月の状況として書いてください）。

# {month} 時点の指標スナップショット
{indicators_text}

# 出力要件
以下の4つの観点を含め、必ず指定のJSON形式で出力してください。各観点は日本語で2〜4文、
具体的な指標名や分野に言及しつつ、指標どうしの関係性（先行/遅行、整合/不整合）を読み解いてください。

1. cycle: 景気サイクルの位置。先行指標（住宅・受注・新規失業保険・景況感・センチメント）と
   一致指標（雇用・生産・小売・GDP）の関係から、今が拡大/減速/後退/回復のどこかを論じる。
2. inflation: インフレと金融政策の向き。CPIと雇用の組み合わせからFRBが利上げ/利下げ
   どちらに傾きやすいかを論じる。
3. equity: 米株（S&P500）との関係。指標の総合的な強弱と株価の整合・乖離に触れる。
4. jpy: 日本の投資家への含意。金利・景気・インフレからドル円や円換算リターン、
   円資産との向き合い方の観点を中立的に述べる。

最後に headline として、全体を一言で表す中立的な見出し（20字程度）を付けてください。

# 出力JSON形式（この形式のみを出力。前後に説明文を付けない）
{{"headline": "...", "cycle": "...", "inflation": "...", "equity": "...", "jpy": "..."}}
"""


SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "cycle": {"type": "string"},
        "inflation": {"type": "string"},
        "equity": {"type": "string"},
        "jpy": {"type": "string"},
    },
    "required": ["headline", "cycle", "inflation", "equity", "jpy"],
    "additionalProperties": False,
}


def allowed_months(manifest, n=12):
    """生成を許可する月（最新月から過去n-1ヶ月ぶん）のリストを返す。"""
    latest = target_month(manifest)  # "YYYY-MM"
    y, m = int(latest[:4]), int(latest[5:7])
    months = []
    for _ in range(n):
        months.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m = 12; y -= 1
    return months


def generate(force=False, month=None):
    """レポートを生成して保存。month指定時はその月時点の値で分析。
    戻り値は {'status': ..., 'month': ..., ...} の辞書。"""
    load_env()
    if not has_api_key():
        return {"status": "skipped", "reason": "no_api_key"}

    manifest_path = DATA_DIR / "manifest.json"
    if not manifest_path.exists():
        return {"status": "error", "reason": "no_manifest"}
    manifest = json.load(open(manifest_path, encoding="utf-8"))

    allowed = allowed_months(manifest, 12)
    if month is None:
        month = allowed[0]  # 既定は最新月
    elif month not in allowed:
        return {"status": "out_of_range", "month": month,
                "reason": "生成できるのは直近12ヶ月のみです。"}

    latest = allowed[0]
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    month_path = ANALYSIS_DIR / f"{month}.json"

    # 既に保管済みなら再生成しない（force時のみ上書き）
    if month_path.exists() and not force:
        return {"status": "exists", "month": month, "path": str(month_path)}

    try:
        import anthropic
    except ImportError:
        return {"status": "error", "reason": "anthropic_not_installed"}

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"].strip())
    model = pick_cheapest_model(client)
    prompt = build_prompt(manifest, month)

    kwargs = dict(
        model=model,
        max_tokens=2000,
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": prompt}],
    )
    # adaptive thinking 対応モデルだけ thinking を付ける（Haiku等は付けない）
    if model_family(model) in ADAPTIVE_THINKING_MODELS:
        kwargs["thinking"] = {"type": "adaptive"}

    print(f"[analysis] {model}（最安モデル）で {month} のレポート生成中...")
    try:
        resp = client.messages.create(**kwargs)
    except Exception as e:
        return {"status": "error", "reason": f"api_error: {e}"}

    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        return {"status": "error", "reason": "empty_response"}
    try:
        report = json.loads(text)
    except json.JSONDecodeError as e:
        return {"status": "error", "reason": f"json_parse: {e}"}

    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "month": month,
        "based_on_month": month + "-01",
        "model": model,
        "report": report,
    }
    with open(month_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    # 生成したのが最新月のときだけ latest.json を更新（Webが既定で読む）
    if month == latest:
        with open(ANALYSIS_DIR / "latest.json", "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
    # 月別インデックス
    months = sorted(p.stem for p in ANALYSIS_DIR.glob("*.json") if p.stem not in ("latest", "index"))
    with open(ANALYSIS_DIR / "index.json", "w", encoding="utf-8") as f:
        json.dump({"months": months}, f, ensure_ascii=False, indent=2)

    return {"status": "generated", "month": month, "model": model,
            "headline": report.get("headline", ""), "path": str(month_path)}


def main():
    force = "--force" in sys.argv
    # --month YYYY-MM で対象月を指定可能
    month = None
    if "--month" in sys.argv:
        i = sys.argv.index("--month")
        if i + 1 < len(sys.argv):
            month = sys.argv[i + 1]
    result = generate(force=force, month=month)
    st = result["status"]
    if st == "skipped":
        print("[analysis] ANTHROPIC_API_KEY 未設定のためスキップ（ルールベースにフォールバック）")
    elif st == "exists":
        print(f"[analysis] {result['month']} は生成済み（再生成しません）。--force で上書き可")
    elif st == "out_of_range":
        print(f"[analysis] {result['month']} は生成対象外（直近12ヶ月のみ）", file=sys.stderr)
    elif st == "generated":
        print(f"[analysis] 生成完了: {result['path']}  モデル {result['model']}  見出し「{result['headline']}」")
    else:
        print(f"[analysis] 失敗: {result.get('reason')}", file=sys.stderr)
    return result


if __name__ == "__main__":
    main()
