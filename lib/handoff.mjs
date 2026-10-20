import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {access,lstat,mkdir,readFile,readdir,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,normalize,relative,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';

const ignored=new Set(['.git','node_modules','data','.next','dist','build','coverage','.cache','.venv','venv','target']);
const protectedSegments=new Set(['.git','.hg','.svn','node_modules','.orbit-cache']);
const textExt=/\.(?:txt|md|mdx|json|jsonc|ya?ml|toml|ini|env\.example|[cm]?[jt]sx?|py|rb|php|html?|css|scss|less|swift|rs|go|java|kt|kts|c|cc|cpp|h|hpp|sh|zsh|fish|sql|graphql|prisma|vue|svelte)$/i;
const secretRules=[
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['API key',/(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}/i],
  ['OpenAI key',/\bsk-[A-Za-z0-9_-]{16,}\b/],
  ['AWS key',/\bAKIA[A-Z0-9]{16}\b/],
  ['GitHub token',/\bgh[pousr]_[A-Za-z0-9]{20,}\b/]
];
const maxPromptBytes=180_000,maxFileBytes=1_000_000,maxOperations=200,maxOutputBytes=1_000_000;

function words(value){return new Set((value.toLowerCase().match(/[a-z0-9_./-]{3,}/g)||[]));}
function safeRelative(path){
  if(typeof path!=='string'||!path.trim()||path.includes('\0')||isAbsolute(path))throw new Error('Operation paths must be relative to the workspace.');
  const clean=normalize(path.trim());if(clean==='..'||clean.startsWith('..'+sep)||clean==='.'||clean.length>800)throw new Error('Operation path escapes the workspace.');if(clean.split(sep).some(part=>protectedSegments.has(part)))throw new Error('Operation path uses a protected workspace directory.');return clean;
}
async function existingAncestor(path){let value=path;while(true){try{return await realpath(value);}catch{const next=dirname(value);if(next===value)throw new Error('No accessible parent directory.');value=next;}}
}
export async function securePath(workspace,path,{mustExist=false}={}){
  const root=await realpath(workspace),rel=safeRelative(path),target=resolve(root,rel);
  if(target!==root&&!target.startsWith(root+sep))throw new Error('Operation path escapes the workspace.');
  const ancestor=await existingAncestor(mustExist?target:dirname(target));
  if(ancestor!==root&&!ancestor.startsWith(root+sep))throw new Error('A symlink points outside the workspace.');
  if(mustExist){const actual=await realpath(target);if(actual!==root&&!actual.startsWith(root+sep))throw new Error('A symlink points outside the workspace.');return actual;}
  try{if((await lstat(target)).isSymbolicLink())throw new Error('Operation target may not be a symlink.');}catch(e){if(e.code!=='ENOENT')throw e;}
  return target;
}

async function walk(root,dir=root,depth=0,out=[]){
  if(depth>5||out.length>=600)return out;
  let entries=[];try{entries=await readdir(dir,{withFileTypes:true});}catch{return out;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries){if(out.length>=600||ignored.has(entry.name)||entry.name.startsWith('.env'))continue;const full=join(dir,entry.name),rel=relative(root,full);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){out.push(rel+'/');await walk(root,full,depth+1,out);}else if(entry.isFile())out.push(rel);}
  return out;
}

