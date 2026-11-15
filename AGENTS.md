# 世界インフレ時代の経済指標 / withAwaI

米国の12指標をFREDから取得する公開閲覧サービス。正本は config/indicators.json。
サンプルデータを公開しない。変換後の単位、観測日と取得日の違い、改定値と当時公表値の違いを明示する。
S&P 500系列は再掲載許諾が確認されるまで公開配布物に含めない。
FRED_API_KEYとANTHROPIC_API_KEYはCloudflare Secretのみ。2026-11-16の本人指示（t469u）でルールベースの整理と利用者ごとのLLM設定を廃止し、AI分析はWorkerのCronが運営のキーで作成・KVへ月別保存して公開する（cloudflare/analysis.mjs）。公開のHTTP経由でAI生成を起動するAPI（POST等）は引き続き禁止。モデルはModels APIから生成時に取得し、FALLBACK_MODELは取得失敗時の予備のみ。
変更はブランチ→PR→squash merge。npm run build / npm run checkを実施して同じソースをCloudflareへ配信する。
withAwaIの変更時は https://github.com/tym3104/withawai-management/blob/main/UPDATE_POLICY.md に従い管理台帳と必要な公開一覧を同期する。
