import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyHandoff,followUpPrompt,prepareHandoff,revertHandoff,securePath,validateHandoff} from '../lib/handoff.mjs';
import {createApp} from '../server.mjs';

const response=value=>'```json\n'+JSON.stringify({format:'orbit-response-v1',summary:'Apply requested project changes',operations:value,verification:[['/bin/echo','verified']],followUpNeeded:true})+'\n```';

test('handoff preparation selects project text and flags likely secrets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orbit-handoff-'));
  try{await writeFile(join(dir,'app.js'),'export const token = "sk-abcdefghijklmnopqrstuvwxyz";\nexport function start() {}');await writeFile(join(dir,'notes.bin'),'\0binary');
    const prepared=await prepareHandoff({workspace:dir,task:'Update the app start function',attachments:[{name:'brief.txt',kind:'text',content:'Use the blue theme',size:18},{name:'reference.png',kind:'image',mime:'image/png',size:1024}]});assert.match(prepared.prompt,/FILE: app\.js/);assert.match(prepared.prompt,/Use the blue theme/);assert.match(prepared.prompt,/reference\.png/);assert.match(prepared.prompt,/orbit-response-v1/);assert.ok(prepared.warnings.some(w=>w.path==='app.js'));
    const excluded=await prepareHandoff({workspace:dir,task:'Update app',excluded:['app.js']});assert.doesNotMatch(excluded.prompt,/FILE: app\.js/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('handoff validation rejects traversal and classifies risky operations',()=>{
  assert.throws(()=>validateHandoff(response([{type:'write',path:'../escape.txt',content:'bad'}])),/escapes/);
  assert.throws(()=>validateHandoff('not json'),/valid JSON/);
  const plan=validateHandoff(response([{type:'write',path:'src/a.txt',content:'safe'},{type:'delete',path:'old.txt'},{type:'command',argv:['npm','install','left-pad']} ]));
  assert.equal(plan.operations[0].requiresApproval,false);assert.equal(plan.operations[1].risk,'file deletion');assert.equal(plan.operations[2].risk,'dependency installation');
});

test('handoff applies text operations and reverts snapshots',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orbit-apply-'));
  try{await writeFile(join(dir,'existing.txt'),'before value');
    const plan=validateHandoff(response([{type:'mkdir',path:'src'},{type:'write',path:'src/new.txt',content:'created'},{type:'replace',path:'existing.txt',search:'before',replace:'after'},{type:'command',argv:['/bin/echo','verified']} ]));
    const applied=await applyHandoff({workspace:dir,plan});assert.equal(await readFile(join(dir,'src/new.txt'),'utf8'),'created');assert.equal(await readFile(join(dir,'existing.txt'),'utf8'),'after value');assert.equal(applied.results.at(-1).code,0);
    await revertHandoff({workspace:dir,snapshots:applied.snapshots});assert.equal(await readFile(join(dir,'existing.txt'),'utf8'),'before value');await assert.rejects(readFile(join(dir,'src/new.txt'),'utf8'));
    assert.match(followUpPrompt({plan,results:applied.results}),/LOCAL EXECUTION RESULTS/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('workspace path validation rejects symlink escapes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'orbit-root-')),outside=await mkdtemp(join(tmpdir(),'orbit-out-'));
  try{await mkdir(join(outside,'nested'));await symlink(outside,join(root,'linked'));await assert.rejects(securePath(root,'linked/nested/file.txt'),/symlink/);await assert.rejects(securePath(root,'linked'),/symlink/);await assert.rejects(securePath(root,'.git/config'),/protected/);}
  finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('handoff cancellation stops a running command',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orbit-cancel-')),controller=new AbortController();
  try{
    const plan=validateHandoff(response([{type:'command',argv:['/bin/sleep','30'],timeoutMs:30000}]));
    setTimeout(()=>controller.abort(),100);
    await assert.rejects(applyHandoff({workspace:dir,plan,allowRisk:true,signal:controller.signal}),error=>error.name==='AbortError'&&/stopped/i.test(error.message));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('handoff HTTP flow validates, applies, follows up, and reverts',async t=>{
  const data=await mkdtemp(join(tmpdir(),'orbit-handoff-data-')),workspace=await mkdtemp(join(tmpdir(),'orbit-handoff-work-')),app=createApp({dataDir:data});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});await rm(workspace,{recursive:true,force:true});});
  const call=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const chat=app.store.create();let res=await call('/api/handoff/prepare',{workspace,task:'Create a hello file',chatId:chat.id,record:true});assert.equal(res.status,200);const prepared=await res.json();assert.match(prepared.prompt,/Create a hello file/);assert.equal(app.store.get(chat.id).messages.at(-1).meta.provider,'gemini');
  res=await call('/api/handoff/validate',{workspace,chatId:chat.id,prompt:prepared.prompt,rawResponse:'not json'});assert.equal(res.status,400);const repair=await res.json();assert.match(repair.repairPrompt,/orbit-response-v1/);await assert.rejects(readFile(join(workspace,'hello.txt'),'utf8'));
  res=await call('/api/handoff/validate',{workspace,chatId:chat.id,prompt:prepared.prompt,rawResponse:response([{type:'write',path:'hello.txt',content:'hello'}])});assert.equal(res.status,201);const validated=await res.json();
  res=await call('/api/handoff/apply',{taskId:validated.taskId});assert.equal(res.status,200);const stream=await res.text();assert.match(stream,/"type":"done"/);assert.equal(await readFile(join(workspace,'hello.txt'),'utf8'),'hello');assert.equal(app.store.get(chat.id).messages.at(-1).meta.provider,'gemini');
  res=await call('/api/handoff/follow-up',{taskId:validated.taskId});assert.match((await res.json()).prompt,/LOCAL EXECUTION RESULTS/);
  res=await call(`/api/tasks/${validated.taskId}/revert`,{});assert.equal(res.status,200);await assert.rejects(readFile(join(workspace,'hello.txt'),'utf8'));
});

test('Gemini project flow carries image metadata and imports generated assets',async t=>{
  const data=await mkdtemp(join(tmpdir(),'orbit-image-data-')),workspace=await mkdtemp(join(tmpdir(),'orbit-image-work-')),app=createApp({dataDir:data});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});await rm(workspace,{recursive:true,force:true});});
  const call=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const chat=app.store.create(),pixel='data:image/png;base64,iVBORw0KGgo=';
  let res=await call(`/api/chats/${chat.id}/documents`,{name:'reference.png',content:pixel});assert.equal(res.status,201);
  res=await call('/api/handoff/prepare',{workspace,task:'Use the reference image',chatId:chat.id});assert.equal(res.status,200);const prepared=await res.json();assert.equal(prepared.attachments[0].kind,'image');assert.match(prepared.prompt,/reference\.png/);
  res=await call('/api/workspace/assets',{workspace,name:'hero.png',path:'assets/hero.png',dataUrl:pixel});assert.equal(res.status,201);assert.equal((await res.json()).path,'assets/hero.png');assert.ok((await readFile(join(workspace,'assets/hero.png'))).length>0);
});
