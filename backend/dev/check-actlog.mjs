#!/usr/bin/env node
// dev/check-actlog.mjs —— 验「操作留痕」这条链
//
// 跑法：node dev/check-actlog.mjs
//
// 验四件事：
//   ① 底座：append → read → summarize → markdown，一条不缺
//   ② 顺序与条数：limit 取最近 N 条，坏行不拖垮整本
//   ③ 接口：POST /api/actlog、GET /api/actlog、POST /api/actlog/export
//   ④ 服务端自动留痕：写便签 /api/scratch ⇒ 自己也记一笔
//
// ⚪ 用的是假场景 id（_actlog_test），跑完把自己留下的东西清干净 —— 不碰真场景。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
process.env.WB_ROOT = ROOT;

const actlog = await import(pathToFileURL(path.join(ROOT, 'lib', 'actlog.mjs')).href);
const { handleRequest } = await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);

const SCENE = '_actlog_test';
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { console.log('  ✅ ' + label); return; }
  failed += 1;
  console.log('  ❌ ' + label + (extra ? '　⇒ ' + extra : ''));
}

/* ── 假 req / res ──────────────────────────────────────────────── */
function fakeReq(method, url, bodyObj) {
  const body = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const req = {
    method, url, headers: { host: '127.0.0.1:3081' },
    on(ev, cb) {
      if (ev === 'data' && body) cb(Buffer.from(body));
      if (ev === 'end') setTimeout(cb, 0);
      return req;
    },
    destroy() {},
  };
  return req;
}
function fakeRes() {
  const res = {
    code: 0, body: '', headers: {},
    writeHead(code, headers) { res.code = code; res.headers = headers || {}; return res; },
    end(buf) { res.body = buf == null ? '' : String(buf); return res; },
  };
  return res;
}
async function call(method, url, body) {
  const res = fakeRes();
  await handleRequest(fakeReq(method, url, body), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) { /* 不是 JSON 就是文本 */ }
  return { code: res.code, json, text: res.body };
}

function cleanup() {
  try { fs.rmSync(actlog.ledgerFile(SCENE), { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(path.join(ROOT, 'memory', SCENE), { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

cleanup();

console.log('\n① 底座：append → read → summarize → markdown');
const t0 = Date.now();
actlog.append({ scene: SCENE, actor: 'user', action: '打开书', target: '《置身事内》', detail: { 进度: '37/291' } });
actlog.append({ scene: SCENE, actor: 'user', action: '更新阅读进度', target: '《置身事内》', detail: { 页码: '37 → 58' } });
actlog.append({ scene: SCENE, actor: 'ai', action: 'AI·write', target: 'memory/reading/摘录.md' });
actlog.append({ scene: SCENE, actor: 'user', action: '打开书', target: '《国富论》', result: 'fail' });

const rows = actlog.read(SCENE);
ok(rows.length === 4, 'append 4 条 ⇒ read 回来 4 条', '实际 ' + rows.length);
ok(rows[0].action === '打开书' && rows[1].action === '更新阅读进度', '顺序按时间正序');
ok(rows[0].ts && rows[0].at >= t0 - 1000, '每条都有时间戳');
ok(rows[2].actor === 'ai', 'actor 认得出是 AI');
ok(rows[3].result === 'fail', '失败也记下来了（result=fail）');

const s = actlog.summarize(rows);
ok(s.total === 4, '统计总数对', '实际 ' + s.total);
ok(s.byActor.user === 3 && s.byActor.ai === 1, '统计分角色对', JSON.stringify(s.byActor));
ok(s.byAction[0].action === '打开书' && s.byAction[0].n === 2, '统计按动作排序对');

console.log('\n② limit 与坏行');
const lim = actlog.read(SCENE, { limit: 2 });
ok(lim.length === 2 && lim[1].action === '打开书', 'limit=2 ⇒ 最近两条');
fs.appendFileSync(actlog.ledgerFile(SCENE), '{ 这不是 JSON\n');
const after = actlog.read(SCENE);
ok(after.length === 4, '坏行被跳过，整本没坏', '实际 ' + after.length);

console.log('\n③ 接口');
const post = await call('POST', '/api/actlog', { scene: SCENE, action: '加一本书', target: '《穷查理宝典》' });
ok(post.code === 200 && post.json && post.json.ok, 'POST /api/actlog ⇒ 200', JSON.stringify(post.json));
const get = await call('GET', '/api/actlog?scene=' + SCENE);
ok(get.code === 200 && get.json.entries.length === 5, 'GET /api/actlog ⇒ 读到 5 条', '实际 ' + (get.json && get.json.entries && get.json.entries.length));
ok(get.json.summary && get.json.summary.total === 5, 'GET 带统计');
const bad = await call('GET', '/api/actlog');
ok(bad.code === 400, '没指明场景 ⇒ 400（该拦的拦住）', '实际 ' + bad.code);
const badPost = await call('POST', '/api/actlog', { action: '没有场景' });
ok(badPost.code === 400, '留痕不指明场景 ⇒ 400', '实际 ' + badPost.code);
const exp = await call('POST', '/api/actlog/export', { scene: SCENE });
ok(exp.code === 200 && fs.existsSync(exp.json.path), '导出 Markdown ⇒ 文件在', JSON.stringify(exp.json));
const md = fs.readFileSync(exp.json.path, 'utf8');
ok(md.includes('操作留痕') && md.includes('打开书'), '导出的 Markdown 里有内容');
ok(md.indexOf('《国富论》') < md.indexOf('《置身事内》'), '导出按时间倒序（新的在前）');

console.log('\n④ 服务端自动留痕（不靠前端自觉）');
const before = (await call('GET', '/api/actlog?scene=' + SCENE)).json.entries.length;
await call('POST', '/api/scratch', { scene: SCENE, dir: '项目记忆', file: '便签.md', text: '随手记一句' });
const after2 = (await call('GET', '/api/actlog?scene=' + SCENE)).json.entries;
ok(after2.length === before + 1, '写便签 ⇒ 留痕多一条', before + ' → ' + after2.length);
const last = after2[after2.length - 1];
ok(last.action === '写便签', '那条记的是「写便签」', last.action);

console.log('\n⑤ 场景隔离');
actlog.append({ scene: '_actlog_other', actor: 'user', action: '别的场景' });
const mine = actlog.read(SCENE);
ok(mine.every((e) => e.scene === SCENE), 'A 场景读不到 B 场景的记录');
const all = actlog.readAll();
ok(all.length >= mine.length, '全局读得到所有场景', String(all.length));

cleanup();
try { fs.rmSync(actlog.ledgerFile('_actlog_other'), { force: true }); } catch (e) { /* ignore */ }

console.log(failed === 0 ? '\n全部通过 ✅\n' : '\n有 ' + failed + ' 项没过 ❌\n');
process.exit(failed === 0 ? 0 : 1);
