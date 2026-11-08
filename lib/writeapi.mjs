// 受闸写接口的**核心逻辑**（不含 HTTP）
//
// ⛔ 为什么要抽出来：自测要能直接调它。
//   之前自测走 HTTP 调服务端，而自检本身又跑在服务端进程里 ⇒ 父子互等，死锁。
//   抽成模块后：服务端调它、自测也调它 —— 同一份逻辑，谁都不用等谁。

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';
import * as authority from './authority.mjs';
import * as writelog from './writelog.mjs';

/**
 * 写一个文件（带四道约束：分档 / 写盘前重读 / 写入权 / 写完自证）。
 *
 * @param {object} req
 *   {scene, path, content, op:'write'|'edit', oldString, baseSha, cwd}
 * @param {object} ctx
 *   {sessions} 场景→会话清单（写痕要用）
 * @returns {{status:number, body:object}}
 */
export function doWrite(req, ctx = {}) {
  const actor = String(req.scene || '');
  const v = authority.check(req.path || '', actor, {
    content: req.content || '',
    oldString: req.oldString || '',
  });
  if (!v.allowed) {
    return {
      status: 403,
      body: { ok: false, error: v.why, verdict: v, request: v.request },
    };
  }

  // 只能写「自己的工作台目录」或「自己绑定的项目目录」
  //   （项目目录在工作台之外 —— 那是角色在真实磁盘上的地盘）
  const abs = path.resolve(PATHS.root, v.path);
  const inWorkbench = abs === PATHS.root || abs.startsWith(PATHS.root + path.sep);
  let inOwnTerritory = false;
  if (!inWorkbench) {
    const t = authority.loadTerritory();
    const mine = (t.scenes && t.scenes[v.asScene] && t.scenes[v.asScene].territory) || [];
    inOwnTerritory = mine.some((p) => {
      const pAbs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(PATHS.root, p);
      return abs === pAbs || abs.startsWith(pAbs + path.sep);
    });
  }
  if (!inWorkbench && !inOwnTerritory) {
    return { status: 403, body: { ok: false, error: '只能写自己的工作台目录，或自己绑定的项目目录' } };
  }

  const oldContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const oldSha = writelog.hash(oldContent);

  // ① 写盘前重读：调用方说「我读的是这一版」，对不上就别写
  if (req.baseSha && req.baseSha !== oldSha) {
    return {
      status: 409,
      body: {
        ok: false,
        error: '你读的那一版已经过时了（现在 sha=' + oldSha + '，你手上是 ' + req.baseSha + '）—— 先重读再写',
        currentSha: oldSha,
      },
    };
  }

  // ② 写入权：同路径只留一个写入者
  const claim = writelog.takeClaim(v.path, v.asScene || actor);
  if (!claim.ok) {
    return { status: 409, body: { ok: false, error: claim.reason, holder: claim.holder } };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let newContent;
  if (req.op === 'edit') {
    if (!oldContent.includes(req.oldString || '')) {
      writelog.releaseClaim(v.path, v.asScene || actor);   // 写没发生 ⇒ 还权
      return { status: 409, body: { ok: false, error: '原文对不上（别人可能已经改过了）—— 写盘前重读' } };
    }
    newContent = oldContent.replace(req.oldString || '', req.content || '');
  } else {
    newContent = String(req.content || '');
  }

  // ③ 写完自证：**别人**写的行还在不在？不在 ⇒ 回滚拒写
  const owners = writelog.ownersOf({ sessions: ctx.sessions || [] });
  const self = writelog.selfCheck(owners, v.path, oldContent, newContent, v.asScene || actor);
  if (self.lost.length) {
    fs.writeFileSync(abs, oldContent, 'utf8');   // 回滚
    // ⚠ 写没成功 ⇒ 交还写入权（不然会留一条没人认领的租约，把这条路堵上 30 分钟）
    writelog.releaseClaim(v.path, v.asScene || actor);
    return {
      status: 409,
      body: {
        ok: false,
        error: '这一版会把「' + self.lost.length + '」行**别人**写的改动盖掉 ⇒ 已拒写。'
          + '先重读，把那几行带上再写。丢的是：' + self.samples.join(' / '),
        selfCheck: self,
      },
    };
  }

  fs.writeFileSync(abs, newContent, 'utf8');

  // 留痕：谁在什么时候写了什么
  writelog.appendApiWrite({
    path: v.path, scene: v.asScene || actor, sceneName: actor,
    at: Date.now(), op: req.op || 'write',
    shaBefore: oldSha, shaAfter: writelog.hash(newContent),
    content: req.op === 'edit' ? null : newContent,
    lost: self.lost.length,
  });
  writelog.invalidateOwners();

  return {
    status: 200,
    body: { ok: true, verdict: v, path: v.path, claim: claim.claim, selfCheck: self, warn: '' },
  };
}

/** 拿/放写入权。 */
export function doClaim(req) {
  const r = req.release
    ? writelog.releaseClaim(req.path, req.scene)
    : writelog.takeClaim(req.path, req.scene);
  return { status: r.ok ? 200 : 409, body: r };
}
