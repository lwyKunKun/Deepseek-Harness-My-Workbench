// 仪表盘 —— 把五套机制的状态收成一处，并算出「现在该做什么」
//
// 为什么要有：现在四个场景各看各的 —— 派单台在「派单」场景、
//   越界审计在「命令」场景、负载闸在「运维」场景。
//   「机器现在能不能接活」「有没有活没人认领」「有没有人越界」
//   这三件事必须一眼看到，否则就会「到处都没事，但活推不动」。
//
// ⛔ 只读 + 无副作用：仪表盘不改变任何状态（除了它自己发的那点读）。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, MEMORY_SOFT_LIMIT, ENGINE } from './config.mjs';
import { loadScenes } from './scenes.mjs';
import { probe } from './engine.mjs';
import * as dispatch from './dispatch.mjs';
import * as triage from './triage.mjs';
import * as authority from './authority.mjs';
import * as writelog from './writelog.mjs';
import * as gpu from './gpu.mjs';
import { gate } from './loadgate.mjs';

/** 场景 → 会话。 */
export function sceneSessions() {
  const out = [];
  for (const sc of loadScenes()) {
    for (const p of sc.panels || []) {
      if (p.type === 'harness' && p.sessionId) {
        out.push({ sessionId: p.sessionId, scene: sc.id, sceneName: sc.name });
      }
    }
  }
  return out;
}

