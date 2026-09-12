import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access}from'node:fs/promises';
import {transform,summarize,refresh,config}from'../cloudflare/data.mjs';
import worker from '../cloudflare/worker.mjs';
test('monthly percentage, difference, year-over-year and quarterly annualization have correct units and values',()=>{
 const rows=[{date:'2025-01-01',value:100},{date:'2025-02-01',value:110}];
 assert.equal(transform(rows,'mom_pct')[0].value,10);assert.equal(transform(rows,'mom_change')[0].value,10);
 assert.equal(transform([{date:'2025-01-01',value:100},{date:'2026-01-01',value:103}],'yoy_pct')[0].value,3);
 assert.equal(transform([{date:'2025-01-01',value:100},{date:'2025-04-01',value:101}],'qoq_annualized')[0].value,4.06);
 assert.deepEqual(transform([{date:'2025-01-01',value:100},{date:'2025-03-01',value:120}],'mom_pct'),[],'missing months cannot masquerade as month-on-month');
 assert.deepEqual(transform([{date:'2025-01-01',value:100},{date:'2026-02-01',value:130}],'yoy_pct'),[],'no approximate year-ago match');
 assert.equal(summarize([]),null);
 for(const i of config.indicators.filter(i=>i.transform==='mom_pct'))assert.equal(i.unit,'前月比 %');
 assert(!config.indicators.find(i=>i.key==='cpi').threshold);
});
test('a failed refresh never replaces the complete previous snapshot or leaks secrets',async()=>{
 const writes=[];
 await assert.rejects(refresh({FRED_API_KEY:'secret',DATA:{put:async(...a)=>writes.push(a)}},async()=>new Response('bad',{status:500})),/FRED payems: HTTP 500/);
 assert.equal(writes.length,0);
});
test('successful refresh publishes a complete atomic bundle of all 12 real-source series',async()=>{
 const observations=Array.from({length:36},(_,i)=>({date:`${2023+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}-01`,value:String(100+i)}));
 const writes=[];
 const b=await refresh({FRED_API_KEY:'secret',DATA:{put:async(...a)=>writes.push(a)}},async(url)=>{
  const id=url.searchParams.get('series_id');return Response.json({observations:id==='GDPC1'?observations.filter((_,i)=>i%3===0):observations});
 },new Date('2026-09-12T00:00:00Z'));
 assert.equal(b.manifest.indicators.length,12);assert.equal(Object.keys(b.files).length,12);assert.equal(writes[0][0],'current');assert(!writes[0][1].includes('secret'));
});
test('public worker rejects writes and paid generation, supplies public config and KV snapshot',async()=>{
 const env={DATA:{get:async()=>null},ASSETS:{fetch:async()=>new Response('missing',{status:404})}};
 assert.equal((await worker.fetch(new Request('https://example.com/api/analysis/generate',{method:'POST'}),env)).status,405);
 assert.equal((await (await worker.fetch(new Request('https://example.com/api/config'),env)).json()).can_generate,false);
 assert.equal((await worker.fetch(new Request('https://example.com/.env'),env)).status,404);
 env.DATA.get=async()=>({manifest:{generated_at:'2026-09-12',indicators:[]}});
 assert.equal((await worker.fetch(new Request('https://example.com/data/manifest.json'),env)).status,200);
});
test('public build omits private reports, source code, keys and restricted time series',async()=>{
 for(const p of ['.env','config/indicators.json','scripts/server.py','data/analysis.json','data/sp500_monthly.json'])await assert.rejects(access(new URL('../dist/'+p,import.meta.url)));
 const m=JSON.parse(await readFile(new URL('../dist/data/manifest.json',import.meta.url)));assert.equal(m.mode,'fred');assert.equal(m.indicators.length,12);
 for(const i of m.indicators)assert.equal(new URL(i.source_url).hostname,'fred.stlouisfed.org');
});
