// 负例自测 —— 两套机制各自的「该拦的拦住、该放行的不误报」
//
// ⛔ 为什么是**进程内函数**而不是脚本：
//   自检跑在服务端进程里（界面上的「自检」按钮调它），
//   再去起子进程跑脚本、脚本又要回调服务端 ⇒ 父子互等，死锁。
//   抽成函数后：自检直接调，谁都不用等谁。
//
// ⛔ 两套自测都必须**正例负例一起跑**：
//   只测负例 ⇒ 审计器可能是个「什么都说越界」的噪音机器；
//   只测正例 ⇒ 审计器可能是个摆设。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { PATHS } from './config.mjs';
import * as authority from './authority.mjs';
import * as writelog from './writelog.mjs';
import { doWrite, doClaim } from './writeapi.mjs';

const BOARD = 'memory/_共享记忆/_待办.md';
const absBoard = path.join(PATHS.root, BOARD);

function rowsTo(rows) {
  return { rows, ok: rows.every((r) => r.ok), fail: rows.filter((r) => !r.ok).length };
}

/* ── ① 越界审计的负例自测 ─────────────────────────────────────── */

export function authoritySelfTest() {
  const rows = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-selftest-'));
  try {
    const sessDir = path.join(tmp, 'sessions', '--fake--', 'session-fake-0001');
    fs.mkdirSync(sessDir, { recursive: true });

    const root = PATHS.root;
    const calls = [
      // 正例：写自己的地盘（D 档）—— 放行
      { name: 'write', args: { file_path: path.join(root, 'memory/research/场景私有记忆.md'), content: 'x' } },
      // 正例：读别人的地盘 —— 不算写
      { name: 'bash', args: { command: 'cat ' + path.join(root, 'memory/command/场景私有记忆.md') } },
      // 正例：grep 里提到 rm( —— 那不是命令
      { name: 'bash', args: { command: 'grep -rn "unlink|rmSync|rm(" lib/ server.mjs' } },
      // 负例：写别人的地盘（E 档）—— 要拦
      { name: 'write', args: { file_path: path.join(root, 'memory/command/场景私有记忆.md'), content: '越界' } },
      // 负例：改工具代码（C 档）—— 要拦
      { name: 'edit', args: { file_path: path.join(root, 'lib/authority.mjs'), old_string: 'a', new_string: 'b' } },
      // 负例：改规矩（A 档）—— 要拦
      { name: 'write', args: { file_path: path.join(root, 'memory/_共享记忆/派单机制.md'), content: 'x' } },
      // 负例：cp 到别人的地盘 —— 要拦
      { name: 'bash', args: { command: 'cp /tmp/a.txt ' + path.join(root, 'memory/ops/x.txt') } },
    ];

    const lines = [];
    let seq = 1;
    lines.push(JSON.stringify({ seq: seq++, type: 'turn/start', data: { turn: 1 } }));
    for (const c of calls) {
      lines.push(JSON.stringify({
        seq: seq++, type: 'tool/call',
        data: { turn: 1, step: seq, callId: 'c' + seq, name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(buf));

    const rep = authority.audit({
      sessions: [{ sessionId: 'session-fake-0001', scene: 'research' }],
      dshHome: tmp,
    });

    const got = rep.violations.map((v) => v.path.replace(root + '/', '')).sort();
    const want = [
      'lib/authority.mjs',
      'memory/_共享记忆/派单机制.md',
      'memory/command/场景私有记忆.md',
      'memory/ops/x.txt',
    ].sort();

    const ok = JSON.stringify(got) === JSON.stringify(want);
    rows.push({
      name: '越界审计',
      ok,
      detail: ok
        ? '该拦的 4 条全拦住了，该放行的 3 条没误报'
        : '检出 ' + (got.join('、') || '（无）') + '，期望 ' + want.join('、'),
    });
  } catch (e) {
    rows.push({ name: '越界审计', ok: false, detail: '自测跑挂了：' + (e && e.message || e) });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  return rowsTo(rows);
}

/* ── ② 写痕的负例自测 ─────────────────────────────────────────── */

export function writelogSelfTest() {
  const rows = [];
  const logFile = path.join(PATHS.data, 'writes.jsonl');
  const logBefore = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  let backup = '';

  try {
    // 清场（自测必须幂等）
    for (const sc of ['调研', '运维', 'research', 'ops']) {
      doClaim({ scene: sc, path: BOARD, release: true });
    }
    if (fs.existsSync(absBoard)) {
      const cleaned = fs.readFileSync(absBoard, 'utf8')
        .split('\n').filter((l) => l.indexOf('自测行') < 0).join('\n');
      fs.writeFileSync(absBoard, cleaned, 'utf8');
    }
    backup = fs.existsSync(absBoard) ? fs.readFileSync(absBoard, 'utf8') : '';

    // ① 写盘前重读：baseSha 对不上 ⇒ 拒写
    {
      const r = doWrite({ scene: '调研', path: BOARD, content: backup, baseSha: 'deadbeef' }, { sessions: [] });
      rows.push({
        name: '写盘前重读',
        ok: r.status === 409 && /过时/.test(String(r.body.error)),
        detail: r.status === 409 ? '拒写：' + r.body.error : '没拦住（HTTP ' + r.status + '）',
      });
    }

    // ② 写入权：同路径只留一个写入者
    {
      const a = doClaim({ scene: '调研', path: BOARD });
      const b = doClaim({ scene: '运维', path: BOARD });
      rows.push({
        name: '写入权',
        ok: a.status === 200 && b.status === 409,
        detail: b.status === 409 ? '运维拿不到：' + (b.body.reason || b.body.error) : '两个人都拿到了写入权',
      });
      doClaim({ scene: '调研', path: BOARD, release: true });
    }

    // ③ 写完自证：盖掉别人写的行 ⇒ 拒写
    {
      doWrite({ scene: '调研', path: BOARD, content: backup + '\n- [ ] 自测行A（调研写的）\n' }, { sessions: [] });
      doClaim({ scene: '调研', path: BOARD, release: true });
      const r = doWrite({ scene: '运维', path: BOARD, content: backup + '\n- [ ] 自测行B（运维写的）\n' }, { sessions: [] });
      const lost = r.body.selfCheck ? r.body.selfCheck.lost.length : 0;
      rows.push({
        name: '写完自证',
        ok: r.status === 409 && lost > 0,
        detail: r.status === 409 && lost > 0 ? '拒写：' + String(r.body.error).slice(0, 80)
          : '没拦住（HTTP ' + r.status + '，lost=' + lost + '）',
      });
      const after = fs.readFileSync(absBoard, 'utf8');
      rows.push({
        name: '拒写后文件未变',
        ok: after.includes('自测行A'),
        detail: after.includes('自测行A') ? '调研那行还在' : '文件被改坏了',
      });
    }

    // ④ 撞车检测（纯函数级）
    {
      const writes = [
        { path: 'memory/x.md', scene: 'research', sceneName: '调研', time: 1000, seq: 1, tool: 'write', content: '第一行\n第二行\n' },
        { path: 'memory/x.md', scene: 'ops', sceneName: '运维', time: 2000, seq: 2, tool: 'write', content: '第二行\n运维那行\n' },
      ];
      const res = writelog.analyzeWrites(writes);
      const col = res.collisions[0];
      rows.push({
        name: '撞车检测',
        ok: res.collisions.length === 1 && col.by === 'research' && col.over === 'ops',
        detail: res.collisions.length
          ? '检出：' + col.byName + ' → ' + col.overName + '（间隔 ' + col.gapMin + ' 分钟）'
          : '没检出撞车',
      });
      rows.push({
        name: '改动神秘消失',
        ok: !!col && col.lostCount === 1 && col.samples.join('').includes('第一行'),
        detail: col && col.lostCount ? '丢了 ' + col.lostCount + ' 行：' + col.samples.join(' / ') : '没算出丢行',
      });
    }
  } catch (e) {
    rows.push({ name: '写痕自测', ok: false, detail: '自测跑挂了：' + (e && e.message || e) });
  } finally {
    try {
      if (backup) fs.writeFileSync(absBoard, backup, 'utf8');
      writelog.invalidateOwners();
    } catch (e) { /* ignore */ }
    try {
      if (fs.existsSync(logFile)) fs.truncateSync(logFile, logBefore);
    } catch (e) { /* ignore */ }
    // ⚠ 自测拿过的写入权也要交还 —— 不还的话会给这个文件留一条 30 分钟的租约，
    //   把真实场景的路堵上（调研场景 2026-11-07 实测踩过）
    for (const sc of ['调研', '运维', 'research', 'ops']) {
      try { doClaim({ scene: sc, path: BOARD, release: true }); } catch (e) { /* ignore */ }
    }
  }
  return rowsTo(rows);
}
