#!/usr/bin/env python3
"""
FRED API から「世界インフレ時代の経済指標」12指標を取得し、
web/ が読む JSON ファイル群を data/ に生成する。

使い方:
    1. https://fredaccount.stlouisfed.org/apikeys でAPIキーを無料取得
    2. プロジェクト直下の .env に  FRED_API_KEY=xxxxx  を記入
       （または環境変数 FRED_API_KEY を設定）
    3. pip install -r scripts/requirements.txt
    4. python scripts/fetch_data.py

生成物:
    data/<key>.json     ... 各指標の時系列（チャート用）
    data/manifest.json  ... 全指標の最新値・前回比・方向などのサマリ（カード用）

オプション:
    --sample   FRED にアクセスせずダミーデータで manifest/時系列を生成（疎通確認用）
"""

import argparse
import json
import os
import sys
import ssl
import time
import math
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "indicators.json"
DATA_DIR = ROOT / "data"
FRED_BASE = "https://api.stlouisfed.org/fred/series/observations"

# チャート用に取得する期間（年）
HISTORY_YEARS = 10


def make_ssl_context():
    """SSL証明書の検証コンテキストを作る。
    macOSではPythonが標準の証明書を見つけられず CERTIFICATE_VERIFY_FAILED に
    なることが多いので、certifi の証明書バンドルがあればそれを使う。"""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        # certifi 未導入でもOS既定で試す（環境によっては成功する）
        return ssl.create_default_context()


# ---------------------------------------------------------------------------
# 共通ユーティリティ
# ---------------------------------------------------------------------------
def load_env():
    """プロジェクト直下の .env を最小パースして環境変数に載せる。"""
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def fred_observations(series_id, api_key, start_date, ssl_ctx):
    """FRED から observations を取得して [(date, value), ...] を返す。"""
    params = {
        "series_id": series_id,
        "api_key": api_key,
        "file_type": "json",
        "observation_start": start_date,
        "sort_order": "asc",
    }
    url = f"{FRED_BASE}?{urlencode(params)}"
    with urlopen(url, timeout=30, context=ssl_ctx) as resp:
        payload = json.load(resp)
    out = []
    for obs in payload.get("observations", []):
        v = obs.get("value")
        if v in (".", "", None):
            continue
        try:
            out.append((obs["date"], float(v)))
        except ValueError:
            continue
    return out


# ---------------------------------------------------------------------------
# 変換ロジック（生の系列 → 表示用の系列）
# ---------------------------------------------------------------------------
def transform_series(series, transform):
    """
    series: [(date, value), ...]  (昇順)
    戻り値: [(date, display_value), ...]  表示・チャート用に変換した系列
    """
    if not series:
        return []

    if transform in ("level",):
        return list(series)

    if transform == "mom_change":
        # 前月差（水準の差）
        out = []
        for i in range(1, len(series)):
            out.append((series[i][0], series[i][1] - series[i - 1][1]))
        return out

    if transform == "mom_pct":
        out = []
        for i in range(1, len(series)):
            prev = series[i - 1][1]
            if prev == 0:
                continue
            out.append((series[i][0], (series[i][1] / prev - 1.0) * 100.0))
        return out

    if transform == "qoq_annualized":
        # 前期比年率（四半期データ前提）: ((v/prev)^4 - 1) * 100
        out = []
        for i in range(1, len(series)):
            prev = series[i - 1][1]
            if prev <= 0:
                continue
            ratio = series[i][1] / prev
            out.append((series[i][0], (ratio ** 4 - 1.0) * 100.0))
        return out

    if transform == "yoy_pct":
        # 前年同月比。月次=12、四半期=4 を日付差から推定せず素朴に探索する。
        out = []
        date_to_val = {d: v for d, v in series}
        for d, v in series:
            dt = datetime.strptime(d, "%Y-%m-%d")
            prev_key = None
            # 12か月前に最も近い観測日を探す
            target = dt.replace(year=dt.year - 1)
            best = None
            best_diff = None
            for pd, pv in series:
                pdt = datetime.strptime(pd, "%Y-%m-%d")
                diff = abs((pdt - target).days)
                if best_diff is None or diff < best_diff:
                    best_diff, best, prev_key = diff, pv, pd
            if best and best != 0 and best_diff is not None and best_diff <= 45:
                out.append((d, (v / best - 1.0) * 100.0))
        return out

    # 未知の変換はそのまま
    return list(series)


