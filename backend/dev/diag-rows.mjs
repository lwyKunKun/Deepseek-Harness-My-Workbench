#!/usr/bin/env node
// diag-rows.mjs —— 查引擎侧栏里的会话行长什么样（pin.js 要按标题找行）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9411;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rows-'));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => fs.existsSync(p));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync('data/engine-cookie.json', 'utf8')).cookie || ''; } catch (e) { return ''; } };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.ctxs = []; this.errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.executionContextCreated') { const c = m.params.context; this.ctxs.push({ id: c.id, origin: c.origin }); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '');
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); } }, 30000); }); }
  async eval(expression, contextId) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, ...(contextId ? { contextId } : {}) }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
  ctxOf(origin) { const c = this.ctxs.filter((x) => x.origin === origin); return c.length ? c[c.length - 1].id : undefined; }
}

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); target = l.find((t) => t.type === 'page'); } catch (e) {} if (!target) await sleep(250); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  for (const part of cookie().split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    await cdp.send('Network.setCookie', { name: part.slice(0, i), value: decodeURIComponent(part.slice(i + 1)), domain: '127.0.0.1', path: '/' });
  }
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080/' });
  await sleep(9000);
  const ctx = cdp.ctxOf('http://127.0.0.1:3080');
  const info = await cdp.eval(`(function(){
    var out = { rows: [], treeitems: document.querySelectorAll('[role="treeitem"]').length, titles: document.querySelectorAll('[class*="title"]').length };
    document.querySelectorAll('[role="treeitem"], [aria-selected]').forEach(function(e){
      var t = e.querySelector('[class*="title"]');
      out.rows.push({
        role: e.getAttribute('role'),
        selected: e.getAttribute('aria-selected'),
        expanded: e.getAttribute('aria-expanded'),
        cls: (e.className||'').slice(0,50),
        titleText: t ? t.textContent.slice(0,24) : '(无 title 元素)',
        text: (e.textContent||'').replace(/\\s+/g,' ').slice(0,40),
      });
      if (out.rows.length >= 8) return;
    });
    return out;
  })()`, ctx);
  console.log('侧栏会话行：');
  console.log(JSON.stringify(info, null, 1).slice(0, 2600));
  console.log('');
  console.log('报错：', cdp.errors.slice(0, 2).join(' | ') || '无');
} catch (e) { console.error('失败：' + e.message); process.exitCode = 1; }
finally { try { chrome.kill(); } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
