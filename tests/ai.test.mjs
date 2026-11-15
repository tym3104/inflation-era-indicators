import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {monthsOf,buildInput,fingerprint,pickModel,validateReport,runAnalysis,getAnalysis,buildPrompt,FALLBACK_MODEL} from '../cloudflare/analysis.mjs';
import {config} from '../cloudflare/data.mjs';
import worker from '../cloudflare/worker.mjs';

// 実データ（リポジトリ内の取得済みFRED系列）から bundle を組む
const files={};
for(const ind of config.indicators)files[ind.key]=JSON.parse(await readFile(new URL(`../data/${ind.key}.json`,import.meta.url)));
const bundle={manifest:{generated_at:'2026-09-12T00:00:00Z',indicators:[]},files};
const kv=()=>{const m=new Map();return{m,get:async(k,t)=>m.has(k)?(t==='json'?JSON.parse(m.get(k)):m.get(k)):null,put:async(k,v)=>{m.set(k,v);}};};
const months=monthsOf(files),latest=months.at(-1);
const goodReport=(nos=[1,12])=>JSON.stringify({headline:'雇用は底堅く物価は高止まり',current:[{text:'雇用統計が増える一方でCPIの伸びも続いている。',indicators:nos}],history:[{text:'方向スコアは1年前より改善している。',indicators:[3,9]}],outlook:[{text:'住宅許可が続けば生産の持ち直しにつながる可能性がある。',indicators:[11,9]}],caveat:'改定後の値で再計算している。'});
function fakeAnthropic({models=[{id:'claude-sonnet-old',created_at:'2025-01-01T00:00:00Z'},{id:'claude-opus-new',created_at:'2026-11-01T00:00:00Z'},{id:'claude-sonnet-new',created_at:'2026-10-01T00:00:00Z'}],text=goodReport(),modelsFail=false,calls=[]}={}){
 return async(url,opt={})=>{calls.push({url:String(url),opt});
  if(String(url).includes('/v1/models'))return modelsFail?new Response('x',{status:500}):Response.json({data:models});
  return Response.json({content:[{type:'text',text:typeof text==='function'?text(calls):text}]});};
}

test('input uses only observations up to the month and carries real values',()=>{
 const inp=buildInput(files,'2026-07');
 assert.equal(inp.indicators.length,12);
 const pay=inp.indicators.find(x=>x.no===1);assert(pay.observed<='2026-07-31');assert.equal(pay.recent.at(-1)[0],'2026-07');
 assert(!JSON.stringify(inp).includes('"2026-08-01"'));
 assert.match(buildPrompt(inp).user,/indicators/);assert.match(buildPrompt(inp).system,/投資助言/);
});

test('model is chosen from the live list: newest of the configured family, otherwise newest overall',()=>{
 const ms=[{id:'claude-sonnet-a',created_at:'2025-01-01T00:00:00Z'},{id:'claude-opus-z',created_at:'2026-11-01T00:00:00Z'},{id:'claude-sonnet-b',created_at:'2026-06-01T00:00:00Z'}];
 assert.equal(pickModel(ms),'claude-sonnet-b');assert.equal(pickModel(ms,'opus'),'claude-opus-z');assert.equal(pickModel(ms,'haiku'),'claude-opus-z');assert.equal(pickModel([]),null);
});

test('validation rejects wrong schema, citations without data, out-of-range numbers and over-long text',()=>{
 const inp=buildInput(files,latest);
 assert.equal(validateReport('```json\n'+goodReport()+'\n```',inp).current[0].indicators.length,2);
 assert.throws(()=>validateReport('ok',inp));
 assert.throws(()=>validateReport(goodReport([99]),inp),/根拠/);
 assert.throws(()=>validateReport(goodReport([]),inp),/根拠/);
 const long=JSON.parse(goodReport());long.current[0].text='あ'.repeat(401);assert.throws(()=>validateReport(JSON.stringify(long),inp),/長さ/);
 const noHist=JSON.parse(goodReport());noHist.history=[];assert.throws(()=>validateReport(JSON.stringify(noHist),inp),/項目数/);
});

test('without ANTHROPIC_API_KEY nothing is called and the status says not configured',async()=>{
 const env={DATA:kv()};let called=0;
 const st=await runAnalysis(env,{fetcher:async()=>{called++;},bundle});
 assert.equal(st.state,'not_configured');assert.equal(called,0);
 const r=await getAnalysis(env,latest,bundle);assert.equal(r.status,'none');assert.equal(r.state,'not_configured');
});

