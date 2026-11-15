// サーバー側のAI分析（運営のANTHROPIC_API_KEY）。2026-11-16 本人指示 t469u によりルールベースの整理を廃止し、
// 新しいデータの取得に合わせてLLMで分析を作り、月ごとにKVへ保存して公開する。
// ・モデルはAnthropic Models APIから生成時に取得し、指定ファミリー（既定 sonnet）の最新を使う。取得失敗時のみ予備。
// ・出力はスキーマ・根拠指標・長さを検証し、不合格なら保存しない（前回の分析を維持）。
import {config} from './data.mjs';

export const FALLBACK_MODEL='claude-sonnet-4-6';
export const MAX_MONTHS=12;
// 生成に失敗した月は、同じデータ（fingerprint）のままなら24時間は再試行しない（失敗が続くときのAPI呼び出しを抑える）。
export const FAILURE_COOLDOWN_MS=24*60*60*1000;
const KEY=m=>`analysis:${m}`;
const FAIL_KEY=m=>`analysis-failure:${m}`;
const mk=d=>d.slice(0,7);
const r3=v=>v==null||!Number.isFinite(v)?null:Math.round(v*1000)/1000;

export function monthsOf(files){
  const set=new Set();
  for(const ind of config.indicators)for(const p of files[ind.key]?.series||[])set.add(mk(p.date));
  return [...set].sort();
}
export function valueAt(series,month){
  let idx=-1;for(let i=0;i<series.length;i++){if(mk(series[i].date)<=month)idx=i;else break;}
  if(idx<0)return null;
  const cur=series[idx],prev=idx>0?series[idx-1]:null,change=prev?cur.value-prev.value:null;
  return {value:cur.value,observed:cur.date,previous:prev?prev.value:null,change,direction:change==null?'flat':change>0?'up':change<0?'down':'flat',idx};
}
function scoreAt(files,month){
  let plus=0,minus=0,counted=0;
  for(const ind of config.indicators){
    const v=valueAt(files[ind.key]?.series||[],month);
    if(!v||!ind.good_direction||v.direction==='flat')continue;
    counted++;v.direction===ind.good_direction?plus++:minus++;
  }
  return counted?Math.round((plus-minus)/counted*100):null;
}
export function buildInput(files,month){
  const months=monthsOf(files),i=months.indexOf(month);
  const back=n=>i-n>=0?scoreAt(files,months[i-n]):null;
  const indicators=config.indicators.map(ind=>{
    const s=files[ind.key]?.series||[],v=valueAt(s,month);
    return {no:ind.no,name:ind.name_ja,category:ind.category,unit:ind.unit,measure:ind.transform_label,frequency:ind.frequency,
      improving_direction:ind.good_direction||null,
      ...(v?{value:r3(v.value),observed:v.observed,previous:r3(v.previous),change:r3(v.change),direction:v.direction,
        recent:s.slice(Math.max(0,v.idx-6),v.idx+1).map(p=>[mk(p.date),r3(p.value)])}:{value:null,direction:'no_data'})};
  });
  return {month,indicators,direction_score:{now:back(0),'3_months_ago':back(3),'12_months_ago':back(12)}};
}
// どの観測までを使ったか（値の改定ではなく、新しい公表が入ったときだけ変わる）
export function fingerprint(input){return input.indicators.map(x=>`${x.no}:${x.observed||'-'}`).join('|');}

