# 世界インフレ時代の経済指標 / withAwaI

米国の12指標をFREDから取得する公開閲覧サービス。正本は config/indicators.json。
サンプルデータを公開しない。変換後の単位、観測日と取得日の違い、改定値と当時公表値の違いを明示する。
S&P 500系列は再掲載許諾が確認されるまで公開配布物に含めない。
FRED_API_KEYはCloudflare Secretのみ。公開のAI生成API（運営側のキーでサーバーが生成するもの）は禁止。「AIで分析」は利用者自身のAPIキーでブラウザからAnthropic/OpenAIへ直接呼ぶ方式のみ許可（web/ai-analysis.js）。モデル一覧はModels APIからライブ取得し、ハードコードは取得失敗時の予備のみ。
変更はブランチ→PR→squash merge。npm run build / npm run checkを実施して同じソースをCloudflareへ配信する。
withAwaIの変更時は https://github.com/tym3104/withawai-management/blob/main/UPDATE_POLICY.md に従い管理台帳と必要な公開一覧を同期する。
