// vault.mjs —— 读 Obsidian 仓库（frontmatter + 笔记正文）
//
// 为什么单独一个模块：Obsidian 的 .md 文件带 YAML frontmatter，
//   读它不是「读个 markdown」，而是「读一份结构化的书条目」。
//   判据只写在这里，界面与 API 都调它。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 frontmatter（--- 包起来的 YAML 头）。
 * ⚠ 不引 yaml 库（这个工作台零依赖）—— 只支持 Obsidian 书笔记真正用到的那几种：
 *   标量：title / author / status / cover / startDate / endDate
 *   数字：totalPage / currentPage
 *   列表：tags
 * 够用且不会因为 YAML 方言的边角情况炸掉。
 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const fm = {};
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm, body: src, hasFm: false };
  const block = m[1];
  const body = src.slice(m[0].length);
  const lines = block.split(/\r?\n/);
  let key = null;
  let listKey = null;
  for (const line of lines) {
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey) {
      if (!Array.isArray(fm[listKey])) fm[listKey] = [];
      fm[listKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1].trim();
    listKey = null;
    const raw = kv[2].trim();
    if (raw === '') { listKey = key; fm[key] = []; continue; }   // 可能是列表
    fm[key] = coerce(raw);
  }
  return { fm, body, hasFm: true };
}

function unquote(s) {
  const v = String(s || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function coerce(raw) {
  const v = unquote(raw);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((x) => unquote(x)).filter(Boolean);
  }
  return v;
}

/** 一个书条目。 */
export function toBook(rel, text, opts = {}) {
  const { fm, body } = parseFrontmatter(text);
  const title = String(fm.title || path.basename(rel, '.md') || '').trim();
  const status = String(fm.status || '想读').trim();
  const total = Number(fm.totalPage) || 0;
  const cur = Number(fm.currentPage) || 0;
  return {
    path: rel,                       // 相对仓库根
    file: path.basename(rel),
    title,
    author: String(fm.author || ''),
    status,
    totalPage: total,
    currentPage: cur,
    startDate: String(fm.startDate || ''),
    endDate: String(fm.endDate || ''),
    cover: String(fm.cover || ''),
    tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [String(fm.tags)] : []),
    // 正文（去掉 frontmatter）
    content: body,
    // 摘录：第一段正文里的实质内容（去掉标题行/引用行/分隔线）
    excerpt: excerptOf(body),
    progress: total > 0 ? Math.min(1, cur / total) : 0,
  };
}

/** 笔记正文的前几行「实质内容」。 */
export function excerptOf(body, max = 160) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (out.length) break; continue; }
    if (t.startsWith('#')) continue;            // 标题
    if (t === '---') break;                    // 分隔线
    if (t.startsWith('>')) continue;           // 引用行（Obsidian 的元信息行）
    out.push(t.replace(/^[-*]\s+/, ''));
    if (out.join(' ').length >= max) break;
  }
  return out.join(' ').slice(0, max);
}

/** 递归列出仓库里所有 .md（跳过 _ 开头和点目录）。 */
export function listNotes(root, opts = {}) {
  const skip = opts.skip || ['_templates', '_covers', '.obsidian', '.trash', 'node_modules'];
  const out = [];
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const n of names) {
      if (n.name.startsWith('.') || n.name.startsWith('_')) continue;
      const abs = path.join(dir, n.name);
      const r = rel ? rel + '/' + n.name : n.name;
      if (n.isDirectory()) walk(abs, r);
      else if (n.name.endsWith('.md')) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * 读一个目录下的书条目（按 frontmatter 的 status 分组）。
 * @param {string} root 仓库根
 * @param {string} sub  子目录（相对仓库根），如 '05-Bookshelf/书籍list'
 */
export function readBooks(root, sub) {
  const dir = path.resolve(root, sub);
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在：' + sub, books: [] };
  const books = [];
  for (const rel of listNotes(dir)) {
    try {
      const text = fs.readFileSync(path.join(dir, rel), 'utf8');
      books.push(toBook(rel, text));
    } catch (e) { /* 跳过读不了的 */ }
  }
  // ⚠ 书条目的 path 要是**相对仓库根**的（05-Bookshelf/书籍list/xxx.md）——
  //   不然「读这本书」「更新进度」时拼不出完整路径。
  const prefix = sub ? sub.replace(/\/+$/, '') + '/' : '';
  for (const b of books) b.path = prefix + b.path;
  return { ok: true, books };
}

/** 读仓库里的一个 .md（相对仓库根）。 */
export function readNote(root, rel) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) {
    return { ok: false, error: '路径不对' };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在：' + rel };
  const text = fs.readFileSync(abs, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  return { ok: true, fm, body, text, path: rel };
}

/**
 * 写 frontmatter 的某个字段（只改那一个字段，其余原样）。
 * ⚠ 不引 yaml 库 ⇒ 只处理标量字段；列表字段原样保留。
 */
export function writeFrontmatterField(root, rel, field, value) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { ok: false, error: '路径不对' };
  if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
  const text = fs.readFileSync(abs, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { ok: false, error: '这个文件没有 frontmatter' };
  const lines = m[1].split(/\r?\n/);
  const out = [];
  let done = false;
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/);
    if (kv && kv[1].trim() === field) {
      out.push(field + ': ' + (typeof value === 'string' && /[:#{}\[\],&*?|<>=!%@`"'\n]/.test(value) ? JSON.stringify(value) : value));
      done = true;
      continue;
    }
    out.push(line);
  }
  if (!done) out.push(field + ': ' + value);
  const rebuilt = '---\n' + out.join('\n') + '\n---\n' + text.slice(m[0].length);
  fs.writeFileSync(abs, rebuilt, 'utf8');
  return { ok: true };
}

/** 写一个**新**书笔记（按模板）。 */
export function createBookNote(root, rel, fields = {}) {
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { ok: false, error: '路径不对' };
  if (fs.existsSync(abs)) return { ok: false, error: '已经有一本了：' + rel };
  const today = new Date().toISOString().slice(0, 10);
  const fm = [
    '---',
    'title: ' + jsonIfNeeded(fields.title || path.basename(rel, '.md')),
    'author: ' + jsonIfNeeded(fields.author || ''),
    'totalPage: ' + (Number(fields.totalPage) || 0),
    'currentPage: ' + (Number(fields.currentPage) || 0),
    'status: ' + jsonIfNeeded(fields.status || '想读'),
    'startDate: ' + (fields.startDate || today),
    'endDate: ' + jsonIfNeeded(fields.endDate || ''),
    'cover: ' + jsonIfNeeded(fields.cover || ''),
    'tags: [books]',
    '---',
    '',
    '# ' + (fields.title || path.basename(rel, '.md')),
    '',
    '> 作者：' + (fields.author || '') + ' | 总页数：' + (Number(fields.totalPage) || 0) + ' | 状态：' + (fields.status || '想读'),
    '',
    '---',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, fm, 'utf8');
  return { ok: true, path: rel };
}

function jsonIfNeeded(v) {
  const s = String(v == null ? '' : v);
  return /[:#{}\[\],&*?|<>=!%@`"'\n]/.test(s) ? JSON.stringify(s) : s;
}
