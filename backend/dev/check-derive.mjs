#!/usr/bin/env node
// dev/check-derive.mjs —— 验「项目信息自动派生」这条链
//
// 跑法：node dev/check-derive.mjs
//
// 验五件事：
//   ① 自动区机制：写节不再产生重复段（\b 的坑），自动区不被手写覆盖
//   ② 派生内容算得对：正在读那本、三组计数、台账表
//   ③ 幂等：同样的数据跑两遍，第二次不改文件
//   ④ 接口：POST /api/memory 手写保存后，自动区还在
//   ⑤ 路径自洽：projectRoot 指向库里的子目录时，书照样读得到
//
// ⚠ ①②③ 用假场景（_derive_test），不碰真场景的 项目信息.md。
//   ④⑤ 只读真场景 + 真书库，不写任何一本书。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
process.env.WB_ROOT = ROOT;

const mem = await import(pathToFileURL(path.join(ROOT, 'lib', 'memory.mjs')).href);
const vault = await import(pathToFileURL(path.join(ROOT, 'lib', 'vault.mjs')).href);
const derive = await import(pathToFileURL(path.join(ROOT, 'lib', 'derive.mjs')).href);
const { handleRequest } = await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href);

const SCENE = '_derive_test';
const DIR = path.join(ROOT, 'memory', SCENE);
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
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

cleanup();
console.log('\n① 自动区机制（写在 内存/§X 里）');
mem.scaffold(SCENE, { name: '派生测试', duty: '验自动区' });
ok(fs.existsSync(mem.mainPath(SCENE)), 'scaffold 造出了 项目信息.md');

