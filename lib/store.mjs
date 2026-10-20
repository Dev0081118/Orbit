import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULTS} from './context.mjs';
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(dir,'orbit.sqlite'));
    chmodSync(join(dir,'orbit.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,thinking TEXT NOT NULL DEFAULT '',meta TEXT NOT NULL DEFAULT '{}');
      CREATE INDEX IF NOT EXISTS message_chat ON messages(chat_id,seq);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,name TEXT NOT NULL,content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_threads(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,thread_id TEXT NOT NULL,cwd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS handoff_tasks(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,workspace TEXT NOT NULL,prompt TEXT NOT NULL DEFAULT '',raw_response TEXT NOT NULL DEFAULT '',plan TEXT NOT NULL DEFAULT '{}',results TEXT NOT NULL DEFAULT '[]',snapshots TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS handoff_chat ON handoff_tasks(chat_id,updated);`);
  }
  settings() {const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get('app');const s={...DEFAULTS,...(r?JSON.parse(r.value):{})};if(['qwen3:4b','qwen3:8b'].includes(s.model))s.model+='-q4_K_M';return s;}
  saveSettings(s) {this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('app',JSON.stringify(s));return s;}
  preference(key,fallback=null) {const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);if(!row)return fallback;try{return JSON.parse(row.value);}catch{return fallback;}}
  savePreference(key,value) {this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key,JSON.stringify(value));return value;}
  agentThread(chatId) {return this.db.prepare('SELECT thread_id AS threadId,cwd FROM agent_threads WHERE chat_id=?').get(chatId)||null;}
  saveAgentThread(chatId,threadId,cwd) {this.db.prepare('INSERT OR REPLACE INTO agent_threads VALUES (?,?,?)').run(chatId,threadId,cwd);return {threadId,cwd};}
  list(q='') {return this.db.prepare(`SELECT c.*,(SELECT count(*) FROM messages m WHERE m.chat_id=c.id) AS count FROM chats c WHERE c.title LIKE ? ESCAPE '!' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.id AND m.content LIKE ? ESCAPE '!') ORDER BY c.updated DESC LIMIT 200`).all(...Array(2).fill('%'+q.replace(/[!%_]/g,'!$&')+'%'));}
  create(title='New chat') {const now=Date.now(), id=randomUUID();this.db.prepare('INSERT INTO chats VALUES (?,?,?,?)').run(id,title,now,now);return this.get(id);}
  get(id) {const chat=this.db.prepare('SELECT * FROM chats WHERE id=?').get(id);if(!chat)return null;return {...chat,messages:this.db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY seq').all(id).map(m=>({...m,meta:JSON.parse(m.meta)})),documents:this.docs(id).map(({content,...d})=>({...d,size:Buffer.byteLength(content),kind:content.startsWith('data:image/')?'image':'text'}))};}
  rename(id,title) {this.db.prepare('UPDATE chats SET title=?,updated=? WHERE id=?').run(title,Date.now(),id);}
  delete(id) {this.db.prepare('DELETE FROM chats WHERE id=?').run(id);}
  add(id,role,content,thinking='',meta={}) {const seq=this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE chat_id=?').get(id).n;const mid=randomUUID();this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(mid,id,seq,role,content,thinking,JSON.stringify(meta));this.db.prepare('UPDATE chats SET updated=? WHERE id=?').run(Date.now(),id);return mid;}
  truncate(id,seq) {this.db.prepare('DELETE FROM messages WHERE chat_id=? AND seq>=?').run(id,seq);}
  docs(id) {return this.db.prepare('SELECT * FROM documents WHERE chat_id=?').all(id);}
  addDoc(chatId,name,content) {const id=randomUUID();this.db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run(id,chatId,name,content);return id;}
  deleteDoc(chatId,id) {this.db.prepare('DELETE FROM documents WHERE chat_id=? AND id=?').run(chatId,id);}
  createHandoff({chatId=null,workspace,prompt='',rawResponse='',plan={}}) {const id=randomUUID(),now=Date.now();this.db.prepare('INSERT INTO handoff_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,chatId,workspace,prompt,rawResponse,JSON.stringify(plan),JSON.stringify([]),JSON.stringify([]),'validated','',now,now);return this.handoff(id);}
  handoff(id) {const row=this.db.prepare('SELECT * FROM handoff_tasks WHERE id=?').get(id);return row?this.parseHandoff(row):null;}
  latestHandoff(chatId) {const row=this.db.prepare('SELECT * FROM handoff_tasks WHERE chat_id=? ORDER BY updated DESC LIMIT 1').get(chatId);return row?this.parseHandoff(row):null;}
  parseHandoff(row) {return {...row,rawResponse:row.raw_response,plan:JSON.parse(row.plan),results:JSON.parse(row.results),snapshots:JSON.parse(row.snapshots)};}
  updateHandoff(id,patch) {const current=this.handoff(id);if(!current)return null;const next={...current,...patch,updated:Date.now()};this.db.prepare('UPDATE handoff_tasks SET prompt=?,raw_response=?,plan=?,results=?,snapshots=?,status=?,error=?,updated=? WHERE id=?').run(next.prompt,next.rawResponse||'',JSON.stringify(next.plan||{}),JSON.stringify(next.results||[]),JSON.stringify(next.snapshots||[]),next.status,next.error||'',next.updated,id);return this.handoff(id);}
  transaction(fn) {this.db.exec('BEGIN');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
}
