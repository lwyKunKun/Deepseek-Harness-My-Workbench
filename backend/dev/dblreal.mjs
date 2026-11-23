// 真·双击测试：用 CDP 的鼠标事件（clickCount:2），不是合成 DOM 事件
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9470;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dbl-'));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const chrome = spawn(CHROME, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run',
  '--disable-extensions','--disable-background-networking','--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=512','--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,'--window-size=1600,1000','about:blank'],
  { stdio: ['ignore','ignore','ignore'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = () => { try { return JSON.parse(fs.readFileSync('data/engine-cookie.json','utf8')).cookie || ''; } catch(e){ return ''; } };
class CDP {
  constructor(ws){ this.ws=ws; this.id=0; this.pending=new Map(); this.errors=[];
    ws.addEventListener('message',(ev)=>{ const m=JSON.parse(ev.data);
      if(m.method==='Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails?.exception?.description||m.params.exceptionDetails?.text||'');
      if(m.id&&this.pending.has(m.id)){ const {resolve,reject}=this.pending.get(m.id); this.pending.delete(m.id); if(m.error) reject(new Error(m.error.message)); else resolve(m.result);} }); }
  send(method,params={}){ const id=++this.id; return new Promise((resolve,reject)=>{ this.pending.set(id,{resolve,reject}); this.ws.send(JSON.stringify({id,method,params})); setTimeout(()=>{ if(this.pending.has(id)){ this.pending.delete(id); reject(new Error('超时 '+method)); } },30000); }); }
  async eval(expression){ const r=await this.send('Runtime.evaluate',{expression,returnByValue:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
}
const HOST = `(function(){ var h=null; document.querySelectorAll('*').forEach(function(el){ if (el.shadowRoot && el.shadowRoot.querySelector('#topbar')) h=el; }); return h; })()`;
try {
  const target = (await (async () => { for (let i=0;i<40;i++){ try { const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json(); const p=l.find(t=>t.type==='page'); if(p) return p; } catch(e){} await sleep(250);} })());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ ws.addEventListener('open',res); ws.addEventListener('error',rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  for (const part of cookie().split(';').map(s=>s.trim()).filter(Boolean)) {
    const i=part.indexOf('=');
    await cdp.send('Network.setCookie',{name:part.slice(0,i),value:decodeURIComponent(part.slice(i+1)),domain:'127.0.0.1',path:'/'});
  }
  await cdp.send('Page.navigate',{url:'http://127.0.0.1:3080/'});
  await sleep(9000);
  await cdp.eval(`(function(){ var a=document.querySelectorAll('button,[role="button"]'); for(var i=0;i<a.length;i++){ if((a[i].getAttribute('aria-label')||'')==='工作台'){a[i].click();return 1;} } return 0; })()`);
  await sleep(4000);

  // 三个位置都试：标题上 / 正文文字上 / 卡片空白处
  const spots = ['标题', '正文文字', '卡片底部'];
  for (const spot of spots) {
    const box = await cdp.eval(`(function(){
      var host=${HOST}; if(!host) return null;
      var c = host.shadowRoot.querySelectorAll('.panel-card')[0];
      if(!c) return 'no-card';
      var r = c.getBoundingClientRect();
      var x = r.left + 30, y = r.top + 14;
      if ('${spot}' === '正文文字') { var l = c.querySelector('.panel-card-line'); if (l) { var lr = l.getBoundingClientRect(); x = lr.left + 20; y = lr.top + 8; } }
      if ('${spot}' === '卡片底部') { y = r.bottom - 12; x = r.left + r.width - 30; }
      return { x: x, y: y };
    })()`);
    if (!box || typeof box === 'string') { console.log(spot + '：拿不到位置'); continue; }
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x: box.x, y: box.y, button:'left', clickCount:1, buttons:1 });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x: box.x, y: box.y, button:'left', clickCount:1, buttons:0 });
    await sleep(70);
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x: box.x, y: box.y, button:'left', clickCount:2, buttons:1 });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x: box.x, y: box.y, button:'left', clickCount:2, buttons:0 });
    await sleep(2200);
    const state = await cdp.eval(`(function(){
      var host=${HOST}; if(!host) return 'no-shadow';
      return { 详情页: !!host.shadowRoot.querySelector('.detail-head'),
               面板数: host.shadowRoot.querySelectorAll('.panel').length };
    })()`);
    console.log('  双击在「' + spot + '」⇒ ' + JSON.stringify(state));
    if (state && state.详情页) {
      // 回目录，好测下一个位置
      await cdp.eval(`(function(){
        var host=${HOST}; if(!host) return;
        var back = host.shadowRoot.querySelector('.detail-head button');
        if (back) back.click();
      })()`);
      await sleep(1500);
    }
  }
  // 截一张摘要卡的图（看「详情」按钮）
  await cdp.eval(`(function(){
    var host=${HOST}; if(!host) return;
    var h = host.shadowRoot.querySelector('.cat-main-head');
    if (h) { var b = h.querySelector('button'); }
  })()`);
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => {
    fs.writeFileSync(path.join(process.cwd(), 'data', 'cards.png'), Buffer.from(r.data, 'base64'));
    console.log('截图：data/cards.png');
  }).catch(()=>{});
  console.log('报错：' + (cdp.errors.slice(0,3).join(' | ')||'无'));
} catch(e){ console.error('失败：'+e.message); process.exitCode=1; }
finally { try{chrome.kill();}catch(e){} try{fs.rmSync(profile,{recursive:true,force:true});}catch(e){} }