def summarize(display_series):
    """表示用系列から 最新値・前回値・前回比・方向 を計算。"""
    if not display_series:
        return None
    latest_date, latest = display_series[-1]
    prev = display_series[-2][1] if len(display_series) >= 2 else None
    change = None
    if prev is not None:
        change = latest - prev
    direction = "flat"
    if change is not None:
        if change > 0:
            direction = "up"
        elif change < 0:
            direction = "down"
    return {
        "latest_value": round(latest, 3),
        "latest_date": latest_date,
        "prev_value": round(prev, 3) if prev is not None else None,
        "change": round(change, 3) if change is not None else None,
        "direction": direction,
    }


# ---------------------------------------------------------------------------
# サンプル（ダミー）データ生成 — FREDキーなしで疎通確認するため
# ---------------------------------------------------------------------------
def sample_series(transform):
    """それっぽい月次ダミー系列を120点生成する。"""
    pts = []
    base = datetime.today().replace(day=1)
    for i in range(120):
        d = (base - timedelta(days=30 * (119 - i)))
        # ゆるやかな上昇トレンド + 季節っぽい波
        val = 100 + i * 0.6 + 5 * math.sin(i / 6.0)
        pts.append((d.strftime("%Y-%m-%d"), round(val, 2)))
    return transform_series(pts, transform)


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", action="store_true",
                        help="FREDにアクセスせずダミーデータを生成（疎通確認用）")
    args = parser.parse_args()

    load_env()
    config = load_config()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get("FRED_API_KEY", "").strip()
    if not args.sample and not api_key:
        print("ERROR: FRED_API_KEY が見つかりません。", file=sys.stderr)
        print("  .env に FRED_API_KEY=... を記入するか、--sample でダミー生成してください。",
              file=sys.stderr)
        sys.exit(1)

    ssl_ctx = make_ssl_context()
    start_date = (datetime.today() - timedelta(days=365 * HISTORY_YEARS)).strftime("%Y-%m-%d")

    manifest = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "mode": "sample" if args.sample else "fred",
        "meta": config.get("meta", {}),
        "indicators": [],
    }

    ok, failed = 0, 0
    for ind in config["indicators"]:
        key = ind["key"]
        entry = {
            "key": key,
            "no": ind["no"],
            "name_ja": ind["name_ja"],
            "name_en": ind.get("name_en"),
            "unit": ind.get("unit"),
            "frequency": ind.get("frequency"),
            "category": ind.get("category"),
            "transform_label": ind.get("transform_label"),
            "good_direction": ind.get("good_direction"),
            "threshold": ind.get("threshold"),
            "description": ind.get("description"),
            "how_to_read": ind.get("how_to_read"),
            "fallback_note": ind.get("fallback_note"),
            "status": "ok",
        }

        # --- ソース別の取得 ---
        if ind.get("source") == "manual":
            mv = ind.get("manual_value")
            entry["status"] = "manual"
            if mv is not None:
                entry["summary"] = {
                    "latest_value": mv,
                    "latest_date": ind.get("manual_date"),
                    "prev_value": ind.get("manual_prev"),
                    "change": (mv - ind["manual_prev"]) if ind.get("manual_prev") is not None else None,
                    "direction": "flat",
                }
            else:
                entry["summary"] = None
            # 時系列ファイルは作らない
            manifest["indicators"].append(entry)
            print(f"[manual ] {key:18s} 手動更新指標（自動取得対象外）")
            continue

        try:
            if args.sample:
                disp = sample_series(ind.get("transform", "level"))
            else:
                raw = fred_observations(ind["fred_id"], api_key, start_date, ssl_ctx)
                disp = transform_series(raw, ind.get("transform", "level"))
                time.sleep(0.2)  # レート制御

            if not disp:
                raise ValueError("空の系列")

            # 時系列を保存（チャート用）。点数が多い週次はカード用に間引かない（詳細チャートで使う）
            series_payload = {
                "key": key,
                "transform": ind.get("transform"),
                "transform_label": ind.get("transform_label"),
                "unit": ind.get("unit"),
                "series": [{"date": d, "value": round(v, 3)} for d, v in disp],
            }
            with open(DATA_DIR / f"{key}.json", "w", encoding="utf-8") as f:
                json.dump(series_payload, f, ensure_ascii=False)

            entry["summary"] = summarize(disp)
            # スパークライン用に末尾60点を埋め込む（カード描画を軽くする）
            entry["spark"] = [round(v, 3) for _, v in disp[-60:]]
            ok += 1
            s = entry["summary"]

            # データ鮮度チェック: 最新観測が古すぎる系列は更新停止の疑い。
            # FREDが更新を止めた系列を早期に発見するための警告（実モードのみ）。
            stale = ""
            if not args.sample:
                try:
                    latest_dt = datetime.strptime(s["latest_date"], "%Y-%m-%d")
                    days_old = (datetime.today() - latest_dt).days
                    # 四半期データは最大~120日のラグがあり得るので閾値は緩めに180日
                    if days_old > 180:
                        stale = f"  ⚠ 鮮度注意: 最新が{days_old}日前（系列の更新停止の疑い）"
                        entry["stale_days"] = days_old
                except (TypeError, ValueError):
                    pass

            print(f"[ok     ] {key:18s} 最新 {s['latest_value']} ({s['latest_date']}) "
                  f"方向={s['direction']}{stale}")
        except (HTTPError, URLError, ValueError, KeyError) as e:
            entry["status"] = "error"
            entry["error"] = str(e)
            entry["summary"] = None
            failed += 1
            print(f"[ERROR  ] {key:18s} 取得失敗: {e}", file=sys.stderr)

        manifest["indicators"].append(entry)

    # --- S&P500 の月次騰落率（総合スコアグラフのオーバーレイ用）-----------
    # FRED SP500 は日次・直近10年。各月の最終営業日の終値→前月比%を計算する。
    sp_status = "ok"
    try:
        if args.sample:
            sp_daily = [(d, v) for d, v in sample_series("level")]  # ダミー
        else:
            sp_daily = fred_observations("SP500", api_key, start_date, ssl_ctx)
        # 月末値（各月で最後の観測を採用）
        month_last = {}
        for d, v in sp_daily:
            month_last[d[:7]] = (d, v)  # 昇順なので最後の上書きが月末値
        months_sorted = sorted(month_last.keys())
        sp_monthly = []
        for i in range(1, len(months_sorted)):
            cur_m, prev_m = months_sorted[i], months_sorted[i - 1]
            cur_d, cur_v = month_last[cur_m]
            _, prev_v = month_last[prev_m]
            if prev_v:
                sp_monthly.append({
                    "month": cur_m, "date": cur_d,
                    "pct": round((cur_v / prev_v - 1.0) * 100.0, 2),
                    "level": round(cur_v, 2),
                })
        with open(DATA_DIR / "sp500_monthly.json", "w", encoding="utf-8") as f:
            json.dump({"series": sp_monthly}, f, ensure_ascii=False)
        if sp_monthly:
            last = sp_monthly[-1]
            print(f"[ok     ] {'sp500_monthly':18s} {last['month']} 騰落率 {last['pct']}% "
                  f"(終値 {last['level']})")
    except (HTTPError, URLError, ValueError, KeyError) as e:
        sp_status = "error"
        print(f"[ERROR  ] {'sp500_monthly':18s} 取得失敗: {e}", file=sys.stderr)
    manifest["sp500_status"] = sp_status

    with open(DATA_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # --- 月次スナップショットの保存 ---------------------------------------
    # この取得時点の各指標の最新サマリを data/snapshots/YYYY-MM.json に残す。
    # 後からデータが改定されても「いつ時点でどう見えていたか」を振り返れる。
    snap_dir = DATA_DIR / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    snap_month = datetime.today().strftime("%Y-%m")
    snapshot = {
        "snapshot_month": snap_month,
        "generated_at": manifest["generated_at"],
        "mode": manifest["mode"],
        "indicators": [
            {
                "key": e["key"], "no": e["no"], "name_ja": e["name_ja"],
                "status": e["status"], "summary": e.get("summary"),
                "good_direction": e.get("good_direction"),
            }
            for e in manifest["indicators"]
        ],
    }
    with open(snap_dir / f"{snap_month}.json", "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    # スナップショットの索引（画面側がアーカイブ一覧を知るため）
    snap_files = sorted(p.stem for p in snap_dir.glob("*.json") if p.stem != "index")
    with open(snap_dir / "index.json", "w", encoding="utf-8") as f:
        json.dump({"snapshots": snap_files}, f, ensure_ascii=False, indent=2)

    print("-" * 60)
    print(f"完了: 成功 {ok} / 失敗 {failed} / 手動 "
          f"{sum(1 for i in config['indicators'] if i.get('source') == 'manual')}")
    print(f"manifest:  {DATA_DIR / 'manifest.json'}")
    print(f"snapshot:  {snap_dir / (snap_month + '.json')}  （月次アーカイブ {len(snap_files)} 件）")

    # AIレポートはここでは自動生成しない。
    # 画面の「AIレポートを生成」ボタン（server.py 経由）から、その月のぶんを
    # 1回だけ生成する設計（保管済みなら再生成しない）。
    # 手動でまとめて生成したい場合は: python scripts/generate_analysis.py


if __name__ == "__main__":
    main()
