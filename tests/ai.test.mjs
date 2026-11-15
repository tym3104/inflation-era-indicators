import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from '../cloudflare/worker.mjs';

const src=await readFile(new URL('../web/ai-analysis.js',import.meta.url),'utf8');
const memStore=()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),_m:m};};
function load(fetchImpl){const ctx={localStorage:memStore(),sessionStorage:memStore(),fetch:fetchImpl,console,Date,JSON,Math};ctx.window=ctx;vm.runInNewContext(src,ctx);return ctx;}

test('Anthropic models are fetched live with browser headers and sorted newest first',async()=>{
 const calls=[];
 const ctx=load(async(url,opt)=>{calls.push([url,opt]);return Response.json({data:[{id:'claude-old',display_name:'Old',created_at:'2025-01-01T00:00:00Z'},{id:'claude-new',display_name:'New',created_at:'2026-11-01T00:00:00Z'}]});});
 const r=await ctx.EconAI.fetchModels('anthropic','sk-ant-test-123456',{force:true});
 assert.equal(r.source,'live');assert.deepEqual(r.models.map(m=>m.id),['claude-new','claude-old']);
 assert.equal(calls[0][0],'https://api.anthropic.com/v1/models?limit=1000');
 assert.equal(calls[0][1].headers['anthropic-dangerous-direct-browser-access'],'true');
 const again=await ctx.EconAI.fetchModels('anthropic','sk-ant-test-123456');
 assert.equal(again.source,'cache');assert.equal(calls.length,1);
 assert(!ctx.localStorage.getItem('econ-ai-models-v1').includes('sk-ant'),'model cache never contains the key');
});

test('OpenAI model list keeps chat models only, newest first',()=>{
 const ctx=load(async()=>{});
 const ms=ctx.EconAI.normalizeModels('openai',{data:[{id:'gpt-4o',created:1},{id:'text-embedding-3-large',created:9},{id:'gpt-5.1',created:5},{id:'whisper-1',created:8},{id:'o3',created:3},{id:'gpt-4o-realtime-preview',created:7}]});
 assert.deepEqual(ms.map(m=>m.id),['gpt-5.1','o3','gpt-4o']);
});

test('model fetch failure falls back with a message and never leaks the key',async()=>{
 const ctx=load(async()=>{throw new Error('boom sk-proj-abcdefghijk');});
 const r=await ctx.EconAI.fetchModels('openai','sk-proj-abcdefghijk',{force:true});
 assert.equal(r.source,'fallback');assert(r.models.length>0);assert.match(r.reason,/予備/);assert(!r.reason.includes('abcdefghijk'));
});

const manifestInds=[{no:1,key:'payems',name_ja:'雇用統計（非農業部門雇用者数）',category:'雇用',unit:'千人(前月差)',transform_label:'前月差',good_direction:'up',summary:{latest_value:162,latest_date:'2026-09-01',prev_value:120,change:42,direction:'up'}},
 {no:12,key:'cpi',name_ja:'CPI',category:'物価',unit:'%',transform_label:'前年同月比',good_direction:'down',summary:{latest_value:3.353,latest_date:'2026-09-01',prev_value:3.304,change:0.049,direction:'up'}}];
const ctxData={month:'2026-09',indicators:manifestInds,series:{payems:[{date:'2026-08-01',value:120},{date:'2026-09-01',value:162},{date:'2026-10-01',value:999}]},scores:{now:20,'3_months_ago':-10,'12_months_ago':null},ruleCategories:{strong:['雇用'],weak:['物価'],mixed:[]}};

test('prompt carries the actual values, month cut-off and asks for indicator citations and no advice',()=>{
 const ctx=load(async()=>{});
 const p=ctx.EconAI.buildPrompt(ctxData);
 assert.match(p.user,/"value":162/);assert.match(p.user,/"change":0\.049/);assert.match(p.user,/2026-09/);
 assert(!p.user.includes('999'),'future observations after the selected month are excluded');
 assert.match(p.user,/indicators/);assert.match(p.system,/投資助言/);
});

test('Anthropic analysis call parses JSON and keeps only valid indicator citations',async()=>{
 let sent;
 const ctx=load(async(url,opt)=>{sent={url,opt};return Response.json({content:[{type:'text',text:'```json\n{"headline":"雇用堅調・物価高止まり","current":[{"text":"雇用は増加、CPIは上昇。","indicators":[1,12,99,"x"]}],"history":[],"outlook":[{"text":"条件付きで減速の可能性。","indicators":[1]}],"caveat":"改定あり"}\n```'}]});});
 const rep=await ctx.EconAI.callModel('anthropic','sk-ant-xyz','claude-new',ctx.EconAI.buildPrompt(ctxData));
 assert.equal(sent.url,'https://api.anthropic.com/v1/messages');
 const body=JSON.parse(sent.opt.body);assert.equal(body.model,'claude-new');assert(!sent.opt.body.includes('sk-ant-xyz'),'key only in header');
 assert.deepEqual([...rep.current[0].indicators],[1,12]);assert.equal(rep.outlook.length,1);
});

test('OpenAI analysis call uses chat completions JSON mode; 401 is reported without the key',async()=>{
 const ctx=load(async(url,opt)=>{assert.equal(url,'https://api.openai.com/v1/chat/completions');assert.equal(JSON.parse(opt.body).response_format.type,'json_object');return Response.json({error:{message:'Incorrect API key sk-proj-zzzzzzzz'}},{status:401});});
 await assert.rejects(ctx.EconAI.callModel('openai','sk-proj-zzzzzzzz','gpt-5.1',{system:'s',user:'u'}),e=>!String(e.message).includes('zzzz')&&/401/.test(e.message));
});

test('malformed AI output is rejected so the rule-based report remains the answer',()=>{
 const ctx=load(async()=>{});
 assert.throws(()=>ctx.EconAI.parseReport('すみません'));
 assert.throws(()=>ctx.EconAI.parseReport('{"headline":"x"}'));
});

test('public worker CSP allows only the two AI providers in addition to self, and still refuses server generation',async()=>{
 const env={DATA:{get:async()=>null},ASSETS:{fetch:async()=>new Response('<html></html>',{status:200,headers:{'content-type':'text/html'}})}};
 const res=await worker.fetch(new Request('https://economy.withawai.com/'),env);
 const csp=res.headers.get('content-security-policy');
 assert.match(csp,/connect-src 'self' https:\/\/api\.anthropic\.com https:\/\/api\.openai\.com;/);
 assert.match(csp,/script-src 'self';/);
 assert.equal((await worker.fetch(new Request('https://economy.withawai.com/api/analysis/generate',{method:'POST'}),env)).status,405);
});