test('generates newest months first (capped), stores per month, then regenerates only when new observations land',async()=>{
 const env={DATA:kv(),ANTHROPIC_API_KEY:'sk-ant-secret-123456'};const calls=[];
 const st=await runAnalysis(env,{fetcher:fakeAnthropic({calls}),bundle,maxCalls:2,now:new Date('2026-11-16T00:00:00Z')});
 assert.deepEqual(st.generated.map(g=>g.month),[months.at(-1),months.at(-2)]);
 assert.equal(st.generated[0].model,'claude-sonnet-new');assert.equal(st.pending,10);
 const msg=calls.find(c=>c.url.endsWith('/v1/messages'));assert.equal(msg.opt.headers['x-api-key'],'sk-ant-secret-123456');
 const rec=JSON.parse(env.DATA.m.get(`analysis:${latest}`));assert.equal(rec.model,'claude-sonnet-new');assert.equal(rec.month,latest);
 assert(![...env.DATA.m.values()].some(v=>v.includes('sk-ant-secret')),'key never stored');
 // 残りを埋めたあとは、新しい観測が無ければ呼ばない
 for(let i=0;i<5;i++)await runAnalysis(env,{fetcher:fakeAnthropic(),bundle,maxCalls:2});
 const quiet=[];const st2=await runAnalysis(env,{fetcher:fakeAnthropic({calls:quiet}),bundle});
 assert.equal(st2.generated.length,0);assert.equal(quiet.length,0);
 // 新しい公表（payems に翌月の観測）が入ると、その月だけ作り直し、旧版は退避
 const f2={...files,payems:{...files.payems,series:[...files.payems.series,{date:`${latest}-01`,value:50}]}};
 const st3=await runAnalysis(env,{fetcher:fakeAnthropic(),bundle:{...bundle,files:f2}});
 assert.deepEqual(st3.generated.map(g=>g.month),[latest]);
 assert([...env.DATA.m.keys()].some(k=>k.startsWith(`analysis-archive:${latest}:`)));
});

test('model list failure uses the fallback; invalid output twice keeps the previous analysis and reports failure',async()=>{
 const env={DATA:kv(),ANTHROPIC_API_KEY:'k'};
 const st=await runAnalysis(env,{fetcher:fakeAnthropic({modelsFail:true}),bundle,maxCalls:1});
 assert.equal(st.generated[0].model,FALLBACK_MODEL);
 const prev=env.DATA.m.get(`analysis:${latest}`);
 const f2={...files,cpi:{...files.cpi,series:[...files.cpi.series,{date:`${latest}-01`,value:3.1}]}};
 const b2={...bundle,files:f2};
 const st2=await runAnalysis(env,{fetcher:fakeAnthropic({text:'すみません'}),bundle:b2,maxCalls:1});
 assert.equal(st2.state,'partial_failure');assert.equal(env.DATA.m.get(`analysis:${latest}`),prev,'previous analysis retained');
 const r=await getAnalysis(env,latest,b2);assert.equal(r.status,'ok');assert.equal(r.failed,true);assert.equal(r.stale,true);
});

test('a month without its own analysis shows the most recent earlier one, flagged as fallback',async()=>{
 const env={DATA:kv(),ANTHROPIC_API_KEY:'k'};
 const prevMonth=months.at(-2);
 await env.DATA.put(`analysis:${prevMonth}`,JSON.stringify({month:prevMonth,generated_at:'2026-11-01T00:00:00Z',model:'m',fingerprint:fingerprint(buildInput(files,prevMonth)),report:{}}));
 const r=await getAnalysis(env,latest,bundle);assert.equal(r.fallback,true);assert.equal(r.shown_month,prevMonth);
 assert.equal((await getAnalysis(env,'bad',bundle)).status,'bad_request');
});

test('worker serves /api/analysis, keeps CSP self-only, refuses HTTP-triggered generation, and the cron wires both jobs',async()=>{
 const env={DATA:kv(),ASSETS:{fetch:async()=>new Response('<html></html>',{headers:{'content-type':'text/html'}})}};
 await env.DATA.put('current',JSON.stringify(bundle));
 const r=await worker.fetch(new Request(`https://economy.withawai.com/api/analysis?month=${latest}`),env);
 assert.equal(r.status,200);assert.equal((await r.json()).status,'none');
 const page=await worker.fetch(new Request('https://economy.withawai.com/'),env);
 assert.match(page.headers.get('content-security-policy'),/connect-src 'self';/);
 assert.equal((await worker.fetch(new Request('https://economy.withawai.com/api/analysis',{method:'POST'}),env)).status,405);
 const waits=[];await worker.scheduled({cron:'40 * * * *'},env,{waitUntil:p=>waits.push(p)});await Promise.all(waits);
 assert.equal(JSON.parse(env.DATA.m.get('analysis-status')).state,'not_configured');
 const wr=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8');assert.match(wr,/"15 1 \* \* \*"/);assert.match(wr,/"40 \* \* \* \*"/);
});

test('public page has no rule-based report and no per-user LLM settings',async()=>{
 const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8'),html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 for(const s of ['buildAnalysis','analysisCurrent','ルールベースの整理）','sessionStorage','x-api-key','ai-analysis.js'])assert(!app.includes(s)&&!html.includes(s),s);
 assert.match(app,/AI生成・投資助言ではありません/);
});
