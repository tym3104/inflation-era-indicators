#!/usr/bin/env python3
"""
ダッシュボード用のローカルAPIサーバー。

- 静的ファイル配信（web/・data/・config/ と Chart.js 本体のみ。.env・.git・scripts 等は配信しない）:
  / で web/ にリダイレクト、/web/ でダッシュボード。
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
import re
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_DIR = ROOT / "data" / "analysis"

# generate_analysis をインポート（同じ scripts/ ディレクトリ）
sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_analysis  # noqa: E402

# 公開モード: True のとき生成API(POST)を無効化する。
# 外部公開（トンネル/LAN）時は必ず True にする。
PUBLIC_MODE = False

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")

# 配信してよいディレクトリだけを許可する（プロジェクト全体は配信しない）。
# .env / .git / scripts / .claude などはどのモードでも配信されない。
# URLの先頭 → 実ディレクトリ。どれにも当たらないパスは web/ 配下として扱う
# （web/index.html が /app.js, /styles.css, /foundation/... を絶対パスで読むため）。
STATIC_MOUNTS = (
    ("/web/", ROOT / "web"),
    ("/data/", ROOT / "data"),
    ("/config/", ROOT / "config"),
)
# Chart.js は npm の配布物を1ファイルだけ配信する（公開版の dist/vendor と同じURL）
VENDOR_FILES = {
    "/vendor/chart.umd.js": ROOT / "node_modules" / "chart.js" / "dist" / "chart.umd.js",
}


def _inside(path, base):
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def resolve_static(url_path):
    """URLパス（デコード前）を、配信してよい実ファイルのパスに変換する。
    許可外・ドットファイル・ディレクトリ外への脱出は None。"""
    path = unquote(url_path, errors="strict") if url_path else ""
    if not path.startswith("/") or "\\" in path or "\x00" in path:
        return None
    segments = [s for s in path.split("/") if s]
    # 「.」「..」やドットファイル（.env, .git, .DS_Store など）は一切配信しない
    if any(s.startswith(".") for s in segments):
        return None
    if path in VENDOR_FILES:
        target = VENDOR_FILES[path]
        return target if target.is_file() else None
    for prefix, base in STATIC_MOUNTS:
        if path == prefix.rstrip("/") or path.startswith(prefix):
            rel = path[len(prefix):]
            break
    else:
        base, rel = ROOT / "web", path.lstrip("/")
    base = base.resolve()
    target = (base / rel).resolve()  # シンボリックリンクも解決してから判定
    if not _inside(target, base):
        return None
    if target.is_dir():
        index = target / "index.html"
        return index if index.is_file() else None
    return target if target.is_file() else None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self._target = None
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def translate_path(self, path):
        # do_GET で検証済みのパスだけを開く（それ以外は存在しないパス）
        return str(self._target) if self._target else str(ROOT / "web" / "__not_found__")

    def list_directory(self, path):
        self._json(404, {"status": "not_found"})
        return None

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
            if month is not None and not MONTH_RE.fullmatch(month):
                self._json(400, {"status": "bad_request", "message": "month は YYYY-MM 形式で指定してください。"})
                return
            fname = f"{month}.json" if month else "latest.json"
            base = ANALYSIS_DIR.resolve()
            fpath = (base / fname).resolve()
            if _inside(fpath, base) and fpath.is_file():
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

        if path.startswith("/api/"):
            self._json(404, {"status": "not_found"})
            return

        # それ以外は許可したディレクトリの静的ファイルだけ（どのモードでも同じ）
        return self._serve_static(path, super().do_GET)

    def do_HEAD(self):
        return self._serve_static(urlparse(self.path).path, super().do_HEAD)

    def _serve_static(self, path, serve):
        try:
            target = resolve_static(path)
        except UnicodeDecodeError:
            target = None
        if target is None:
            self._json(404, {"status": "not_found"})
            return
        self._target = target
        return serve()

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
        print("【公開モード】閲覧専用 — AIレポート生成APIは無効・配信は web/ data/ config/ のみ")
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