export function pickModel(models,family='sonnet'){
  const list=(models||[]).filter(m=>m&&typeof m.id==='string').sort((a,b)=>(Date.parse(b.created_at)||0)-(Date.parse(a.created_at)||0));
  const fam=list.filter(m=>m.id.toLowerCase().includes(family.toLowerCase()));
  return (fam[0]||list[0])?.id||null;
}
const anthropicHeaders=key=>({'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'});
export async function chooseModel(env,fetcher=fetch){
  try{
    const res=await fetcher('https://api.anthropic.com/v1/models?limit=1000',{headers:anthropicHeaders(env.ANTHROPIC_API_KEY),signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error(`models HTTP ${res.status}`);
    const id=pickModel((await res.json()).data,env.ANALYSIS_MODEL_FAMILY||'sonnet');
    if(id)return {model:id,source:'models-api'};
  }catch{}
  return {model:FALLBACK_MODEL,source:'fallback'};
}

export function buildPrompt(input){
  const system='あなたは米国の経済統計を中立に読み解くエコノミストです。与えられたデータだけを根拠に日本語で簡潔に書きます。投資助言・売買推奨・特定銘柄や資産への言及・断定的な将来予測はしません。データにない数値やニュースを作りません。';
  const user=`次のJSONは、米国の12の経済指標の ${input.month} 時点の値です（FRED、改定後の系列で再計算。観測日 observed は指標ごとに異なる）。
change は変換後の値どうしの差、improving_direction は改善とみなす方向、recent は直近の推移、direction_score は独自の方向スコア（-100〜+100、景気判定ではない）です。value が null の指標はデータがありません。

${JSON.stringify(input)}

12指標どうしの関係性（先行と一致、雇用と物価、消費と生産、住宅と受注などの整合・不整合）を読み解き、3観点で整理してください。
- current: 現状（直近の流れ）
- history: これまでの変遷（recent と direction_score の推移から）
- outlook: この先の示唆（先行性のある指標から言える範囲で、条件付きの表現で）
各観点は1〜3項目。各項目の text は1〜2文（150字以内）。主張の根拠にした指標の no を indicators に必ず1つ以上入れてください（データがある指標のみ）。

次のJSONだけを出力してください（前後に文章やコードブロックを付けない）:
{"headline":"30字以内の中立な見出し","current":[{"text":"...","indicators":[1,12]}],"history":[{"text":"...","indicators":[3]}],"outlook":[{"text":"...","indicators":[11]}],"caveat":"データ上の注意を1文"}`;
  return {system,user};
}

export function validateReport(text,input){
  const t=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
  const a=t.indexOf('{'),b=t.lastIndexOf('}');
  if(a<0||b<=a)throw Error('JSONがありません');
  const o=JSON.parse(t.slice(a,b+1));
  const have=new Set(input.indicators.filter(x=>x.value!=null).map(x=>x.no));
  const sec=(name)=>{
    const arr=o[name];
    if(!Array.isArray(arr)||arr.length<1||arr.length>4)throw Error(`${name} の項目数が不正`);
    return arr.map(x=>{
      const text=String(x?.text||'').trim();
      if(text.length<10||text.length>400)throw Error(`${name} の文章の長さが不正`);
      const ids=[...new Set((Array.isArray(x.indicators)?x.indicators:[]).map(Number))];
      if(!ids.length||ids.some(n=>!have.has(n)))throw Error(`${name} の根拠指標が不正`);
      return {text,indicators:ids};
    });
  };
  const headline=String(o.headline||'').trim();
  if(!headline||headline.length>60)throw Error('見出しが不正');
  return {headline,current:sec('current'),history:sec('history'),outlook:sec('outlook'),caveat:String(o.caveat||'').trim().slice(0,300)};
}

export async function generateFor(env,files,month,fetcher=fetch,now=new Date(),chosen=null){
  const input=buildInput(files,month);
  const {model,source}=chosen||await chooseModel(env,fetcher);
  const prompt=buildPrompt(input);
  let lastErr;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const res=await fetcher('https://api.anthropic.com/v1/messages',{method:'POST',headers:anthropicHeaders(env.ANTHROPIC_API_KEY),signal:AbortSignal.timeout(120000),
        body:JSON.stringify({model,max_tokens:2000,system:prompt.system,messages:[{role:'user',content:prompt.user}]})});
      if(!res.ok)throw Error(`messages HTTP ${res.status}`);
      const data=await res.json();
      const report=validateReport((data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join(''),input);
      return {month,generated_at:now.toISOString(),provider:'anthropic',model,model_source:source,fingerprint:fingerprint(input),report};
    }catch(e){lastErr=e;}
  }
  throw lastErr;
}

const safe=e=>String(e?.message||e).replace(/sk-ant-[A-Za-z0-9_\-]+/g,'[key]').slice(0,160);

// 直近 MAX_MONTHS か月のうち、未作成または新しい公表が入った月を新しい順に最大 maxCalls 件作る。
export async function runAnalysis(env,{fetcher=fetch,now=new Date(),maxCalls=2,bundle=null}={}){
  const status={checkedAt:now.toISOString(),generated:[],skipped:[],errors:[]};
  if(!env.ANTHROPIC_API_KEY){status.state='not_configured';await env.DATA.put('analysis-status',JSON.stringify(status));return status;}
  bundle=bundle||await env.DATA.get('current','json');
  if(!bundle){status.state='no_data';await env.DATA.put('analysis-status',JSON.stringify(status));return status;}
  const months=monthsOf(bundle.files).slice(-MAX_MONTHS).reverse();
  const todo=[];
  for(const m of months){
    const stored=await env.DATA.get(KEY(m),'json'),fp=fingerprint(buildInput(bundle.files,m));
    if(stored&&stored.fingerprint===fp)continue;
    const failed=await env.DATA.get(FAIL_KEY(m),'json');
    if(failed&&failed.fingerprint===fp&&now-Date.parse(failed.at)<FAILURE_COOLDOWN_MS){
      status.skipped.push({month:m,reason:'recent_failure',failedAt:failed.at});continue;
    }
    todo.push({m,stored,fp});
  }
  let chosen=null;
  for(const {m,stored,fp} of todo.slice(0,maxCalls)){
    try{
      chosen=chosen||await chooseModel(env,fetcher);
      const rec=await generateFor(env,bundle.files,m,fetcher,now,chosen);
      if(stored)await env.DATA.put(`analysis-archive:${m}:${stored.generated_at}`,JSON.stringify(stored));
      await env.DATA.put(KEY(m),JSON.stringify(rec));
      status.generated.push({month:m,model:rec.model});
    }catch(e){
      status.errors.push({month:m,error:safe(e)});
      await env.DATA.put(FAIL_KEY(m),JSON.stringify({fingerprint:fp,at:now.toISOString()}),{expirationTtl:2*24*60*60});
    }
  }
  status.pending=Math.max(0,todo.length-maxCalls);
  status.state=status.errors.length||status.skipped.length?'partial_failure':'ok';
  await env.DATA.put('analysis-status',JSON.stringify(status));
  return status;
}

// 表示用：その月の分析。無ければその月以前で最も新しい分析を、理由つきで返す。
export async function getAnalysis(env,month,bundle){
  if(!/^\d{4}-\d{2}$/.test(month||''))return {status:'bad_request'};
  const st=await env.DATA.get('analysis-status','json').catch(()=>null);
  let rec=await env.DATA.get(KEY(month),'json'),fallbackFrom=null;
  if(!rec&&bundle){
    for(const m of monthsOf(bundle.files).filter(m=>m<month).reverse().slice(0,MAX_MONTHS)){
      rec=await env.DATA.get(KEY(m),'json');if(rec){fallbackFrom=m;break;}
    }
  }
  const failed=st&&(st.errors?.some(e=>e.month===month)||st.skipped?.some(e=>e.month===month&&e.reason==='recent_failure'));
  if(!rec)return {status:'none',month,state:st?.state||'not_configured',failed:!!failed};
  const stale=!fallbackFrom&&bundle?rec.fingerprint!==fingerprint(buildInput(bundle.files,month)):false;
  return {status:'ok',month,shown_month:rec.month,fallback:!!fallbackFrom,stale,failed:!!failed,analysis:rec};
}
