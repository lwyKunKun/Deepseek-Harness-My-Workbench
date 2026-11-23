// 面板端口池的状态 —— server.mjs 起端口，doctor.mjs 体检时查「这些端口是不是我们自己占的」
//
// 为什么要有这个：
//   体检原来只问「端口被占了吗」，于是插件模式下（面板端口由工作台自己开着）
//   会误报「面板端口被占：3082」。
//   端口是谁占的，得有人记账 —— 就是这里。
//
// 单独一个模块，是为了不让 doctor.mjs 和 server.mjs 互相 import（会成环）。

const owned = new Set();

/** 记下：这个端口是我们自己的面板代理端口。 */
export function markOwned(port) {
  owned.add(Number(port));
}

/** 端口还给我们了（插件被停用时）。 */
export function releaseOwned(port) {
  owned.delete(Number(port));
}

/** 我们占着的端口（升序）。 */
export function ownedPorts() {
  return [...owned].sort((a, b) => a - b);
}