const main0 = mem.readMain(SCENE);
ok((main0.match(/^##\s*§〇/gm) || []).length === 1, '初始只有一段 §〇');

// 写 §〇 一次：不该多出第二段 §〇（以前 \b 那个坑就是这儿）
mem.writeSection(SCENE, '§〇', '- 下一步：写摘要');
const afterWrite = mem.readMain(SCENE);
ok((afterWrite.match(/^##\s*§〇/gm) || []).length === 1,
  '写 §〇 之后仍然只有一段 §〇', '实际 ' + (afterWrite.match(/^##\s*§〇/gm) || []).length);
ok(afterWrite.includes('- 下一步：写摘要'), '写进去的内容还在');
ok(!afterWrite.includes('- 现在干到哪儿'), '原来的占位被换掉了');

// 写 §一：不该把 §〇 的内容写进 §一
mem.writeSection(SCENE, '§一', '- 场景：派生测试');
const afterSec1 = mem.readMain(SCENE);
const sec1 = mem.splitSections(afterSec1)['§一'];
ok(sec1 && sec1.body.includes('派生测试') && !sec1.body.includes('写摘要'),
  '写 §一 只改 §一（没串到 §〇）', JSON.stringify(sec1 && sec1.body));

// 自动区：写进去 + 手写保存不许覆盖它
mem.setAuto(SCENE, '§〇', 'test.sum', '- 自动：派生出来的');
ok(mem.parseAuto(mem.readMain(SCENE)).length === 1, '自动区写进去了');

mem.writeSection(SCENE, '§〇', '- 下一步：改了手写');
const withAuto = mem.readMain(SCENE);
const blocks = mem.parseAuto(withAuto);
ok(blocks.length === 1, '手写保存后自动区还在', '实际 ' + blocks.length);
ok(blocks[0] && blocks[0].content.includes('派生出来的'), '自动区的内容没被手写冲掉',
  JSON.stringify(blocks[0]));
ok(withAuto.includes('改了手写'), '手写内容更新了');
ok(withAuto.indexOf('自动:') < withAuto.indexOf('改了手写'), '自动区排在手写内容前面');

// 手写内容里**夹带**自动区 ⇒ 也不认（只有派生器能写自动区）
mem.writeSection(SCENE, '§〇', '<!-- 自动:fake:start -->\n- 假的\n<!-- 自动:fake:end -->');
const spoof = mem.parseAuto(mem.readMain(SCENE));
ok(spoof.length === 1 && spoof[0].key === 'test.sum', '人伪造的自动区被忽略', JSON.stringify(spoof));

console.log('\n② 派生内容算得对（拿真书库算）');
// log:false ⇒ 不往真台账里写「自动更新项目信息」（测试不该留痕迹）
const r = derive.deriveScene('reading', { log: false });
ok(r.ok, '派生器跑通了', r.why);
ok(r.books === 35, '读到 35 本书', '实际 ' + r.books);

const main = mem.readMain('reading');
const sum = mem.parseAuto(main).find((b) => b.key === 'reading.summary');
const tally = mem.parseAuto(main).find((b) => b.key === 'reading.tally');
ok(!!sum, '§〇 里有摘要自动区');
ok(!!tally, '§三 里有台账自动区');
ok(sum && /正在读：《.+》\d+\/\d+ 页/.test(sum.content), '摘要写出了正在读哪本、读到哪页',
  sum && sum.content);
ok(sum && /台账：在读 \d+ · 想读 \d+ · 已读完 \d+ · 共 \d+ 本/.test(sum.content),
  '摘要写了三组计数', sum && sum.content);
ok(tally && tally.content.includes('| 书 | 进度 | 状态 | 开始 |'), '台账是张表',
  tally && tally.content.split('\n')[0]);
ok(tally && tally.content.includes('←正在读'), '台账里标出了「正在读」那本');

// 「正在读」= 留痕里最近一次更新进度动的那本
const acts = (await import(pathToFileURL(path.join(ROOT, 'lib', 'actlog.mjs')).href)).read('reading');
const lastUpd = acts.filter((e) => e.action === '更新阅读进度').pop();
ok(lastUpd && sum.content.includes(lastUpd.target.replace(/^.*\//, '').replace(/\.md$/, '')),
  '正在读 = 最近一次更新进度动的那本', lastUpd && lastUpd.target);

console.log('\n③ 幂等');
const mtime1 = fs.statSync(mem.mainPath('reading')).mtimeMs;
const r2 = derive.deriveScene('reading', { log: false });
ok(r2.ok && r2.changed === false, '数据没变 ⇒ 不改文件', JSON.stringify(r2));
ok(fs.statSync(mem.mainPath('reading')).mtimeMs === mtime1, '文件 mtime 没动');

console.log('\n④ 接口：手写保存后自动区还在');
// 用假场景做（它的 §〇 里也有自动区）—— 不碰真场景的项目信息.md
const post = await call('POST', '/api/memory', { scene: SCENE, section: '§〇', text: '- 卡点：等书' });
ok(post.code === 200 && post.json && post.json.ok, 'POST /api/memory ⇒ 200', JSON.stringify(post.json));
const afterPost = mem.readMain(SCENE);
const blocks2 = mem.parseAuto(afterPost);
ok(blocks2.length === 1, '自动区还在', '实际 ' + blocks2.length);
ok(blocks2[0] && blocks2[0].content.includes('派生出来的'), '自动区的内容没被手写冲掉',
  JSON.stringify(blocks2[0]));
ok(afterPost.includes('- 卡点：等书'), '手写内容存进去了');
ok((afterPost.match(/^##\s*§〇/gm) || []).length === 1, '没有多出重复的 §〇');

console.log('\n⑤ 路径自洽（projectRoot 指向库里的子目录）');
const sc = (await import(pathToFileURL(path.join(ROOT, 'lib', 'scenes.mjs')).href)).getScene('reading');
const dir = derive.booksDirOf(sc);
ok(!!dir, '阅读场景绑了书库', dir);
const root = vault.resolveVaultRoot(sc.projectRoot, dir);
const books = vault.readBooks(root, dir);
ok(books.ok && books.books.length === 35, '照样读得到 35 本书',
  books.ok ? '实际 ' + books.books.length : books.error);
ok(books.books[0] && books.books[0].path.includes('05-Bookshelf/书籍list/'),
  '书路径仍相对库根（跟留痕里的对得上）', books.books[0] && books.books[0].path);

// 接口层：books 接口也得读得到
const apiBooks = await call('GET', '/api/vault/books?scene=reading&dir=' + encodeURIComponent(dir));
ok(apiBooks.code === 200 && apiBooks.json && apiBooks.json.ok && apiBooks.json.counts.total === 35,
  'GET /api/vault/books ⇒ 35 本', JSON.stringify(apiBooks.json && apiBooks.json.counts));

cleanup();
console.log(failed === 0 ? '\n全部通过 ✅\n' : '\n有 ' + failed + ' 项没过 ❌\n');
process.exit(failed === 0 ? 0 : 1);
