# 世界インフレ時代の経済指標ダッシュボード｜withAwaI

米国の12の経済指標を、最新値・観測日・前回との差・月別推移・詳細チャート・解説と出典から確認する公開閲覧サービス。

- 公開URL: https://economy.withawai.com/
- シリーズ一覧: https://company.withawai.com/products/#inflation-era-indicators
- データ出典: FRED（セントルイス連邦準備銀行）と各統計作成機関
- 書籍『世界インフレ時代の経済指標』第2章の12枠を出発点とした独立した学習サービスです。著者・出版社の公式サービスではありません。

## 本番構成

Cloudflare Workers + Static Assets + Workers KV。`config/indicators.json` が指標定義の正本。
`cloudflare/data.mjs` がFRED APIの実測系列を取得し、前月差・前月比・前期比年率・前年同月比を計算します。
毎日01:15 UTC（10:15 JST）にCron Triggerで更新を試行します。12指標がすべて成功した場合のみ、KVの一つのキーへ完全なデータ一式を書き込みます。失敗した場合は前回の一式を維持します。
KVを利用できない場合は、公開時に検証した `dist/data/` のスナップショットに戻ります。取得日時が48時間を超えた場合は画面に遅延を表示します。

FRED_API_KEYはCloudflare Secretで保管し、HTML・JSON・Gitには含めません。公開WorkerはGET/HEADのみ受け付け、有料AIレポートの生成を提供しません。`workers.dev` とpreview URLは無効です。

## 収録指標と定義

|指標|FRED|表示|
|---|---|---|
|非農業部門雇用者数|PAYEMS|前月差・千人|
|新規失業保険申請|ICSA|件|
|小売売上高|RSAFS|前月比 %|
|実質GDP|GDPC1|前期比年率 %|
|個人消費支出|PCE|前月比 %（物価指数ではない）|
|消費者信頼感|USACSCICP02STSAM|回答差、季節調整済み（長期平均100ではない）|
|ミシガン消費者態度|UMCSENT|1966Q1=100、出典により1か月遅れ|
|耐久財受注|DGORDER|前月比 %|
|鉱工業生産|INDPRO|前月比 %|
|製造業新規受注|AMTMNO|前月比 %（ISM PMIとは別統計）|
|住宅建設許可|PERMIT|前月比 %|
|CPI|CPIAUCSL|季節調整済み系列の前年同月比 %|

前回との差は変換後の値同士の差です。変化率同士の差はポイントと表示します。欠測月を飛び越えて前月比や前年同月比を計算しません。
過去月の閲覧も現在取得した改定後系列による計算であり、当時利用できたデータの再現ではありません。
独自の方向スコアは `(改善方向の数 − 悪化方向の数) / 方向が変化した指標数 × 100`。横ばい・欠測を除外する参考値であり、公的な景気判定・将来予測・売買シグナルではありません。
FRBの2%目標はPCE物価指数に対するもので、CPIの判定基準にはしていません。

## 配信と検証

Node.js 22以上。

```sh
npm ci
npm run build
npm run check
npm run dev
```

`npm run build` は公開可能な静的資産・12指標だけを `dist/` に生成します。サンプルモードは公開不可。Chart.jsはローカル配信です。

```sh
npx wrangler secret put FRED_API_KEY
npm run deploy
```

Secretを設定したあと、PRをsquash mergeし、同じソースから配信します。配信後は `/health` の配信ID、12指標、月切替、期間切替、詳細と出典、法務ページ、秘密パスの404、POST拒否を確認します。
管理サイトの更新はAGENTS.mdの同期手順に従います。

## ローカル版と公開版の違い

`scripts/server.py` とPythonの取得・AI分析スクリプトはローカル版として残しています。公開Workerから呼び出しません。
S&P 500は出典が事前の書面許諾を求めるため、公開配布物には含めず公式ページへ案内します。個人用の既存データは公開用ビルドの対象外です。
既存の個人用AIレポートも公開配布物に含めません。公開版にはルールベースの整理を掲載します。

出典: https://fred.stlouisfed.org/series/SP500 、 https://fred.stlouisfed.org/series/UMCSENT 、 https://fred.stlouisfed.org/series/USACSCICP02STSAM
