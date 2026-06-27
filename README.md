# 世界インフレ時代の経済指標ダッシュボード

エミン・ユルマズ『世界インフレ時代の経済指標 今読むべき指標は12個です』（かんき出版, 2023）の
**第2章「絶対に押さえておくべき米国の12の経済指標」** をベースにした、投資判断のための経済ダッシュボード（プロトタイプ）。

各指標の **最新値・前回比・方向（トレンド）** と **意味・読み方の解説** をカードで一覧でき、
クリックで過去推移の詳細チャートを表示します。本書の「目先にジタバタせず大局観を持つ」という趣旨を、
数値とトレンドの両面から掴めるようにすることを狙っています。

## アーキテクチャ

```
FRED API ──(Python: fetch_data.py)──> data/*.json + manifest.json ─┐
                                                                    ├─> web/ (静的サイト) ──> ブラウザ
Claude API ─(generate_analysis.py: 任意)─> data/analysis.json ──────┘
```

- データソース: **FRED**（米セントルイス連銀）
- 取得: Python（標準ライブラリ + certifi）
- 表示: 静的HTML/CSS/JS + Chart.js（CDN）
- **AIレポート（任意）**: `ANTHROPIC_API_KEY` を設定すると、Claude(Opus 4.8)が
  「景気サイクル / インフレ・金融政策 / 米株との関係 / 日本の投資家への含意」の4観点で
  関係性レポートを生成（`data/analysis.json`）。未設定ならルールベースの整理にフォールバック。
- **設定の単一の真実源**: [`config/indicators.json`](config/indicators.json)
  指標の追加・解説の編集・FRED ID差し替えはこのファイルだけで完結します。

## 収録する12指標

| # | 指標 | FREDシリーズ |
|---|------|------|
| 1 | 雇用統計（非農業部門雇用者数） | PAYEMS（失業率 UNRATE 併記） |
| 2 | 新規失業保険申請件数 | ICSA |
| 3 | 小売売上高 | RSAFS |
| 4 | 実質GDP | GDPC1 |
| 5 | 個人所得・個人支出 | PCE / PI |
| 6 | 消費者信頼感指数 | CSCICP03USM665S（OECD系列で代替） |
| 7 | ミシガン大学消費者態度指数 | UMCSENT |
| 8 | 耐久財受注 | DGORDER |
| 9 | 鉱工業生産指数 | INDPRO |
| 10 | 製造業新規受注（景況感の代替） | AMTMNO 前月比で自動取得 ※本来はISM製造業PMIを置く枠だが無料取得不可のため代替 |
| 11 | 新規住宅建設許可件数 | PERMIT（住宅着工 HOUST 併記） |
| 12 | 消費者物価指数（CPI） | CPIAUCSL / コア CPILFESL |

> **ISMについて**: ISM製造業PMIは商用ライセンスデータで、FRED（2016年に削除）・NASDAQ Data Link
> （有料/アクセス制限）・DBnomics（直近データが破損）など、**信頼できる無料の自動取得ルートが存在しません**。
> そこで本ツールでは ISM新規受注と相関の高い FRED の **製造業新規受注総額(AMTMNO)** の前月比を
> 「ISM代替」として自動取得しています（カードにその旨を明記）。
> 正規の ISM PMI 値（50との比較）が必要な場合は [ISM公式](https://www.ismworld.org/) を参照してください。
> 元の手動更新方式に戻したい場合は `config/indicators.json` の `ism_pmi` を `source: "manual"` に変更します。

## セットアップ

### 1. FRED APIキーを取得（無料）
https://fredaccount.stlouisfed.org/apikeys でアカウント登録し、APIキーを発行。

### 2. キーを設定
```bash
cp .env.example .env
# .env を編集して FRED_API_KEY=発行したキー を記入
# （任意）AIレポートを使う場合は ANTHROPIC_API_KEY も記入
#         取得: https://console.anthropic.com/settings/keys
```

### 3. データ取得
```bash
pip install -r scripts/requirements.txt   # certifi（SSL対策）、anthropic（AIレポート任意）
python scripts/fetch_data.py
```
`data/manifest.json` と各指標の `data/<key>.json` が生成されます。

> APIキーがまだ無くても、ダミーデータで見た目を確認できます:
> ```bash
> python scripts/fetch_data.py --sample
> ```

### 4. ブラウザで表示
**AIレポートの生成ボタンを使う場合は、付属のローカルサーバーで起動します**（APIキーをブラウザに渡さず、サーバー側だけで使うため）。
```bash
python scripts/server.py 8000
# ブラウザで http://localhost:8000/web/ を開く
```
画面下部の「AIレポートを生成」ボタンを押すと、Claude（最安モデルを自動選択）が
その月の関係性レポートを生成し `data/analysis/<YYYY-MM>.json` に保管します。
**保管後はそのボタンは再生成しません**（API再課金を防止）。

> AIレポートを使わない（ルールベース整理のみ）なら、簡易サーバでもOK:
> ```bash
> python -m http.server 8000   # → http://localhost:8000/web/
> ```

## AIレポートの仕組み

- **生成**: 画面のボタン → `server.py` → Claude API（`generate_analysis.py`）
- **モデル**: 実行時に Models API を確認し、**利用可能な最安モデル**を自動選択（現状 Haiku 4.5）。
  価格表は `scripts/generate_analysis.py` の `KNOWN_INPUT_PRICE` で管理（安いモデルが出たら1行追加で追従）。
- **生成できる月**: **直近12ヶ月**（最新月〜11ヶ月前）。過去月を選ぶと**その月時点の指標値**で分析します。
- **保管**: `data/analysis/<YYYY-MM>.json`（月別）。月1回・保管後は再生成しません。
- **生成の場所**: ローカルモード（`server.py`、公開フラグなし）でのみボタンが出ます。
  **公開モード（`--public`）では生成は無効**（閲覧専用・API課金防止）。
- **手動生成**: `python scripts/generate_analysis.py [--month YYYY-MM] [--force]`

### 公開（外部アクセス）
閲覧専用で外部に一時公開する場合（生成ボタンは無効・機密ファイルは遮断）:
```bash
python scripts/server.py 8000 --public          # 公開モードで起動
cloudflared tunnel --url http://localhost:8000   # 一時URLを発行（別ウィンドウ）
# → 表示URL + /web/ を共有。ウィンドウを閉じればURLは無効
```
自分用に生成も使いたいときは、別ポートで**通常モード**を起動: `python scripts/server.py 8001`

## ファイル構成

```
inflation-era-indicators/
├── README.md
├── .env.example            # FRED_API_KEY のテンプレ
├── config/
│   └── indicators.json     # ★単一の真実源（12指標の定義・解説）
├── scripts/
│   ├── fetch_data.py       # FRED取得 → data/*.json 生成
│   └── requirements.txt
├── data/                   # 生成物（gitignore対象）
└── web/
    ├── index.html
    ├── styles.css
    └── app.js
```

## 今後の拡張アイデア
- 景気の総合シグナル（信号色で全体を一望）
- 第3章の諸外国指標・第5章のコモディティの追加
- GitHub Actions等での定期自動取得・GitHub Pages公開

## 免責
本ダッシュボードは書籍の枠組みの学習・可視化を目的としたもので、投資勧誘ではありません。
投資判断はご自身の責任で行ってください。
