import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const data=process.env.ORBIT_DATA_DIR||join(root,'data');
mkdirSync(data,{recursive:true,mode:0o700});
const port=Number(process.env.PORT||3210), enginePort=11435;
const url=`http://127.0.0.1:${port}`;
async function probe(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(1000)});return r.ok?await r.json():null;}catch{return null;}}
if((await probe(url+'/api/health'))?.app==='orbit-local') {console.log(`Orbit is already running: ${url}`);if(process.env.ORBIT_NO_OPEN!=='1')spawn('open',[url]);process.exit(0);}
let engine=null,server=null,closing=false;
function stop(code=0){if(closing)return;closing=true;server?.kill('SIGTERM');engine?.kill('SIGTERM');setTimeout(()=>process.exit(code),700);}
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>stop());
if(!await probe(`http://127.0.0.1:${enginePort}/api/version`)) {
  const log=openSync(join(data,'engine.log'),'a',0o600);
  engine=spawn(process.env.ORBIT_OLLAMA_BIN||'ollama',['serve'],{env:{...process.env,PATH:`/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,OLLAMA_HOST:`127.0.0.1:${enginePort}`,OLLAMA_MODELS:join(data,'models'),OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_KV_CACHE_TYPE:'q8_0',OLLAMA_CONTEXT_LENGTH:'4096',OLLAMA_KEEP_ALIVE:'3m',OLLAMA_NO_CLOUD:'1'},stdio:['ignore',log,log]});
  closeSync(log);
  engine.on('error',e=>{console.error(`Cannot start Ollama: ${e.message}. Install Ollama from https://ollama.com/download`);stop(1);});
  engine.on('exit',code=>{if(!closing){console.error(`Ollama exited (${code}). See data/engine.log.`);stop(1);}});
  let ready=false;
  for(let i=0;i<60&&!closing;i++){if(await probe(`http://127.0.0.1:${enginePort}/api/version`)){ready=true;break;}await new Promise(r=>setTimeout(r,500));}
  if(!ready){console.error('Ollama did not become ready. See data/engine.log.');stop(1);}
}
if(!closing){
  server=spawn(process.execPath,[join(root,'server.mjs')],{cwd:root,env:{...process.env,ORBIT_DATA_DIR:data,PORT:String(port),ORBIT_OLLAMA_URL:`http://127.0.0.1:${enginePort}`},stdio:'inherit'});
  server.on('error',e=>{console.error(e.message);stop(1);});server.on('exit',code=>{if(!closing)stop(code||0);});
  let ready=false;for(let i=0;i<40&&!closing;i++){if((await probe(url+'/api/health'))?.app==='orbit-local'){ready=true;break;}await new Promise(r=>setTimeout(r,250));}
  if(ready){console.log('Keep this window open. Press Control-C to stop Orbit and its engine.');if(process.env.ORBIT_NO_OPEN!=='1')spawn('open',[url]);}else{console.error('Orbit did not become ready.');stop(1);}
}
