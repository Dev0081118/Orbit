import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server.mjs';
import {DEFAULTS} from '../lib/context.mjs';
const listen=s=>new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${s.address().port}`));});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,handler=(_req,res)=>res.end('{}')){
 const dir=await mkdtemp(join(tmpdir(),'orbit-regression-'));const mock=http.createServer(handler);const upstream=await listen(mock);
 const app=createApp({dataDir:dir,ollama:upstream});const base=await listen(app.server);
 t.after(async()=>{await app.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});});
 const call=(path,method='GET',data)=>fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
 return {app,base,call};
}
test('export/import restores a chat over 2 MB and over 500 messages',async t=>{
 const {app,call}=await fixture(t);const original=app.store.create('Large backup');
 app.store.transaction(()=>{for(let i=0;i<502;i++)app.store.add(original.id,i%2?'assistant':'user',`message ${i} — 你好`);for(let i=0;i<12;i++)app.store.addDoc(original.id,`document-${i}.txt`,`${i}:`+'x'.repeat(199997));});
 const response=await call(`/api/chats/${original.id}/export`);assert.equal(response.status,200);const raw=await response.text();assert.ok(Buffer.byteLength(raw)>2_000_000);
 const payload=JSON.parse(raw);const imported=await call('/api/import','POST',payload);assert.equal(imported.status,201);const restored=await imported.json();assert.notEqual(restored.id,original.id);assert.equal(restored.messages.length,502);assert.equal(restored.documents.length,12);
 const again=await call(`/api/chats/${restored.id}/export`);assert.equal(again.status,200);assert.deepEqual(await again.json(),payload);
});
test('unload reserves exclusive access while model inventory is delayed',async t=>{
 const entered=deferred(),release=deferred(),paths=[];
 const {app,call}=await fixture(t,async(req,res)=>{paths.push(req.url);if(req.url==='/api/ps'){entered.resolve();await release.promise;res.end(JSON.stringify({models:[{name:DEFAULTS.model}]}));return;}res.end('{}');});
 const chat=app.store.create();const unloading=call('/api/models/unload','POST',{});
 try{await entered.promise;const generate=await call(`/api/chats/${chat.id}/generate`,'POST',{content:'Do not reach inference'});assert.equal(generate.status,409);await generate.text();const pull=await call('/api/models/pull','POST',{model:DEFAULTS.model});assert.equal(pull.status,409);await pull.text();assert.deepEqual(paths,['/api/ps']);}finally{release.resolve();}
 const finished=await unloading;assert.equal(finished.status,200);await finished.text();assert.deepEqual(paths,['/api/ps','/api/generate']);const available=await call('/api/chats','POST',{});assert.equal(available.status,201);await available.text();
});
test('JSON request preserves a Unicode character split across network writes',async t=>{
 const {app,base,call}=await fixture(t);const chat=app.store.create(),title='Before 💫 你好 after';const bytes=Buffer.from(JSON.stringify({title})),split=bytes.indexOf(Buffer.from('💫'))+2;
 const result=await new Promise((resolve,reject)=>{const req=http.request(base+`/api/chats/${chat.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'}},res=>{let body='';res.setEncoding('utf8');res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.flushHeaders();req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),30);});
 assert.equal(result.status,200);assert.equal(result.body.title,title);const saved=await call(`/api/chats/${chat.id}`);assert.equal((await saved.json()).title,title);
});
test('rapid repeated send while chat creation awaits creates only one chat',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('async function sendMessage('),end=source.indexOf('\nfunction askAction',start);assert.ok(start>=0&&end>start);
 const creation=deferred();let createCalls=0,fetchCalls=0;const node={value:'hello',textContent:'',focus(){}};
 const sandbox={busy:false,chat:null,aborter:null,editId:null,paintTimer:null,settings:{thinking:false},AbortController,setTimeout,clearTimeout,$:()=>node,localStorage:{setItem(){}},setBusy(value){sandbox.busy=value;},toast(){},render(){},scrollDown(){},refreshList:async()=>{},refreshHealth(){},api:async(path)=>{if(path==='/api/chats'){createCalls++;await creation.promise;return {id:'one',messages:[]};}if(path==='/api/health')return {busy:null};return {id:'one',messages:[]};},fetch:async()=>{fetchCalls++;return {ok:false,json:async()=>({error:'Intentional mock failure; no inference'})};}};
 vm.createContext(sandbox);vm.runInContext(source.slice(start,end),sandbox);const first=sandbox.sendMessage();await sandbox.sendMessage();assert.equal(createCalls,1);assert.equal(sandbox.busy,true);creation.resolve();await first;assert.equal(createCalls,1);assert.equal(fetchCalls,1);assert.equal(sandbox.busy,false);
});