export async function prepareHandoff({workspace,task,excluded=[],attachments=[],provider='gemini'}){
  if(typeof task!=='string'||!task.trim()||task.length>24_000)throw new Error('Enter a task up to 24,000 characters.');
  if(!['gemini','chatgpt'].includes(provider))throw new Error('Choose Gemini Free or ChatGPT Free.');
  const service=provider==='chatgpt'?'ChatGPT':'Gemini';
  const root=await realpath(workspace),tree=await walk(root),query=words(task),skip=new Set(excluded.map(safeRelative));
  const paths=tree.filter(path=>!path.endsWith('/')&&!skip.has(path)&&textExt.test(path)&&!/(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|.*\.min\.(?:js|css))$/i.test(path)).map(path=>{const nameWords=words(path);let score=0;for(const w of query)if(nameWords.has(w))score+=8;if(/(?:package\.json|readme|src\/.*(?:index|app|main)|server)/i.test(path))score+=2;return {path,score};}).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,160);
  const candidates=[];
  for(const item of paths){const path=item.path,full=await securePath(root,path,{mustExist:true});let info;try{info=await stat(full);}catch{continue;}if(info.size>200_000)continue;
    let content;try{content=await readFile(full,'utf8');}catch{continue;}if(content.includes('\0'))continue;
    const bodyWords=words(content.slice(0,30_000));let score=item.score;for(const w of query)if(bodyWords.has(w))score+=1;candidates.push({path,content,score});
  }
  candidates.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));let used=0;const files=[];
  for(const file of candidates){if(files.length>=10)break;const excerpt=file.content.slice(0,24_000);if(used+Buffer.byteLength(excerpt)>100_000)continue;used+=Buffer.byteLength(excerpt);files.push({path:file.path,content:excerpt,truncated:excerpt.length<file.content.length});}
  const warnings=[];for(const file of files)for(const [kind,rule] of secretRules)if(rule.test(file.content))warnings.push({path:file.path,kind});
  const schema={format:'orbit-response-v1',summary:'What you will change',operations:[{type:'mkdir',path:'relative/folder'},{type:'write',path:'relative/file.txt',content:'complete file content'},{type:'replace',path:'relative/file.txt',search:'exact existing text',replace:'replacement text'},{type:'delete',path:'relative/file.txt'},{type:'command',argv:['npm','test'],timeoutMs:120000}],verification:[['npm','test']],followUpNeeded:false};
  const sections=files.map(f=>`\n--- FILE: ${f.path}${f.truncated?' (excerpt)':''} ---\n${f.content}\n--- END FILE ---`).join('');
  const textAttachments=attachments.filter(a=>a.kind==='text').slice(0,6).map(a=>`\n--- ATTACHED: ${a.name} ---\n${a.content.slice(0,30_000)}\n--- END ATTACHMENT ---`).join('');
  const imageAttachments=attachments.filter(a=>a.kind==='image').slice(0,6);
  const imageNote=imageAttachments.length?`\n\nIMAGES THE USER WILL ATTACH IN ${service.toUpperCase()}:\n${imageAttachments.map(a=>`- ${a.name} (${a.mime})`).join('\n')}\nUse those images as visual requirements or source material when they appear with this prompt.`:'';
  let prompt=`Act as Orbit's senior project engineer. Inspect the supplied project evidence, plan a complete minimal implementation, and return operations that Orbit can safely apply on the user's Mac. Preserve the existing architecture and design language, avoid placeholders, include error handling, and add focused verification.\n\nReturn only one JSON object in a fenced \`\`\`json block. Do not include prose outside it. The object must follow this example schema:\n${JSON.stringify(schema,null,2)}\n\nRules:\n- Use only relative paths shown by the project tree or new paths inside the project.\n- Prefer exact replace operations for small edits and write for new or fully replaced files.\n- Commands must be executable-plus-argument arrays, never a shell string.\n- Include focused verification commands.\n- Set followUpNeeded to true when command output or another inspection round is needed.\n- Do not include secrets.\n- Keep the response below 1.5 MB.\n\nUSER TASK:\n${task.trim()}${imageNote}\n\nPROJECT: ${basename(root)}\nPROJECT TREE:\n${tree.slice(0,500).join('\n')}\n\nRELEVANT FILES:${sections||'\nNo readable source excerpts were selected.'}${textAttachments}`;
  if(Buffer.byteLength(prompt)>maxPromptBytes)prompt=prompt.slice(0,maxPromptBytes)+'\n[Context truncated by Orbit]';
  return {prompt,provider,files:files.map(({content,...f})=>f),warnings,attachments:attachments.slice(0,12).map(({content,...a})=>a),workspace:root,treeCount:tree.length};
}

