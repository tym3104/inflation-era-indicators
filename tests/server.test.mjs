// ローカル開発用サーバー（scripts/server.py）の配信範囲とCSRF対策の回帰テスト。
// 一時ディレクトリにダミーの .env / .git を置き、外部から読めないことを確かめる（実キーは使わない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const python=['python3','python'].find(c=>spawnSync(c,['--version']).status===0);
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const DUMMY='dummy-fred-value-not-a-key';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'econ-server-'));
 const put=async(p,c)=>{await mkdir(join(dir,p,'..'),{recursive:true});await writeFile(join(dir,p),c);};
 await mkdir(join(dir,'scripts'));
 for(const f of ['server.py','generate_analysis.py'])await copyFile(join(scripts,f),join(dir,'scripts',f));
 await put('.env',`FRED_API_KEY=${DUMMY}\n`);
 await put('.git/config','[core]\n');
 await put('.claude/settings.json','{}');
 await put('web/index.html','<!doctype html><title>dash</title>');
 await put('web/app.js','console.log(1)');
 await put('web/foundation/foundation.css','body{}');
 await put('web/.hidden','x');
 await put('data/manifest.json','{"mode":"fred"}');
 await put('data/analysis/2026-09.json','{"month":"2026-09"}');
 await put('data/analysis/latest.json','{"month":"latest"}');
 await put('config/events.json','{"events":[]}');
 await put('outside/secret.json','{"leak":true}');
 return dir;
}

async function start(dir,args=[]){
 const port=20000+Math.floor(Math.random()*20000);
 const env={...process.env};delete env.ANTHROPIC_API_KEY;
 const proc=spawn(python,['-u',join(dir,'scripts','server.py'),String(port),...args],{env,stdio:['ignore','pipe','pipe']});
 await new Promise((ok,ng)=>{const t=setTimeout(()=>{proc.kill();ng(Error('server did not start'));},10000);proc.stdout.on('data',d=>{if(String(d).includes('Ctrl+C')){clearTimeout(t);ok();}});proc.on('exit',c=>ng(Error('exit '+c)));});
 return {port,proc};
}
// fetch は URL を正規化してしまうので、生のパスを送るため http.request を使う
import http from 'node:http';
function req(port,path,{method='GET',headers={}}={}){
 return new Promise((ok,ng)=>{const r=http.request({host:'127.0.0.1',port,path,method,headers:{Host:`localhost:${port}`,...headers}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>ok({status:res.statusCode,body:b}));});r.on('error',ng);r.end();});
}

for(const mode of [[],['--public']]){
 test(`server.py ${mode[0]||'local'}: only web/, data/, config/ are served; .env, .git and traversal are refused`,{skip:!python&&'python not installed'},async()=>{
  const dir=await fixture();const {port,proc}=await start(dir,mode);
  try{
   for(const p of ['/web/','/app.js','/foundation/foundation.css','/data/manifest.json','/config/events.json','/api/analysis?month=2026-09','/api/analysis'])
    assert.equal((await req(port,p)).status,200,p);
   const evil=['/.env','/%2eenv','/%2Eenv','/.git/config','/%2egit/config','/%73cripts/server.py','/scripts/server.py','/.claude/settings.json',
    '/web/.hidden','/web/%2e%2e/.env','/data/%2e%2e/.env','/..%2f.env','/web/..%2f..%2f.env','/%2e%2e/%2e%2e/etc/passwd','/data/','/web/foundation/',
    '/outside/secret.json','/%252eenv','/%ff','/web\\..\\.env'];
   for(const p of evil){const r=await req(port,p);assert.notEqual(r.status,200,p);assert(!r.body.includes(DUMMY)&&!r.body.includes('[core]')&&!r.body.includes('leak'),p);}
   for(const m of ['../outside/secret','../../outside/secret','..%2F..%2Foutside%2Fsecret','2026-9','latest','2026-09.json']){
    const r=await req(port,`/api/analysis?month=${m}`);assert.notEqual(r.status,200,m);assert(!r.body.includes('leak'),m);
   }
  }finally{proc.kill();await rm(dir,{recursive:true,force:true});}
 });
}

