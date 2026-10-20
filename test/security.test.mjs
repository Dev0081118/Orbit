import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import {createApp} from '../server.mjs';
import {DEFAULTS,buildContext,tokenEstimate} from '../lib/context.mjs';

test('markdown escapes hostile model output, code and table cells',async()=>{
  // Run the actual renderer functions without the browser bootstrap.
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const renderer=source.slice(source.indexOf('const escape='),source.indexOf('let settings,'))+'\nthis.renderMarkdown=markdown;';
  const sandbox={};vm.runInNewContext(renderer,sandbox);
  const html=sandbox.renderMarkdown('# <img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```\n\n| name | value |\n| --- | --- |\n| <svg/onload=alert(1)> | safe |');
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script'));assert.ok(!html.includes('<svg'));assert.match(html,/&lt;script&gt;/);assert.match(html,/<table>/);
});
test('context accounting remains bounded with sources, unicode and long instructions',()=>{
  for(const context of [4096,8192])for(const maxTokens of [512,1024,2048]){
    const settings={...DEFAULTS,context,maxTokens,instructions:'Be accurate. '.repeat(40),memory:'I prefer short answers.'};
    const result=buildContext([{role:'user',content:'What is the launch date? 你好'}],settings,[{id:'a',name:'notes.txt',content:('Launch date: November 23. '.repeat(500))}]);
    const actual=result.messages.reduce((n,m)=>n+tokenEstimate(m.content),0);
    assert.ok(actual<=context-maxTokens-220,`over budget at ${context}/${maxTokens}`);
  }
});
test('HTTP rejects malformed settings, host rebinding, and arbitrary static files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orbit-security-')),app=createApp({dataDir:dir});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
  try{
    for(const value of [null,[],42,'text']) {const r=await fetch(url+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(r.status,400);}
    for(const value of [{model:'other'},{context:99999999},{thinking:'yes'}]){const r=await fetch(url+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(r.status,400);}
    const status=await new Promise((resolve,reject)=>{http.get(url+'/api/settings',{headers:{Host:'attacker.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(status,403);
    assert.equal((await fetch(url+'/data/orbit.sqlite')).status,404);
    assert.equal((await fetch(url+'/server.mjs')).status,404);
    const s=await(await fetch(url+'/api/settings')).json();assert.deepEqual(s,DEFAULTS);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