/** 记忆红线体检。 */
function memoryHealth() {
  const over = [];
  const warns = [];
  let files = 0;
  if (!fs.existsSync(PATHS.memory)) return { over, warns, files };
  for (const scene of fs.readdirSync(PATHS.memory)) {
    const dir = path.join(PATHS.memory, scene);
    let st;
    try { st = fs.statSync(dir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let s2;
      try { s2 = fs.statSync(full); } catch (e) { continue; }
      if (!s2.isFile()) continue;
      files++;
      if (/^§〇/.test(f) && s2.size > MEMORY_SOFT_LIMIT) over.push(scene + '/' + f);
      else if (s2.size > 25 * 1024) warns.push(scene + '/' + f);
    }
  }
  return { over, warns, files };
}

/**
 * 汇总全部状态。
 * @param {object} opts
 * @param {Array} opts.sessionIds 引擎里真实存在的会话 id
 */
export async function collect(opts = {}) {
  const sessions = sceneSessions();
  const scenes = loadScenes();
  const engineUp = await probe();
  const g = await gate({ samples: 1, intervalMs: 200 });   // 仪表盘要快，用快速采样
  const lines = dispatch.lines();
  const tri = triage.scan({ scenes, sessionIds: opts.sessionIds || [] });
  const audit = authority.audit({ sessions });
  const hist = writelog.buildHistory({ sessions });
  const mem = memoryHealth();
  const claims = writelog.loadClaims();
  const liveClaims = Object.keys(claims).filter((k) => writelog.claimOf(k, claims));

  // 每个场景的绑定情况
  const sceneRows = scenes.map((sc) => {
    const panels = sc.panels || [];
    const ai = panels.filter((p) => p.type === 'harness');
    const bound = ai.filter((p) => p.sessionId);
    return {
      id: sc.id,
      name: sc.name,
      panels: panels.length,
      aiPanels: ai.length,
      bound: bound.length,
      ok: ai.length === 0 || bound.length === ai.length,
    };
  });

  const waiting = lines.filter((l) => l.state === '已投递');
  const overdue = lines.filter((l) => l.state === '未回执');
  const closed = lines.filter((l) => l.state === '已回执' || l.state === '已销账');
  const lostCollisions = hist.collisions.filter((c) => c.lostCount > 0);

  // ── 现在该做什么（按优先级）───────────────────────────────
  //
  // 每条都带一个 **action 规格** —— 界面把它渲染成按钮，命令行把它渲染成可复制的命令。
  // ⛔ 动作规格只在这里定义一处（两边共用），免得界面能做而命令行做不了。
  const todo = [];
  const push = (level, what, how, action) => todo.push({ level, what, how, action });

  if (!engineUp.up) {
    push('bad', '引擎没连上', '先起引擎：dsh web --no-open --port ' + ENGINE.port,
      { kind: 'shell', label: '看怎么起', cmd: 'dsh web --no-open --port ' + ENGINE.port });
  }
  if (g.verdict === 'stop') {
    push('bad', '机器已经满了（' + g.reason + '）', '别派活，先等机器缓过来',
      { kind: 'reload', label: '再测一次', cmd: 'GET /api/loadgate' });
  } else if (g.verdict === 'warn') {
    push('warn', '机器接不了活了（' + g.reason + '）', '暂停派单；重活降并发',
      { kind: 'reload', label: '再测一次', cmd: 'GET /api/loadgate' });
  } else if (g.verdict === 'unknown') {
    push('warn', '负载闸量不到负载', '按「别派」处理',
      { kind: 'reload', label: '再测一次', cmd: 'GET /api/loadgate' });
  }
  for (const r of sceneRows.filter((x) => !x.ok)) {
    push('bad', '场景「' + r.name + '」的 AI 面板没绑会话', '给它建一条会话并钉上',
      {
        kind: 'session.new', label: '建会话并绑定', scene: r.id, title: r.name,
        cmd: 'POST /api/sessions/create {scene:\'' + r.id + '\', title:\'' + r.name + '\'}'
      });
  }
  for (const l of overdue) {
    push('warn', '有派单超时没回执：' + l.topic, '去台账看看；催之前先看条数上限（≤3）',
      {
        kind: 'close', label: '销账 / 改派', hash: l.hash, topic: l.topic,
        cmd: 'POST /api/dispatch/close {hash:\'' + l.hash + '\'}'
      });
  }
  const waitMe = waiting.filter((l) => l.to);
  for (const l of waitMe) {
    push('info', '有派单在等你回：' + l.topic, '回执要带：结论 + 证据 + 落盘路径',
      {
        kind: 'ack', label: '回执', hash: l.hash, topic: l.topic, to: l.to, from: l.from,
        cmd: 'POST /api/dispatch/ack {hash:\'' + l.hash + '\', conclusion, evidence, path}'
      });
  }
  for (const u of tri.unowned) {
    push('info', '有活没人认领：' + u.text,
      u.suggestion ? ('建议派给「' + u.suggestion.sceneName + '」（判据：' + u.suggestion.topic + '）')
        : '没有对口场景 ⇒ 问机主一句',
      u.suggestion
        ? {
          kind: 'dispatch', label: '派给 ' + u.suggestion.sceneName,
          to: u.suggestion.scene, topic: u.text,
          cmd: 'POST /api/dispatch {from,to:\'' + u.suggestion.scene + '\',topic,symptom,how,verify,reply}'
        }
        : { kind: 'claim', label: '我自己做', text: u.text, cmd: 'POST /api/dispatch/claim {scene,text}' });
  }
  if (audit.violations.length) {
    push('bad', audit.violations.length + ' 次越界写入', '看是谁动了谁的地盘',
      { kind: 'audit', label: '看详情', cmd: 'GET /api/authority/audit' });
  }
  for (const c of lostCollisions) {
    push('bad', '改动神秘消失：' + c.path, '有人把别人的改动盖掉了',
      { kind: 'traces', label: '看写痕', path: c.path, cmd: 'GET /api/writes' });
  }
  if (mem.over.length) {
    push('warn', '§〇 交接超 4KB：' + mem.over.join('、'), '拆分或覆盖写，别追加',
      { kind: 'memory', label: '去改', file: mem.over[0].split('/').pop(), cmd: '' });
  }
  if (liveClaims.length) {
    push('info', liveClaims.length + ' 个文件还持着写入权', '30 分钟自动过期；急的话让持有者放掉',
      { kind: 'traces', label: '看谁拿着', cmd: 'GET /api/writes' });
  }

  const order = { bad: 0, warn: 1, info: 2 };
  todo.sort((a, b) => order[a.level] - order[b.level]);

  return {
    at: new Date().toISOString(),
    engine: { base: ENGINE.base, up: engineUp.up, status: engineUp.status },
    gate: {
      verdict: g.verdict, text: g.text, cpu: g.cpu, ram: g.ram,
      canDispatch: g.canDispatch, canRunHeavy: g.canRunHeavy,
      reason: g.reason, ramMode: g.ramMode, samples: g.samples,
    },
    scenes: sceneRows,
    dispatch: {
      total: lines.length,
      dispatched: waiting.length,          // 已投递、还没回执
      awaitingReply: waiting.length,       // 同上（别名：等回执）
      overdue: overdue.length,             // 超时未回执
      closed: closed.length,
      recent: lines.slice(0, 5).map((l) => ({ hash: l.hash, topic: l.topic, state: l.state, from: l.from, to: l.to })),
    },
    triage: { total: tri.counts.total, owned: tri.counts.owned, unowned: tri.counts.unowned },
    authority: {
      violations: audit.violations.length,
      warnings: (audit.warnings || []).length,
      scanned: audit.scanned,
      claims: liveClaims.length,
      collisions: hist.collisions.length,
      lostCollisions: lostCollisions.length,
    },
    memory: { files: mem.files, over: mem.over, warns: mem.warns },
    gpu: { kinds: Object.keys(gpu.ALL_KINDS).length },
    todo,
  };
}

/** 一行摘要，给 CLI 用。 */
export function oneLine(d) {
  const bad = d.todo.filter((t) => t.level === 'bad').length;
  const warn = d.todo.filter((t) => t.level === 'warn').length;
  return '引擎 ' + (d.engine.up ? '✓' : '✗')
    + ' · 负载 ' + d.gate.verdict
    + ' · 场景 ' + d.scenes.length
    + ' · 等回执 ' + d.dispatch.awaitingReply + ' · 未回执 ' + d.dispatch.overdue
    + ' · 无主活 ' + d.triage.unowned
    + ' · 越界 ' + d.authority.violations
    + ' · 撞车 ' + d.authority.collisions
    + '  ⇒ ' + (bad ? bad + ' 件要马上处理' : warn ? warn + ' 件要注意' : '没有急事');
}
