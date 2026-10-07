import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { loadAutoDistillConfig, loadConfig, loadDistillConfig, saveConfig } from '../core/config.ts';
import { setTaskPref, listTaskPrefs } from '../core/prefs.ts';
import { searchTurns } from '../core/recall.ts';
import { rebuildPaths, listPaths } from '../core/trajectory.ts';
import { setPinned, setUnitStatus, updateUnit, listUnits } from '../core/units.ts';
import { exportStore } from '../core/portable.ts';
import { writeProfileSnapshot } from '../profile/build.ts';
import { activateSkill, draftSkill } from '../skills/build.ts';

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>mem UI</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--ok:#7ee787;--warn:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:16px;margin:0;font-weight:600}
nav button{background:none;border:1px solid transparent;color:var(--dim);padding:6px 10px;border-radius:6px;cursor:pointer}
nav button.active{color:var(--text);border-color:var(--line);background:#0d1117}
main{padding:20px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .n{font-size:22px;font-weight:600}
.card .l{color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:none}
button.act{background:#21262d;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:3px 8px;margin-right:4px;cursor:pointer}
button.act:hover{border-color:var(--accent)}
input,select{background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 8px}
.muted{color:var(--dim)}
.status{padding:8px 20px;color:var(--warn);min-height:20px}
code{color:var(--accent)}
</style>
</head>
<body>
<header><h1>mem</h1><nav id="nav"></nav></header>
<main id="main">loading…</main>
<div class="status" id="status"></div>
<script>
const tabs=["dashboard","sessions","units","skills","paths","tasks","search"];
let current="dashboard", state=null;
const nav=document.getElementById("nav");
tabs.forEach(t=>{const b=document.createElement("button");b.textContent=t;b.onclick=()=>{current=t;render()};nav.appendChild(b)});
const status=(m)=>{document.getElementById("status").textContent=m||""};
async function api(path,opt){const r=await fetch(path,opt);if(!r.ok)throw new Error(await r.text());return r.json()}
async function act(path,body){await api(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})});await load();status(path)}
async function load(){state=await api("/api/state");render()}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function card(n,l){return '<div class="card"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>'}
function unitRows(list){return list.map(u=>'<tr><td>'+u.id+'</td><td>'+esc(u.type)+'</td><td>'+esc(u.statement)+'</td><td>'+esc(u.scope)+'</td><td>'+Number(u.confidence).toFixed(2)+'</td><td>'+
 (u.status==="candidate"?'<button class="act" onclick="act(\\'/api/unit/'+u.id+'/status\\',{status:\\'active\\'})">approve</button><button class="act" onclick="act(\\'/api/unit/'+u.id+'/status\\',{status:\\'rejected\\'})">reject</button>':'')+
 '<button class="act" onclick="act(\\'/api/unit/'+u.id+'/pin\\',{pinned:true})">pin</button></td></tr>').join("")}
