// derive.mjs —— 派生区：按真实数据算出来的「项目信息」
//
// 干什么：把书库里的真实状态，变成 项目信息.md 里的两段自动内容
//   §〇 顶部（reading.summary）：正在读哪本 + 三组计数 ⇒ 开场先读就能看见
//   §三 台账（reading.tally）  ：在读的书逐本一行 + 最近读完的那本
//
// 为什么值得做：手填的「当前交接」必然过期 —— 页码变了、书读完了、换书了，
//   但交接还是昨天写的那几行。派生的内容**永远等于真实数据**。
//
// ⚠ 自动区只读：内容只有这里能写。人在面板里改不动
//   （前端渲染成只读块；服务端写节时也用磁盘上的原自动区盖回去）。
//
// ⚠ 「正在读」那本怎么定：看留痕里**最近一次「更新阅读进度」**动的是哪本书
//   —— 那是人刚刚碰过的那本，最贴近「我正在读」。
//   没有留痕就退回：status=在读 里 startDate 最新的那本。

import { getScene } from './scenes.mjs';

/* ⚠ 插件模式里 ESM 按 URL 缓存模块 ⇒ 相对 import 的 ./lib/*.mjs 是**第一次那份**，
 *   改了 lib/derive.mjs / lib/memory.mjs 不生效。借 server.mjs 的那个时间戳
 *   import 它 ⇒ 每次请求都拿到最新代码（跟 server.mjs 里 actlog 的做法一样）。 */
const STAMP = import.meta.url.includes('?') ? '?' + import.meta.url.split('?')[1] : '';
const mem = await import('./memory.mjs' + STAMP);
const actlog = await import('./actlog.mjs' + STAMP);
const vault = await import('./vault.mjs' + STAMP);

export const SUMMARY_KEY = 'reading.summary';
export const TALLY_KEY = 'reading.tally';

/** 场景有没有绑书库（kind='books' 的 vaultDirs）。 */
export function booksDirOf(sc) {
  const v = (sc && sc.vaultDirs || []).filter((x) => x && x.kind === 'books')[0];
  return v ? String(v.dir || '') : '';
}

/** 表格里的竖线要转义，不然书名带 | 会把表格拆烂。 */
function cell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

/** 进度百分比（没总页数就空着）。 */
function pct(cur, total) {
  if (!total || total <= 0) return '';
  return Math.round(Math.min(1, cur / total) * 100) + '%';
}

/** 「正在读」是哪本：最近动过的那本 → 在读里开始最早/最晚的兜底。 */
function currentBook(books, sceneId) {
  const acts = actlog.read(sceneId).filter((e) => e.action === '更新阅读进度' && e.result !== 'fail');
  // 从最近一次往前找，但要**还在读的那本** —— 最近更新过、但已经读完的不算「正在读」。
  for (let i = acts.length - 1; i >= 0; i--) {
    const target = String(acts[i].target || '');
    const hit = books.find((b) => b.path === target || b.file === target);
    if (hit && hit.status === '在读') return hit;
  }
  const reading = books.filter((b) => b.status === '在读');
  if (!reading.length) return null;
  return reading.slice().sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))[0];
}

/** §〇 顶部那段摘要。 */
export function summaryText(books, cur) {
  const counts = { reading: 0, want: 0, done: 0, other: 0 };
  for (const b of books) {
    if (b.status === '在读') counts.reading++;
    else if (b.status === '想读') counts.want++;
    else if (b.status === '已读完') counts.done++;
    else counts.other++;
  }
  const now = cur
    ? '《' + cur.title + '》' + cur.currentPage + '/' + (cur.totalPage || '?') + ' 页'
      + (pct(cur.currentPage, cur.totalPage) ? '（' + pct(cur.currentPage, cur.totalPage) + '）' : '')
      + (cur.author ? ' · ' + cur.author : '')
    : '（没有在读的书 —— 去书架挑一本）';
  return [
    '- 正在读：' + now,
    '- 台账：在读 ' + counts.reading + ' · 想读 ' + counts.want + ' · 已读完 ' + counts.done
      + ' · 共 ' + books.length + ' 本',
  ].join('\n');
}

/** §三 那张台账表。 */
export function tallyText(books, cur) {
  const reading = books.filter((b) => b.status === '在读');
  const rows = [
    '> 这张表由工作台按书库自动算出来：改书笔记就会改这里，不用手填。',
    '',
    '| 书 | 进度 | 状态 | 开始 |',
    '|---|---|---|---|',
  ];
  if (!reading.length) {
    rows.push('| （当前没有在读的书） | — | — | — |');
  } else {
    for (const b of reading) {
      const mark = cur && cur.path === b.path ? ' ←正在读' : '';
      rows.push('| ' + cell(b.title) + mark
        + ' | ' + b.currentPage + ' / ' + (b.totalPage || '?')
        + (pct(b.currentPage, b.totalPage) ? '（' + pct(b.currentPage, b.totalPage) + '）' : '')
        + ' | ' + cell(b.status) + ' | ' + cell(b.startDate || '—') + ' |');
    }
  }
  const done = books.filter((b) => b.status === '已读完' && b.endDate)
    .sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)));
  if (done.length) {
    rows.push('');
    rows.push('最近读完：《' + cell(done[0].title) + '》（' + done[0].endDate + '）');
  }
  return rows.join('\n');
}

/**
 * 同步一个场景的派生内容到 项目信息.md。
 * @returns {{ok:boolean, changed?:boolean, why?:string, books?:number}}
 */
export function deriveScene(sceneId, opts = {}) {
  const sc = getScene(sceneId);
  if (!sc) return { ok: false, why: '没有这个场景：' + sceneId };
  const dir = booksDirOf(sc);
  if (!dir) return { ok: false, why: '这个场景没绑书库（vaultDirs 里没有 kind=books）' };
  const root = vault.resolveVaultRoot(sc.projectRoot, dir);
  const r = vault.readBooks(root, dir);
  if (!r.ok) return { ok: false, why: r.error };

  const books = r.books || [];
  const cur = currentBook(books, sc.id);
  const summary = summaryText(books, cur);
  const tally = tallyText(books, cur);

  const a = mem.setAuto(sc.id, '§〇', SUMMARY_KEY, summary);
  const b = mem.setAuto(sc.id, '§三', TALLY_KEY, tally, { name: '阅读台账', before: '§五' });
  const changed = !!a.changed || !!b.changed;

  if (changed && opts.log !== false) {
    actlog.append({
      scene: sc.id, actor: 'system', action: '自动更新项目信息',
      target: '§〇 摘要 / §三 台账',
      detail: { 书: books.length + ' 本', 正在读: cur ? '《' + cur.title + '》' : '无' },
    });
  }
  return { ok: true, changed, books: books.length, current: cur ? cur.title : '' };
}
