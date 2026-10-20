import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ndjson} from '../lib/context.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url))),base=process.env.ORBIT_URL||'http://127.0.0.1:3210';
const request=async(path,method='GET',data)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const b=await r.json();if(!r.ok)throw new Error(b.error);return b;};
const health=await request('/api/health');if(health.busy||health.pulling)throw new Error('Wait until the engine is idle before benchmarking.');
const settings=await request('/api/settings');if(!health.models.some(m=>m.name===settings.model))throw new Error('Download the selected model first.');
const report={date:new Date().toISOString(),hardware:health.hardware,ollama:health.version,settings,model:health.models.find(m=>m.name===settings.model),cases:[]};
// Never retain personalization in an exported benchmark report.
delete report.settings.instructions;delete report.settings.memory;
const chat=await request('/api/chats','POST',{});let success=true;
async function run(name,content,expectation) {
  const started=performance.now();let first=null,answer='',final;
  const response=await fetch(base+`/api/chats/${chat.id}/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})});
  if(!response.ok)throw new Error((await response.json()).error);
  for await(const f of ndjson(response.body)){if(f.type==='delta'){if(first===null)first=performance.now()-started;answer+=f.content;}if(f.type==='done')final=f.meta;}
  const passed=final?.status==='complete'&&(!expectation||expectation.test(answer));success&&=passed;
  const result={name,passed,prompt:content,answer,firstEventMs:Math.round(first||0),wallMs:Math.round(performance.now()-started),...final};report.cases.push(result);console.log(`${name}: ${passed?'PASS':'FAIL'} · ${final?.tokensPerSecond} tok/s · first event ${result.firstEventMs} ms`);
}
try{
  await request('/api/models/unload','POST',{});
  await run('cold-model','In about 80 words, explain what quantization does to a local language model.');
  await run('warm-code','Write a short Python function is_prime(n), handling numbers below 2. Include code only.',/^\s*(?:```python\s*)?def is_prime[\s\S]*return[\s\S]*$/);
  await run('arithmetic','What is 17 multiplied by 23? Reply with the number only.',/^\s*391[.!]?\s*$/);
  await run('conversation-memory-set','For this test conversation only, remember that my project codename is Lantern47. Confirm briefly.');
  await run('conversation-memory-recall','What is the project codename I just gave you? Reply with the codename only.',/^\s*Lantern47[.!]?\s*$/i);
  await request(`/api/chats/${chat.id}/documents`,'POST',{name:'synthetic-project-notes.txt',content:'Project Finch uses the launch key Copper Finch. Its demonstration date is November 23. These are synthetic testing facts.'});
  await run('document-retrieval','According to synthetic-project-notes.txt, what is the launch key for Project Finch? Cite the source.',/Copper Finch/i);
  report.after=await request('/api/health');
  try{report.memoryPressure=execFileSync('/usr/bin/memory_pressure',['-Q'],{encoding:'utf8'}).trim();}catch{report.memoryPressure='Unavailable';}
  report.passed=success;
}finally{
  await request('/api/chats/'+chat.id,'DELETE',{});
  await mkdir(join(root,'docs'),{recursive:true});await writeFile(join(root,'docs','BENCHMARK.json'),JSON.stringify(report,null,2));
}
console.log('Saved docs/BENCHMARK.json');if(!success)process.exitCode=1;