function render(){
 [...nav.children].forEach(b=>b.classList.toggle("active",b.textContent===current));
 const s=state;let html="";
 if(current==="dashboard"){html='<div class="cards">'+card(s.counts.sessions,"sessions")+card(s.counts.turns,"turns")+card(s.counts.cards,"cards")+card(s.counts.activeUnits,"active units")+card(s.counts.candidates,"candidates")+card(s.counts.injections,"injections")+card(s.counts.paths,"path groups")+card(s.auto.enabled?"ON":"OFF","auto-distill")+'</div><p class="muted">db: <code>'+esc(s.db)+'</code></p>'}
 if(current==="sessions"){html="<table><tr><th>session</th><th>lifecycle</th><th>model</th><th>workspace</th><th>goal</th></tr>"+s.sessions.map(r=>'<tr><td>'+esc(r.session_id)+'</td><td>'+esc(r.lifecycle)+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.workspace_root)+'</td><td>'+esc((r.prompt||"").slice(0,80))+'</td></tr>').join("")+"</table>"}
 if(current==="units"){html="<h3>candidates</h3><table><tr><th>id</th><th>type</th><th>statement</th><th>scope</th><th>conf</th><th>actions</th></tr>"+unitRows(s.candidates)+"</table><h3>active</h3><table><tr><th>id</th><th>type</th><th>statement</th><th>scope</th><th>conf</th><th>actions</th></tr>"+unitRows(s.active)+"</table>"}
 if(current==="skills"){html="<button class=\\"act\\" onclick=\\"act('/api/skills/draft',{})\\">draft</button><table><tr><th>id</th><th>name</th><th>status</th><th>use/ok/fail</th><th>actions</th></tr>"+s.skills.map(k=>'<tr><td>'+k.id+'</td><td>'+esc(k.name)+'</td><td>'+esc(k.status)+'</td><td>'+(k.use_count||0)+"/"+(k.success_count||0)+"/"+(k.fail_count||0)+'</td><td><button class="act" onclick="act(\\'/api/skill/'+k.id+'/activate\\',{})">activate</button></td></tr>').join("")+"</table>"}
 if(current==="paths"){html="<table><tr><th>score</th><th>steps</th><th>members</th><th>goal</th></tr>"+s.paths.map(p=>'<tr><td>'+Number(p.score).toFixed(2)+'</td><td>'+esc(p.best_steps)+'</td><td>'+p.session_ids.length+'</td><td>'+esc(p.goal)+'</td></tr>').join("")+"</table>"}
 if(current==="tasks"){html="<table><tr><th>task</th><th>memory</th><th>capture</th></tr>"+s.tasks.map(t=>'<tr><td>'+esc(t.task_id)+'</td><td>'+t.memory_enabled+'</td><td>'+t.capture_enabled+'</td></tr>').join("")+"</table>"}
 if(current==="search"){html='<p><input id="q" placeholder="search…" onkeydown="if(event.key===\\'Enter\\')doSearch()"/> <button class="act" onclick="doSearch()">search</button></p><div id="results"></div>'}
 document.getElementById("main").innerHTML=html||"<p>empty</p>";
}
async function doSearch(){const q=document.getElementById("q").value;const r=await api("/api/search?q="+encodeURIComponent(q));document.getElementById("results").innerHTML="<table><tr><th>session</th><th>role</th><th>snippet</th></tr>"+r.results.map(x=>'<tr><td>'+esc(x.session_id)+'</td><td>'+esc(x.role)+'</td><td>'+esc(x.snippet)+'</td></tr>').join("")+"</table>"}
load();
</script>
</body></html>`;

export const UI_PAGE = PAGE;

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, any>;
  } catch {
    return {};
  }
}

function json(res: ServerResponse, data: unknown, code = 200): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export interface UiServer {
  server: Server;
  port: number;
  close: () => void;
}

export function buildState(db: DatabaseSync): Record<string, unknown> {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    db: (db.prepare('PRAGMA database_list').get() as { file: string }).file,
    counts: {
      sessions: count('SELECT count(*) c FROM sessions'),
      turns: count('SELECT count(*) c FROM turns'),
      cards: count('SELECT count(*) c FROM session_cards'),
      activeUnits: count(`SELECT count(*) c FROM memory_units WHERE status='active'`),
      candidates: count(`SELECT count(*) c FROM memory_units WHERE status='candidate'`),
      injections: count('SELECT count(*) c FROM injections'),
      paths: count('SELECT count(*) c FROM paths'),
    },
    auto: loadAutoDistillConfig(),
    distill: { model: loadDistillConfig().model, provider: loadDistillConfig().provider },
    sessions: db
      .prepare(
        `SELECT session_id, lifecycle, model, workspace_root, prompt FROM sessions
         ORDER BY started_at DESC LIMIT 50`
      )
      .all(),
    candidates: listUnits(db, { status: 'candidate', limit: 100 }),
    active: listUnits(db, { status: 'active', limit: 100 }),
    skills: db.prepare('SELECT * FROM skills ORDER BY id DESC LIMIT 100').all(),
    paths: listPaths(db, 50),
    tasks: listTaskPrefs(db, 100),
  };
}

export async function startUi(
  db: DatabaseSync,
  options: { port?: number; host?: string } = {}
): Promise<UiServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, buildState(db));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const query = url.searchParams.get('q') ?? '';
        const rows = query ? searchTurns(db, query, { limit: 50 }) : [];
        json(res, {
          results: rows.map((row) => ({
            session_id: row.session_id,
            role: row.role,
            snippet: String(row.snip ?? '').replace(/\s+/g, ' ').slice(0, 200),
          })),
        });
        return;
      }
      const statusMatch = /^\/api\/unit\/(\d+)\/status$/.exec(url.pathname);
      if (req.method === 'POST' && statusMatch) {
        const body = await readJson(req);
        setUnitStatus(db, Number(statusMatch[1]), String(body.status ?? 'candidate'));
        writeProfileSnapshot(db);
        json(res, { ok: true });
        return;
      }
      const pinMatch = /^\/api\/unit\/(\d+)\/pin$/.exec(url.pathname);
      if (req.method === 'POST' && pinMatch) {
        const body = await readJson(req);
        setPinned(db, Number(pinMatch[1]), body.pinned !== false);
        writeProfileSnapshot(db);
        json(res, { ok: true });
        return;
      }
      const editMatch = /^\/api\/unit\/(\d+)\/edit$/.exec(url.pathname);
      if (req.method === 'POST' && editMatch) {
        const body = await readJson(req);
        updateUnit(db, Number(editMatch[1]), { statement: String(body.statement ?? '') });
        writeProfileSnapshot(db);
        json(res, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/skills/draft') {
        const id = await draftSkill(db, loadDistillConfig());
        json(res, { ok: id !== null, id });
        return;
      }
      const skillMatch = /^\/api\/skill\/(\d+)\/activate$/.exec(url.pathname);
      if (req.method === 'POST' && skillMatch) {
        const result = activateSkill(db, Number(skillMatch[1]));
        json(res, result ?? { error: 'not found' }, result ? 200 : 404);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auto') {
        const body = await readJson(req);
        const config = loadConfig();
        const auto = loadAutoDistillConfig();
        config.autoDistill = {
          ...auto,
          enabled: body.enabled === undefined ? !auto.enabled : body.enabled === true,
          ...(body.quietMinutes ? { quietMinutes: Number(body.quietMinutes) } : {}),
        };
        saveConfig(config);
        json(res, config.autoDistill);
        return;
      }
      const taskMatch = /^\/api\/task\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'POST' && taskMatch) {
        const body = await readJson(req);
        setTaskPref(db, decodeURIComponent(taskMatch[1]), {
          ...(body.memory !== undefined ? { memory: body.memory === true } : {}),
          ...(body.capture !== undefined ? { capture: body.capture === true } : {}),
        });
        json(res, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/paths/rebuild') {
        json(res, { groups: rebuildPaths(db) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        const body = await readJson(req);
        const dir = String(body.dir ?? '');
        const result = exportStore(db, dir);
        json(res, result);
        return;
      }
      json(res, { error: 'not found' }, 404);
    } catch (error) {
      json(res, { error: String(error) }, 500);
    }
  });
  const port = options.port ?? 8787;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, options.host ?? '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: actualPort,
    close: () => server.close(),
  };
}
