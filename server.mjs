import http from 'node:http';
import {mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname,basename} from 'node:path';
import os from 'node:os';
import {Store} from './lib/store.mjs';
import {MODELS,validateSettings,buildContext,ndjson} from './lib/context.mjs';
import {applyHandoff,followUpPrompt,prepareHandoff,revertHandoff,securePath,validateHandoff} from './lib/handoff.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export function createApp({dataDir=process.env.ORBIT_DATA_DIR||join(ROOT,'data'),ollama=process.env.ORBIT_OLLAMA_URL||'http://127.0.0.1:11435',fetcher=fetch}={}) {
  const store=new Store(dataDir);
  let busy=null,pulling=false,maintenance=false;
  const exportMaxBytes=64*1024*1024, exportMaxMessages=10000;
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  const fail=(message,status=400)=>Object.assign(new Error(message),{status});
  const modelFetch=(path,opts={})=>fetch(ollama+path,{...opts,signal:opts.signal||AbortSignal.timeout(4000)});
  const postModel=(path,body,signal)=>modelFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  async function body(req,maxBytes=2_000_000) {let size=0;const parts=[];for await(const b of req){size+=b.length;if(size>maxBytes)throw fail('Request exceeds the size limit.',413);parts.push(b);}const raw=Buffer.concat(parts).toString('utf8');try{const value=JSON.parse(raw||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw fail('A JSON object is required.');}}
  const stream=(res)=>{res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','X-Accel-Buffering':'no'});res.flushHeaders();return data=>{if(!res.destroyed)res.write(JSON.stringify(data)+'\n');};};
  const assertIdle=()=>{if(busy||pulling||maintenance)throw fail('A model operation is running. Stop it or wait for it to finish.',409);};
  async function workspacePath(value) {
    if(typeof value!=='string'||!value.trim()||value.length>1000)throw fail('Choose a project folder.');
    let path;try{path=await realpath(value.trim());const info=await stat(path);if(!info.isDirectory())throw new Error();}catch{throw fail('The selected workspace folder does not exist or is not accessible.');}
    if(path==='/'||['/System','/Library','/usr','/bin','/sbin','/etc'].some(root=>path===root||path.startsWith(root+'/')))throw fail('Choose a project folder instead of a system folder.');
    return path;
  }
  async function runChat(req,res,id,input) {
    assertIdle();
    const chat=store.get(id);if(!chat)throw fail('Chat not found.',404);
    const settings=store.settings();
    const tagResponse=await modelFetch('/api/tags').catch(()=>{throw fail('Local engine is offline. Launch Orbit with Launch.command.',503);});
    if(!tagResponse.ok)throw fail('Unable to read installed models.',503);
    const tags=await tagResponse.json();
    if(!tags.models?.some(m=>m.name===settings.model||m.model===settings.model))throw fail('Download the selected model in Settings before chatting.',409);
    let messages=chat.messages.slice(),truncateAt=null;
    if(input.regenerate) {
      const last=messages.at(-1);
      if(!last)throw fail('There is no reply to regenerate.');
      if(last.role==='assistant'){truncateAt=last.seq;messages.pop();}
      if(messages.at(-1)?.role!=='user')throw fail('There is no prompt to retry.');
    } else {
      if(typeof input.content!=='string'||!input.content.trim()||input.content.length>24000)throw fail('Enter a message of 1–24,000 characters.');
      if(input.editId) {
        const index=messages.findIndex(m=>m.id===input.editId&&m.role==='user');
        if(index<0)throw fail('Message to edit was not found.',404);
        truncateAt=messages[index].seq;messages=messages.slice(0,index);
      }
      messages.push({role:'user',content:input.content.trim()});
    }
    let context;try{context=buildContext(messages,settings,store.docs(id));}catch(e){throw fail(e.message);}
    // Recheck after asynchronous model inventory; simultaneous requests must not both enter.
    assertIdle();
    const controller=new AbortController();busy={chatId:id,controller};
    const timer=setTimeout(()=>controller.abort(new Error('Response timed out after five minutes.')),300000);
    let answer='',thinking='',meta={model:settings.model,sources:context.sources,omitted:context.omitted,status:'complete'},completed=false;
    let send;
    const start=performance.now();let firstToken=null;
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    res.on('close',disconnected);
    try {
      store.transaction(()=>{
        if(truncateAt!==null)store.truncate(id,truncateAt);
        if(!input.regenerate)store.add(id,'user',input.content.trim());
        if(chat.title==='New chat')store.rename(id,messages.find(m=>m.role==='user').content.slice(0,64));
      });
      send=stream(res);send({type:'start',context:{omitted:context.omitted,estimatedTokens:context.estimatedTokens,sources:context.sources},model:settings.model});
      let turnMessages=context.messages,continuations=0,totalTokens=0,totalEvalNs=0;
      do {
        completed=false;let reason=null;
        const upstream=await postModel('/api/chat',{model:settings.model,messages:turnMessages,stream:true,think:settings.thinking,keep_alive:'3m',options:{num_ctx:settings.context,num_predict:settings.maxTokens,temperature:settings.temperature,num_batch:128}},controller.signal);
        if(!upstream.ok){const e=await upstream.text();throw new Error(`Local model error: ${e.slice(0,300)}`);}
        for await(const frame of ndjson(upstream.body)) {
          if(frame.error)throw new Error(frame.error);
          const token=frame.message?.content||'',thought=frame.message?.thinking||'';
          if((token||thought)&&firstToken===null)firstToken=performance.now()-start;
          answer+=token;thinking+=thought;
          if(answer.length+thinking.length>200000)throw new Error('Response exceeded the size limit.');
          if(token||thought)send({type:'delta',content:token,thinking:thought});
          if(frame.done){completed=true;reason=frame.done_reason;totalTokens+=frame.eval_count||0;totalEvalNs+=frame.eval_duration||0;meta={...meta,tokens:totalTokens,tokensPerSecond:totalEvalNs?Number((totalTokens/(totalEvalNs/1e9)).toFixed(1)):0,firstTokenMs:Math.round(firstToken||0),elapsedMs:Math.round(performance.now()-start),promptTokens:frame.prompt_eval_count,reason,continuations};}
        }
        if(!completed)break;
        if(reason==='length'&&continuations<2){continuations++;send({type:'status',message:`Continuing automatically (${continuations}/2)…`});turnMessages=[...context.messages,{role:'assistant',content:answer},{role:'user',content:'Continue exactly where you stopped. Do not repeat earlier text. Finish the answer.'}];}
        else break;
      } while(true);
      if(!completed)throw new Error('Model stream ended before completion. You can retry the reply.');
      if(!answer.trim())throw new Error('The model produced no final answer within the response limit. Turn off Think or increase the response limit.');
    } catch(e) {
      meta={...meta,status:controller.signal.aborted?'stopped':'error',error:controller.signal.aborted?'Generation stopped.':e.message};
      if(send)send({type:'error',message:meta.error});
      else throw e;
    } finally {
      clearTimeout(timer);res.off('close',disconnected);
      if(send){const mid=store.add(id,'assistant',answer,thinking,meta);send({type:'done',id:mid,meta});res.end();}
      busy=null;
    }
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    try {
      const host=req.headers.host||'';
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host))throw fail('Invalid host.',403);
      if(req.headers.origin && req.headers.origin!==`http://${host}`)throw fail('Cross-origin access denied.',403);
      if(!['GET','HEAD'].includes(req.method)&&!req.headers['content-type']?.startsWith('application/json'))throw fail('JSON requests required.',415);
      const url=new URL(req.url,`http://${host}`),p=url.pathname;
      if(p==='/api/health'&&req.method==='GET') {
        let available=false,models=[],loaded=[],version=null,error=null;
        try{const [t,ps,v]=await Promise.all([modelFetch('/api/tags'),modelFetch('/api/ps'),modelFetch('/api/version')]);if(!t.ok)throw new Error('Engine unavailable');models=(await t.json()).models||[];loaded=ps.ok?(await ps.json()).models||[]:[];version=v.ok?(await v.json()).version:null;available=true;}catch{error='Local engine is offline. Start with Launch.command.';}
        return json(res,{app:'orbit-local',available,error,models,loaded,version,busy:busy?.chatId||(maintenance?'maintenance':null),busyKind:busy?.kind||null,pulling,hardware:{arch:os.arch(),memoryGB:Math.round(os.totalmem()/2**30)},catalog:MODELS,workspace:store.preference('workspace',null)});
      }
      if(p==='/api/workspace') {if(req.method==='GET')return json(res,{path:store.preference('workspace',null)});if(req.method==='PUT'){assertIdle();const value=await workspacePath((await body(req)).path);store.savePreference('workspace',value);return json(res,{path:value});}}
      if(p==='/api/handoff/prepare'&&req.method==='POST') {
        assertIdle();const b=await body(req);const workspace=await workspacePath(b.workspace||store.preference('workspace',''));
        const handoffProvider=['gemini','chatgpt'].includes(b.provider)?b.provider:null;if(!handoffProvider)throw fail('Choose Gemini Free or ChatGPT Free.');
        if(b.chatId&&!store.get(b.chatId))throw fail('Chat not found.',404);const documents=b.chatId?store.docs(b.chatId):[];
        const attachments=documents.map(d=>d.content.startsWith('data:image/')?{name:d.name,kind:'image',mime:d.content.slice(5,d.content.indexOf(';')),size:Buffer.byteLength(d.content)}:{name:d.name,kind:'text',mime:'text/plain',size:Buffer.byteLength(d.content),content:d.content});
        const prepared=await prepareHandoff({workspace,task:b.task,excluded:Array.isArray(b.excluded)?b.excluded.slice(0,100):[],attachments,provider:handoffProvider});
        if(b.record&&b.chatId){const current=store.get(b.chatId);store.add(b.chatId,'user',b.task,'',{provider:handoffProvider});if(current.title==='New chat')store.rename(b.chatId,String(b.task).trim().slice(0,64));}
        return json(res,prepared);
      }
      if(p==='/api/handoff/validate'&&req.method==='POST') {
        assertIdle();const b=await body(req,2_500_000),workspace=await workspacePath(b.workspace||store.preference('workspace',''));let plan;
        const handoffProvider=['gemini','chatgpt'].includes(b.provider)?b.provider:null;if(!handoffProvider)throw fail('Choose Gemini Free or ChatGPT Free.');const service=handoffProvider==='chatgpt'?'ChatGPT':'Gemini';
        try{plan=validateHandoff(b.rawResponse);plan.provider=handoffProvider;}catch(e){return json(res,{error:e.message,repairPrompt:`Your previous ${service} response could not be imported into Orbit: ${e.message}\n\nReturn the same intended changes again as exactly one valid JSON object in a fenced \`\`\`json block. Use format \"orbit-response-v1\", an operations array containing only mkdir, write, replace, delete, or command operations, verification as arrays of executable-plus-arguments, and followUpNeeded as a boolean. Do not include prose outside the JSON block.`},400);}
        if(b.chatId&&!store.get(b.chatId))throw fail('Chat not found.',404);
        const task=store.createHandoff({chatId:b.chatId||null,workspace,prompt:typeof b.prompt==='string'?b.prompt.slice(0,200_000):'',rawResponse:b.rawResponse,plan});
        return json(res,{taskId:task.id,provider:handoffProvider,summary:plan.summary,operations:plan.operations.map(op=>({...op,content:undefined,search:undefined,replace:undefined})),verification:plan.verification,requiresApproval:[...plan.operations,...plan.verification].some(op=>op.requiresApproval),followUpNeeded:plan.followUpNeeded},201);
      }
      if(p==='/api/handoff/apply'&&req.method==='POST') {
        const b=await body(req),task=store.handoff(b.taskId);assertIdle();if(!task)throw fail('Handoff task not found.',404);if(!['validated','failed'].includes(task.status))throw fail('This handoff task cannot be applied again.',409);
        const workspace=await workspacePath(task.workspace),controller=new AbortController();busy={chatId:task.chat_id||task.id,controller,kind:'handoff'};const send=stream(res),onClose=()=>{if(!res.writableEnded)controller.abort();},requiresApproval=[...task.plan.operations,...task.plan.verification].some(op=>op.requiresApproval);res.on('close',onClose);send({type:'context',taskId:task.id,workspace,fileCount:new Set(task.plan.operations.filter(op=>op.path).map(op=>op.path)).size});send({type:'validation',taskId:task.id,summary:task.plan.summary});send({type:'approval',required:requiresApproval,granted:!requiresApproval||b.approveRisks===true});store.updateHandoff(task.id,{status:'applying',error:''});
        try{const applied=await applyHandoff({workspace,plan:task.plan,allowRisk:b.approveRisks===true,onEvent:send,signal:controller.signal});const saved=store.updateHandoff(task.id,{...applied,status:'complete'}),handoffProvider=task.plan.provider==='chatgpt'?'chatgpt':'gemini',service=handoffProvider==='chatgpt'?'ChatGPT':'Gemini';if(task.chat_id)store.add(task.chat_id,'assistant',task.plan.summary,'',{provider:handoffProvider,taskId:task.id,workspace,changes:applied.changes,status:'complete',activity:`${service} task applied and verified locally`});send({type:'done',taskId:task.id,status:'complete',provider:handoffProvider,changes:applied.changes,followUpNeeded:task.plan.followUpNeeded,canRevert:applied.snapshots.length>0,results:saved.results});}
        catch(e){const partial=e.partial||{snapshots:[],results:[],changes:[]};store.updateHandoff(task.id,{...partial,status:'failed',error:e.message});if(!res.destroyed){send({type:'error',message:e.message});send({type:'done',taskId:task.id,status:'failed',changes:partial.changes,canRevert:partial.snapshots.length>0});}}finally{res.off('close',onClose);busy=null;if(!res.writableEnded)res.end();}return;
      }
      if(p==='/api/handoff/follow-up'&&req.method==='POST') {const b=await body(req),task=store.handoff(b.taskId);if(!task)throw fail('Handoff task not found.',404);return json(res,{taskId:task.id,prompt:followUpPrompt(task)});}
      if(p==='/api/workspace/assets'&&req.method==='POST') {assertIdle();const b=await body(req,12_000_000),workspace=await workspacePath(b.workspace||store.preference('workspace',''));if(typeof b.dataUrl!=='string'||!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(b.dataUrl))throw fail('Choose a PNG, JPEG, WebP, or GIF image.');const bytes=Buffer.from(b.dataUrl.slice(b.dataUrl.indexOf(',')+1),'base64');if(!bytes.length||bytes.length>8_000_000)throw fail('Images must be under 8 MB.');const fallback=`assets/generated/${basename(String(b.name||'generated-image.png')).replace(/[^a-zA-Z0-9._-]/g,'-')}`,path=typeof b.path==='string'&&b.path.trim()?b.path.trim():fallback,target=await securePath(workspace,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{mode:0o600});return json(res,{path,size:bytes.length,kind:{type:'created'}},201);}
      const revertMatch=p.match(/^\/api\/tasks\/([\w-]+)\/revert$/);
      if(revertMatch&&req.method==='POST') {assertIdle();const task=store.handoff(revertMatch[1]);if(!task)throw fail('Handoff task not found.',404);if(!task.snapshots.length)throw fail('This task has no saved file changes.',409);if(task.status==='reverted')throw fail('This task was already reverted.',409);const changes=await revertHandoff({workspace:await workspacePath(task.workspace),snapshots:task.snapshots});store.updateHandoff(task.id,{status:'reverted'});return json(res,{taskId:task.id,status:'reverted',changes});}
      if(p==='/api/settings'){if(req.method==='GET')return json(res,store.settings());if(req.method==='PUT'){const b=await body(req);assertIdle();let s;try{s=validateSettings(b);}catch(e){throw fail(e.message);}return json(res,store.saveSettings(s));}}
      if(p==='/api/chats'&&req.method==='GET')return json(res,store.list((url.searchParams.get('q')||'').slice(0,200)));
      if(p==='/api/chats'&&req.method==='POST'){assertIdle();return json(res,store.create(),201);}
      if(p==='/api/import'&&req.method==='POST') {
        const b=await body(req,exportMaxBytes);assertIdle();
        if(b.format!=='orbit-local-v1'||!Array.isArray(b.messages)||b.messages.length>exportMaxMessages)throw fail('Choose an Orbit chat export (up to 10,000 messages / 64 MB).');
        if(typeof b.title!=='string'||!b.title.trim()||b.title.length>200)throw fail('Invalid imported title.');
        for(const [i,m] of b.messages.entries())if(m.role!==(i%2?'assistant':'user')||typeof m.content!=='string'||m.content.length>200000)throw fail('Invalid message sequence in export.');
        if(!Array.isArray(b.documents)||b.documents.length>12||b.documents.some(d=>{if(typeof d.name!=='string'||d.name.length>200||typeof d.content!=='string')return true;const image=/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(d.content);return Buffer.byteLength(d.content)>(image?7_000_000:200_000);} ))throw fail('Invalid documents in export.');
        const c=store.transaction(()=>{const c=store.create(b.title);for(const m of b.messages)store.add(c.id,m.role,m.content);for(const d of b.documents)store.addDoc(c.id,d.name,d.content);return store.get(c.id);});return json(res,c,201);
      }
      if(p==='/api/models/pull'&&req.method==='POST') {
        const b=await body(req);assertIdle();if(!MODELS[b.model])throw fail('Unsupported model.');
        pulling=true;const controller=new AbortController();const send=stream(res);
        const onClose=()=>{if(!res.writableEnded)controller.abort();};res.on('close',onClose);
        try{const upstream=await postModel('/api/pull',{model:b.model,stream:true},controller.signal);if(!upstream.ok)throw new Error('Model download failed. Check internet access.');let success=false;for await(const frame of ndjson(upstream.body)){send(frame);if(frame.error)throw new Error(frame.error);if(frame.status==='success')success=true;}if(!success)throw new Error('Download ended before verification. Retry to resume.');}
        catch(e){send({error:e.message});}finally{pulling=false;res.off('close',onClose);res.end();}return;
      }
      if(p==='/api/models/unload'&&req.method==='POST') {
        assertIdle();maintenance=true;
        try{const models=(await (await modelFetch('/api/ps')).json()).models||[];
          for(const m of models){const r=await postModel('/api/generate',{model:m.name,keep_alive:0},AbortSignal.timeout(30000));if(!r.ok)throw fail('Could not unload the model.',502);}return json(res,{ok:true});
        }finally{maintenance=false;}
      }
      const match=p.match(/^\/api\/chats\/([\w-]+)(?:\/(generate|export|documents)(?:\/([\w-]+))?)?$/);
      if(match) {
        const [,id,action,docId]=match;const chat=store.get(id);if(!chat)throw fail('Chat not found.',404);
        if(!action) {
          if(req.method==='GET')return json(res,chat);
          if(req.method==='PATCH'){const b=await body(req);assertIdle();if(typeof b.title!=='string'||!b.title.trim()||b.title.length>200)throw fail('Enter a title up to 200 characters.');store.rename(id,b.title.trim());return json(res,store.get(id));}
          if(req.method==='DELETE'){assertIdle();store.delete(id);return json(res,{ok:true});}
        }
        if(action==='export'&&req.method==='GET'){
          const data={format:'orbit-local-v1',title:chat.title,messages:chat.messages.map(({role,content})=>({role,content})),documents:store.docs(id).map(({name,content})=>({name,content}))};
          if(data.messages.length>exportMaxMessages||Buffer.byteLength(JSON.stringify(data))>exportMaxBytes)throw fail('This chat exceeds the portable export limit (10,000 messages / 64 MB). Back up the data folder with Orbit stopped instead.',413);
          return json(res,data);
        }
        if(action==='generate'&&req.method==='POST'){const input=await body(req);if(input.provider&&input.provider!=='local')throw fail('Project tasks use the reviewed handoff endpoints.',400);return await runChat(req,res,id,input);}
        if(action==='documents'){
          if(req.method==='POST'){const b=await body(req,8_000_000);assertIdle();const image=typeof b.content==='string'&&/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(b.content),limit=image?7_000_000:200_000;if(typeof b.name!=='string'||b.name.length>200||typeof b.content!=='string'||!b.content.trim()||(!image&&b.content.includes('\0'))||Buffer.byteLength(b.content)>limit)throw fail(image?'Attach an image under 5 MB.':'Attach a text document up to 200 KB.');if(chat.documents.length>=12)throw fail('Maximum 12 attachments per chat.');store.addDoc(id,b.name,b.content);return json(res,store.get(id),201);}
          if(req.method==='DELETE'&&docId){assertIdle();store.deleteDoc(id,docId);return json(res,store.get(id));}
        }
      }
      const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/file-launch.js':['file-launch.js','text/javascript'],'/style.css':['style.css','text/css'],'/mark.svg':['mark.svg','image/svg+xml']};
      if(assets[p]&&['GET','HEAD'].includes(req.method)){const [name,type]=assets[p];const data=await readFile(join(ROOT,'public',name));res.writeHead(200,{'Content-Type':type});return res.end(req.method==='HEAD'?undefined:data);}
      throw fail('Not found.',404);
    }catch(e){if(!res.headersSent)json(res,{error:e.status?e.message:(e.cause?.code==='ECONNREFUSED'?'Local engine is offline.':'Operation failed: '+e.message)},e.status||500);else res.end();}
  });
  return {server,store,close:async()=>{busy?.controller.abort();await new Promise(r=>server.close(r));store.close();}};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL('file://'+process.argv[1]))) {
  const app=createApp();const port=Number(process.env.PORT||3210);
  app.server.listen(port,'127.0.0.1',()=>console.log(`Orbit Local: http://127.0.0.1:${port}`));
  app.server.on('error',e=>{console.error(e.message);process.exitCode=1;});
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}
