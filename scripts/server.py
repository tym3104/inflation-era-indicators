#!/usr/bin/env python3
"""
ダッシュボード用のローカルAPIサーバー。

- 静的ファイル配信（プロジェクト全体）: / で web/ にリダイレクト、/web/ でダッシュボード。
- GET  /api/analysis?month=YYYY-MM  : その月のAIレポートを返す（無ければ404）。
                                       month省略時は最新（latest.json）。
- POST /api/analysis/generate       : その月のレポートを生成（最安モデル）。
                                       既に保管済みなら 409（再生成しない）。

APIキーはこのサーバー側だけで使い、ブラウザには渡しません。
標準ライブラリのみで動作（レポート生成時のみ anthropic を使用）。

起動:
    python scripts/server.py            # http://localhost:8000/web/
    python scripts/server.py 8080       # ポート指定
"""

import json
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_DIR = ROOT / "data" / "analysis"

# generate_analysis をインポート（同じ scripts/ ディレクトリ）
sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_analysis  # noqa: E402

# 公開モード: True のとき生成API(POST)を無効化し、機密ファイルへのアクセスも拒否する。
# 外部公開（トンネル/LAN）時は必ず True にする。
PUBLIC_MODE = False

# 公開時に配信を禁止するパス（APIキー等の漏洩防止）
BLOCKED_PREFIXES = ("/.env", "/scripts", "/.git", "/.claude")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _blocked(self, path):
        # 公開モードでは機密ファイル/ディレクトリへのアクセスを拒否
        low = path.rstrip("/").lower()
        return any(low == p or low.startswith(p + "/") or low.startswith(p) for p in BLOCKED_PREFIXES)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- GET --------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/web/")
            self.end_headers()
            return

        if path == "/api/analysis":
            qs = parse_qs(parsed.query)
            month = (qs.get("month") or [None])[0]
            fname = f"{month}.json" if month else "latest.json"
            fpath = ANALYSIS_DIR / fname
            if fpath.exists():
                self._json(200, json.loads(fpath.read_text(encoding="utf-8")))
            else:
                self._json(404, {"status": "not_found", "month": month})
            return

        if path == "/api/analysis/months":
            idx = ANALYSIS_DIR / "index.json"
            self._json(200, json.loads(idx.read_text(encoding="utf-8")) if idx.exists() else {"months": []})
            return

        if path == "/api/config":
            # フロントが公開モードを知るための設定（生成ボタンの表示可否に使う）
            self._json(200, {"public_mode": PUBLIC_MODE, "can_generate": not PUBLIC_MODE})
            return

        # 公開モードでは機密ファイルへのアクセスを拒否
        if PUBLIC_MODE and self._blocked(path):
            self._json(403, {"status": "forbidden"})
            return

        # それ以外は静的ファイル
        return super().do_GET()

    # ---- POST -------------------------------------------------------------
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/analysis/generate":
            self._json(404, {"status": "not_found"})
            return

        # 公開モードでは生成API（API課金リスク）を無効化
        if PUBLIC_MODE:
            self._json(403, {"status": "disabled",
                             "message": "公開モードではAIレポートの生成は無効です（閲覧専用）。"})
            return

        # APIキー未設定なら明示的に返す（画面で案内できるように）
        generate_analysis.load_env()
        if not generate_analysis.has_api_key():
            self._json(400, {"status": "no_api_key",
                             "message": "ANTHROPIC_API_KEY が未設定です。.env に設定してください。"})
            return

        # 対象月（?month=YYYY-MM）。省略時は最新月。直近12ヶ月のみ許可（generate内で検証）。
        qs = parse_qs(parsed.query)
        month = (qs.get("month") or [None])[0]

        # 生成（generate内部で「保管済みなら再生成しない」「直近12ヶ月のみ」を判定）
        try:
            result = generate_analysis.generate(force=False, month=month)
        except Exception as e:
            self._json(500, {"status": "error", "message": str(e)})
            return

        st = result.get("status")
        if st == "generated":
            self._json(200, result)
        elif st == "exists":
            self._json(409, {"status": "exists", "month": result.get("month"),
                             "message": "この月のレポートは既に保管されています。"})
        elif st == "out_of_range":
            self._json(422, {"status": "out_of_range", "month": result.get("month"),
                             "message": "生成できるのは直近12ヶ月のみです。"})
        else:
            self._json(500, result)

    def log_message(self, fmt, *args):
        # APIアクセスのみ簡潔にログ（静的配信は静かに）
        if self.path.startswith("/api/"):
            sys.stderr.write("[server] %s %s\n" % (self.command, self.path))


def main():
    global PUBLIC_MODE
    args = [a for a in sys.argv[1:]]
    PUBLIC_MODE = "--public" in args
    ports = [a for a in args if a.isdigit()]
    port = int(ports[0]) if ports else 8000

    # 公開モードは全インターフェイスで待ち受け（トンネル/LAN公開に対応）
    host = "0.0.0.0" if PUBLIC_MODE else "127.0.0.1"
    httpd = ThreadingHTTPServer((host, port), Handler)

    if PUBLIC_MODE:
        print("=" * 60)
        print("【公開モード】閲覧専用 — AIレポート生成APIは無効・機密ファイルは遮断")
        print("=" * 60)
        print(f"待ち受け: http://{host}:{port}/web/  （全インターフェイス）")
        print("外部公開には cloudflared 等のトンネルを併用してください。")
    else:
        print(f"ダッシュボード: http://localhost:{port}/web/")
        print(f"  GET  /api/analysis?month=YYYY-MM   (省略時は最新)")
        print(f"  POST /api/analysis/generate        (保管済みは409)")
    print("Ctrl+C で停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました")


if __name__ == "__main__":
    main()
