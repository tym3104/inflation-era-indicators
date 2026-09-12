import {enrich,refresh,config} from './data.mjs';
const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
const json=(value,status=200)=>Response.json(value,{status,headers:{...headers,'Cache-Control':'public, max-age=60'}});
export default {
  async fetch(request,env) {
    const url=new URL(request.url),path=url.pathname;
    if(!['GET','HEAD'].includes(request.method))return json({error:'閲覧専用です'},405);
    if(path==='/api/config')return json({can_generate:false,public:true});
    if(path==='/api/analysis')return json({error:'公開版はルールベースの整理を提供します'},404);
    if(path.startsWith('/api/'))return json({error:'Not found'},404);
    if(path==='/health')return json({status:'ok',service:'withawai-inflation',version:env.VERSION?.id??'local',can_generate:false});
    if(path==='/web/' || path==='/web/index.html')return Response.redirect(`${url.origin}/`,301);
    if(path==='/data/sp500_monthly.json')return json({series:[],source_url:'https://fred.stlouisfed.org/series/SP500',status:'external-link'});
    const key=path.match(/^\/data\/([a-z0-9_]+)\.json$/)?.[1];
    if(key && (key==='manifest'||config.indicators.some(i=>i.key===key))) {
      let bundle=null;try {bundle=await env.DATA.get('current','json');}catch{}
      if(bundle) {
        const payload=key==='manifest'?enrich(bundle.manifest):bundle.files[key];
        if(payload)return json(payload);
      }
      const res=await env.ASSETS.fetch(request);
      if(key==='manifest' && res.ok) {
        const m=enrich(await res.json());
        m.delivery_note='最終保存データを表示しています。';
        return json(m);
      }
      return res;
    }
    // Only compiled public assets are addressable. Repository files, private analyses and secrets are never uploaded.
    const response=await env.ASSETS.fetch(request);
    const out=new Response(response.body,response);
    for(const [name,value]of Object.entries(headers))out.headers.set(name,value);
    return out;
  },
  async scheduled(event,env,ctx) {
    ctx.waitUntil(refresh(env).catch(async error=>{
      // Store only sanitized error messages; never an upstream URL containing a key.
      await env.DATA.put('refresh-status',JSON.stringify({checkedAt:new Date().toISOString(),success:false,error:'FRED refresh failed; previous complete snapshot retained'}));
      console.error('FRED refresh failed; previous complete snapshot retained');
      throw Error('FRED refresh failed');
    }));
  }
};
