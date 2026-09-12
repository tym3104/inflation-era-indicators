import config from '../config/indicators.json' with {type:'json'};
export {config};
export function transform(raw, kind) {
  const points=raw.filter(p=>Number.isFinite(p.value)).sort((a,b)=>a.date.localeCompare(b.date));
  const byDate=new Map(points.map(p=>[p.date,p.value]));
  return points.flatMap((p,i)=>{
    const prev=points[i-1]; let value;
    if(kind==='level') value=p.value;
    else if(kind==='yoy_pct') { const old=byDate.get(`${Number(p.date.slice(0,4))-1}${p.date.slice(4)}`); if(old) value=(p.value/old-1)*100; }
    else if(prev) {
      const gap=(Number(p.date.slice(0,4))-Number(prev.date.slice(0,4)))*12+Number(p.date.slice(5,7))-Number(prev.date.slice(5,7));
      if(gap!==(kind==='qoq_annualized'?3:1)) return [];
      if(kind==='mom_change') value=p.value-prev.value;
      if(kind==='mom_pct' && prev.value) value=(p.value/prev.value-1)*100;
      if(kind==='qoq_annualized' && prev.value>0) value=((p.value/prev.value)**4-1)*100;
    }
    return Number.isFinite(value)?[{date:p.date,value:Math.round(value*1000)/1000}]:[];
  });
}
export function summarize(series) {
  const latest=series.at(-1),prev=series.at(-2); if(!latest)return null;
  const change=prev?Math.round((latest.value-prev.value)*1000)/1000:null;
  return {latest_value:latest.value,latest_date:latest.date,prev_value:prev?.value??null,change,direction:change>0?'up':change<0?'down':'flat'};
}
export function enrich(manifest) {
  return {...manifest,meta:config.meta,indicators:manifest.indicators.map(old=>{
    const def=config.indicators.find(i=>i.key===old.key);
    if(!def)throw Error('Unknown indicator');
    return {...old,...def,source_url:`https://fred.stlouisfed.org/series/${def.fred_id}`};
  })};
}
export async function refresh(env, fetcher=fetch, now=new Date()) {
  if(!env.FRED_API_KEY) throw Error('FRED_API_KEY is not configured');
  const generated_at=now.toISOString();
  const since=new Date(now);since.setUTCFullYear(since.getUTCFullYear()-11);
  const indicators=[], files={};
  // Sequential requests keep upstream load bounded. One KV write publishes the entire consistent bundle.
  for(const ind of config.indicators) {
    const url=new URL('https://api.stlouisfed.org/fred/series/observations');
    url.search=new URLSearchParams({series_id:ind.fred_id,api_key:env.FRED_API_KEY,file_type:'json',observation_start:since.toISOString().slice(0,10),sort_order:'asc'});
    const response=await fetcher(url,{signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw Error(`FRED ${ind.key}: HTTP ${response.status}`);
    const body=await response.json();
    if(!Array.isArray(body.observations))throw Error(`FRED ${ind.key}: invalid response`);
    const raw=body.observations.filter(p=>p.value!=='.' && p.value!==null && p.value!=='').map(p=>({date:p.date,value:Number(p.value)}));
    const series=transform(raw,ind.transform);
    if(series.length<2 || series.some(p=>!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || p.date>generated_at.slice(0,10)))throw Error(`FRED ${ind.key}: invalid series`);
    const summary=summarize(series);
    const age=Math.floor((now-new Date(summary.latest_date))/86400000);
    indicators.push({...ind,status:'ok',summary,spark:series.slice(-60).map(p=>p.value),source_url:`https://fred.stlouisfed.org/series/${ind.fred_id}`,...(age>180?{stale_days:age}:{})});
    files[ind.key]={key:ind.key,transform:ind.transform,transform_label:ind.transform_label,unit:ind.unit,source_url:`https://fred.stlouisfed.org/series/${ind.fred_id}`,generated_at,series};
  }
  const bundle={manifest:{generated_at,mode:'fred',meta:config.meta,indicators,sp500_status:'external-link'},files};
  await env.DATA.put('current',JSON.stringify(bundle));
  await env.DATA.put('refresh-status',JSON.stringify({checkedAt:generated_at,success:true}));
  return bundle;
}