function extractJSON(raw){
  if(typeof raw!=='string'||!raw.trim()||Buffer.byteLength(raw)>2_000_000)throw new Error('Paste an AI response up to 2 MB.');
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);const source=(fenced?.[1]||raw).trim();
  try{return JSON.parse(source);}catch{const start=source.indexOf('{'),end=source.lastIndexOf('}');if(start>=0&&end>start)try{return JSON.parse(source.slice(start,end+1));}catch{}throw new Error('The provider did not return valid JSON. Ask it to repair the response using the required orbit-response-v1 format.');}
}
function commandRisk(argv){
  const joined=argv.join(' ').toLowerCase(),exe=basename(argv[0]).toLowerCase();
  if(['sh','bash','zsh','fish','osascript','sudo'].includes(exe))return 'shell or elevated command';
  if(/\b(?:rm|rmdir|mv)\b/.test(joined)||/--force|-rf\b|reset\s+--hard|clean\s+-[a-z]*f/.test(joined))return 'destructive command';
  if(['curl','wget'].includes(exe)||/\b(?:clone|pull|fetch)\b/.test(joined))return 'network access';
  if(['npm','pnpm','yarn','bun','pip','pip3','gem','cargo'].includes(exe)&&/\b(?:install|add|update)\b/.test(joined))return 'dependency installation';
  if(['echo','pwd','true'].includes(exe))return null;
  if(exe==='git'&&['status','diff','log','show'].includes((argv[1]||'').toLowerCase()))return null;
  if(['npm','pnpm','yarn','bun'].includes(exe)&&['test','run','lint','typecheck'].includes((argv[1]||'').toLowerCase()))return null;
  if(exe==='go'&&argv[1]==='test'||exe==='cargo'&&['test','check','fmt','clippy'].includes(argv[1])||exe==='swift'&&argv[1]==='test')return null;
  return 'unrestricted command';
}
export function validateHandoff(raw){
  const value=extractJSON(raw);if(value.format!=='orbit-response-v1')throw new Error('Response format must be orbit-response-v1.');
  if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>10_000)throw new Error('Response needs a concise summary.');
  if(!Array.isArray(value.operations)||!value.operations.length||value.operations.length>maxOperations)throw new Error(`Response must contain 1–${maxOperations} operations.`);
  const operations=value.operations.map((op,index)=>{
    if(!op||typeof op!=='object'||Array.isArray(op))throw new Error(`Operation ${index+1} is invalid.`);const type=op.type;
    if(!['mkdir','write','replace','delete','command'].includes(type))throw new Error(`Operation ${index+1} has an unsupported type.`);
    if(type==='command'){
      if(!Array.isArray(op.argv)||!op.argv.length||op.argv.length>64||op.argv.some(v=>typeof v!=='string'||!v||v.length>10_000))throw new Error(`Command ${index+1} needs a valid argv array.`);
      const timeoutMs=Math.min(Math.max(Number(op.timeoutMs)||120_000,1000),300_000),risk=commandRisk(op.argv);return {type,argv:op.argv,timeoutMs,risk,requiresApproval:!!risk};
    }
    const path=safeRelative(op.path);if(type==='write'){if(typeof op.content!=='string'||Buffer.byteLength(op.content)>maxFileBytes)throw new Error(`Write ${index+1} exceeds the 1 MB file limit.`);return {type,path,content:op.content,requiresApproval:false};}
    if(type==='replace'){if(typeof op.search!=='string'||!op.search||typeof op.replace!=='string'||Buffer.byteLength(op.replace)>maxFileBytes)throw new Error(`Replace ${index+1} is invalid.`);return {type,path,search:op.search,replace:op.replace,requiresApproval:false};}
    return {type,path,requiresApproval:type==='delete',risk:type==='delete'?'file deletion':null};
  });
  const verification=(Array.isArray(value.verification)?value.verification:[]).slice(0,20).filter(v=>Array.isArray(v)&&v.length&&v.length<=64&&v.every(x=>typeof x==='string'&&x.length>0&&x.length<10_000)).map(argv=>{const risk=commandRisk(argv);return {argv,timeoutMs:120_000,risk,requiresApproval:!!risk};});
  return {format:'orbit-response-v1',summary:value.summary.trim(),operations,verification,followUpNeeded:!!value.followUpNeeded};
}

