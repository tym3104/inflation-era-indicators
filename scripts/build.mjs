import {readFile,writeFile,mkdir,cp,rm} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {enrich,config} from '../cloudflare/data.mjs';
const root=new URL('../',import.meta.url),out=new URL('dist/',root);
const read=async p=>JSON.parse(await readFile(new URL(p,root),'utf8'));
const manifest=enrich(await read('data/manifest.json'));
assert.equal(manifest.mode,'fred','Sample data must never be published');
assert.equal(manifest.indicators.length,12);
// The original prototype timestamps were local JST without an offset.
if(!/[Zz]|[+-]\d\d:\d\d$/.test(manifest.generated_at))manifest.generated_at+='+09:00';
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
await cp(new URL('web/',root),out,{recursive:true});
await mkdir(new URL('vendor/',out),{recursive:true});
await cp(new URL('node_modules/chart.js/dist/chart.umd.js',root),new URL('vendor/chart.umd.js',out));
await cp(new URL('node_modules/chart.js/LICENSE.md',root),new URL('vendor/chart-LICENSE.md',out));
await mkdir(new URL('data/',out),{recursive:true});await mkdir(new URL('config/',out),{recursive:true});
for(const ind of config.indicators){
 const payload=await read(`data/${ind.key}.json`);
 assert(payload.series.length>1 && payload.series.every(p=>Number.isFinite(p.value)));
 const data={...payload,unit:ind.unit,source_url:`https://fred.stlouisfed.org/series/${ind.fred_id}`};
 await writeFile(new URL(`data/${ind.key}.json`,out),JSON.stringify(data));
}
await writeFile(new URL('data/manifest.json',out),JSON.stringify(manifest));
await writeFile(new URL('config/events.json',out),JSON.stringify({events:[]}));
await writeFile(new URL('favicon.svg',out),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#193c30"/><path d="M12 45L25 31l10 6 17-23" fill="none" stroke="#d9b77b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const shell=(title,body)=>`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}｜経済指標｜withAwaI</title><link rel="stylesheet" href="/foundation/foundation.css"><link rel="stylesheet" href="/foundation/night.css"><link rel="stylesheet" href="/styles.css"></head><body class="ui-theme-night"><main><a href="/">← ダッシュボードへ</a><h1>${title}</h1>${body}<p><a href="https://company.withawai.com/">withAwaI シリーズ / 開発・提供：AwaI株式会社</a></p></main></body></html>`;
for(const [route,title,body] of [
 ['privacy','プライバシーポリシー','<p>本サービスはログインや個人情報の入力を必要としない、経済統計の閲覧サービスです。独自のアクセス解析Cookieは利用しません。</p><p>配信・セキュリティのため、CloudflareがIPアドレスやアクセスログ等を処理する場合があります。統計データはサーバー側からFREDへ取得し、利用者の入力をFREDへ送信しません。</p><p>外部リンク先には各サイトの方針が適用されます。お問い合わせは<a href="https://company.withawai.com/">運営会社サイト</a>をご覧ください。</p>'],
 ['terms','利用規約','<p>本サービスはFRED等の経済統計を整理する情報・学習サービスです。特定の金融商品の推奨や投資助言を行うものではありません。</p><p>指標には公表の遅延、欠測、改定があり、正確性・完全性・継続的な提供を保証しません。重要な判断の前に出典をご確認ください。</p><p>方向スコアは独自の単純集計であり、公的な景気判定や将来予測ではありません。過去月の表示は現在取得した改定系列による再計算です。</p><p>データの権利は各統計作成機関に帰属します。再利用には出典元の条件が適用されます。S&amp;P 500は公開版に再配布せず、出典リンクを案内します。</p><p>本サービスは書籍の著者・出版社・統計作成機関の公式サービスではありません。</p>']
]){await mkdir(new URL(route+'/',out),{recursive:true});await writeFile(new URL(route+'/index.html',out),shell(title,body));}
await writeFile(new URL('404.html',out),shell('ページが見つかりません','<p>URLをご確認いただくか、ダッシュボードへお戻りください。</p>'));
await writeFile(new URL('robots.txt',out),'User-agent: *\nAllow: /\nSitemap: https://economy.withawai.com/sitemap.xml\n');
await writeFile(new URL('sitemap.xml',out),'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+['','privacy/','terms/'].map(p=>`<url><loc>https://economy.withawai.com/${p}</loc></url>`).join('')+'</urlset>');
await writeFile(new URL('llms.txt',out),'# 世界インフレ時代の経済指標ダッシュボード\n\nwithAwaIシリーズ。米国12指標をFREDから取得。\nhttps://economy.withawai.com/\n出典・観測日・取得日を区別。過去月も改定値。独自方向スコアは売買シグナルではない。\n公式シリーズ一覧: https://company.withawai.com/products/\n');
console.log('Built 12 verified FRED series; public assets only; no paid-generation or restricted SP500 payloads.');