function abortError(partial){const error=new Error('Handoff stopped.');error.name='AbortError';if(partial)error.partial=partial;return error;}

async function runCommand(workspace,op,{allowRisk=false,onOutput=()=>{},signal}={}){
  if(op.requiresApproval&&!allowRisk)throw new Error(`Approval required for ${op.risk}.`);
  if(signal?.aborted)throw abortError();
  const profile=`(version 1)\n(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-write* (subpath ${JSON.stringify(workspace)}) (subpath "/private/tmp"))\n${allowRisk&&op.risk==='network access'?'(allow network*)':'(deny network*)'}\n(allow sysctl-read)\n(allow mach-lookup)`;
  const env={PATH:process.env.PATH||'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME||workspace,TMPDIR:'/private/tmp',CI:'1',NO_COLOR:'1',npm_config_cache:join(workspace,'.orbit-cache')};
  const launch=(executable,args,sandboxed)=>new Promise((resolvePromise,reject)=>{
    const child=spawn(executable,args,{cwd:workspace,env,stdio:['ignore','pipe','pipe']});let output='',killed=false,aborted=false;
    const add=chunk=>{if(output.length>=maxOutputBytes)return;const text=chunk.toString();output=(output+text).slice(0,maxOutputBytes);onOutput(text);};child.stdout.on('data',add);child.stderr.on('data',add);
    const timer=setTimeout(()=>{killed=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1500).unref();},op.timeoutMs);
    const onAbort=()=>{aborted=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1500).unref();};signal?.addEventListener('abort',onAbort,{once:true});
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);};
    child.once('error',e=>{cleanup();reject(e);});child.once('exit',(code,exitSignal)=>{cleanup();resolvePromise({argv:op.argv,code,signal:exitSignal,output,truncated:output.length>=maxOutputBytes,timedOut:killed,aborted,sandboxed});});
  });
  const result=await launch('/usr/bin/sandbox-exec',['-p',profile,'--',...op.argv],true);
  if(result.aborted)throw abortError();
  if(result.code===71&&/sandbox_apply: Operation not permitted/.test(result.output)){if(signal?.aborted)throw abortError();const fallback=await launch(op.argv[0],op.argv.slice(1),false);if(fallback.aborted)throw abortError();return fallback;}
  return result;
}

export async function applyHandoff({workspace,plan,allowRisk=false,onEvent=()=>{},signal}){
  const root=await realpath(workspace),snapshots=[],results=[],changes=[];
  for(let index=0;index<plan.operations.length;index++){
    if(signal?.aborted)throw abortError({snapshots,results,changes});
    const op=plan.operations[index];onEvent({type:'operation',index,total:plan.operations.length,operation:{...op,content:undefined,search:undefined,replace:undefined}});
    if(op.type==='command'){let result;try{result=await runCommand(root,op,{allowRisk,signal,onOutput:content=>onEvent({type:'command',index,content})});}catch(e){if(e.name==='AbortError')e.partial={snapshots,results,changes};throw e;}results.push({type:'command',...result});if(result.code!==0)throw Object.assign(new Error(`Command failed (${result.code??result.signal}): ${op.argv.join(' ')}`),{partial:{snapshots,results,changes}});continue;}
    const target=await securePath(root,op.path,{mustExist:op.type==='replace'||op.type==='delete'});let before=null,kind='file';try{const info=await lstat(target);kind=info.isDirectory()?'directory':'file';if(info.isFile()){if(info.size>maxFileBytes)throw new Error(`${op.path} exceeds the 1 MB snapshot limit.`);before=await readFile(target,'utf8');}}catch(e){if(e.code!=='ENOENT')throw e;}
    snapshots.push({path:op.path,existed:before!==null||kind==='directory',kind,content:before});
    if(op.type==='mkdir'){await mkdir(target,{recursive:true});changes.push({path:op.path,kind:{type:'created'}});}
    if(op.type==='write'){await mkdir(dirname(target),{recursive:true});const temp=target+`.orbit-${randomUUID()}.tmp`;await writeFile(temp,op.content,{encoding:'utf8',mode:0o600});await rename(temp,target);changes.push({path:op.path,kind:{type:before===null?'created':'updated'}});}
    if(op.type==='replace'){if(kind!=='file')throw new Error(`${op.path} is not a text file.`);const count=before.split(op.search).length-1;if(count!==1)throw new Error(`${op.path}: replace search must match exactly once; found ${count}.`);await writeFile(target,before.replace(op.search,op.replace),'utf8');changes.push({path:op.path,kind:{type:'updated'}});}
    if(op.type==='delete'){if(!allowRisk)throw Object.assign(new Error('Approval required for file deletion.'),{partial:{snapshots,results,changes}});if(kind==='directory')await rm(target,{recursive:false});else await rm(target);changes.push({path:op.path,kind:{type:'deleted'}});}
    results.push({type:op.type,path:op.path,status:'complete'});onEvent({type:'files',changes:[changes.at(-1)]});
  }
  for(let index=0;index<(plan.verification||[]).length;index++){
    if(signal?.aborted)throw abortError({snapshots,results,changes});
    const op=plan.verification[index];onEvent({type:'verification',index,total:plan.verification.length,argv:op.argv});let result;try{result=await runCommand(root,op,{allowRisk,signal,onOutput:content=>onEvent({type:'command',verification:true,index,content})});}catch(e){if(e.name==='AbortError')e.partial={snapshots,results,changes};throw e;}results.push({type:'verification',...result});if(result.code!==0)throw Object.assign(new Error(`Verification failed (${result.code??result.signal}): ${op.argv.join(' ')}`),{partial:{snapshots,results,changes}});
  }
  return {snapshots,results,changes};
}

export async function revertHandoff({workspace,snapshots,onEvent=()=>{}}){
  const root=await realpath(workspace),restored=[];
  for(const snap of [...snapshots].reverse()){
    const target=await securePath(root,snap.path);if(!snap.existed){await rm(target,{recursive:true,force:true});restored.push({path:snap.path,kind:{type:'deleted'}});continue;}
    if(snap.kind==='directory'){await mkdir(target,{recursive:true});restored.push({path:snap.path,kind:{type:'restored'}});continue;}
    await mkdir(dirname(target),{recursive:true});await writeFile(target,snap.content??'','utf8');restored.push({path:snap.path,kind:{type:'restored'}});
  }
  onEvent({type:'files',changes:restored});return restored;
}

export function followUpPrompt(task){
  const result=(task.results||[]).map(r=>r.type==='command'?`COMMAND: ${r.argv.join(' ')}\nEXIT: ${r.code}\nOUTPUT:\n${String(r.output||'').slice(-40_000)}`:`${r.type.toUpperCase()}: ${r.path} — ${r.status}`).join('\n\n');
  const service=task.plan?.provider==='chatgpt'?'ChatGPT':'Gemini';
  return `Continue the same Orbit project task in this ${service} conversation. Return only a corrected orbit-response-v1 JSON object.\n\nORIGINAL SUMMARY:\n${task.plan.summary}\n\nLOCAL EXECUTION RESULTS:\n${result||'No operations completed.'}\n\nAddress failures, finish remaining work, and include focused verification.`;
}
