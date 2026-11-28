// H5e 加密流解密器（wasm）。
//
// 背景：央视 h5e/hls 路径（dh5ws*.v.cntv.cn/asp/h5e/...）的 TS 分片经 H5e 加密，
// 直接交给 VLC/ffmpeg 解码会花屏（non-existing SPS / error while decoding MB）。
// 内嵌的 h5e_bundle.js 是官方 wasm 解密模块的封装，可对 TS 分片按 NALU 解密。
// 来源：MyTVB 项目 (github.com/qianxuntudou-ops/MyTVB) assets/h5e/h5e_bundle.js，
// 该 bundle 内嵌 H5player.json（data URI），无外部网络依赖。
//
// 关键约束：wasm 运行时状态是全局的（H5EBridge 单例 + session），
// 因此所有 decryptSegment 调用必须【串行】执行，用 Promise 队列保证。

const path = require('path');

// Node 18+ 已有全局 atob/btoa；低版本补 polyfill
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
}

let bridge = null;        // H5EBridge 单例
let initPromise = null;   // beginSession 的 Promise
let queue = Promise.resolve(); // 串行队列

// 日志回调（由 index.js 注入，避免循环依赖）
let log = () => {};
function setLogger(fn) { if (typeof fn === 'function') log = fn; }

function loadBridge() {
  if (bridge) return bridge;
  // bundle 是 IIFE，执行后挂到 globalThis.H5EBridge
  require(path.join(__dirname, 'vendor', 'h5e_bundle.js'));
  bridge = globalThis.H5EBridge;
  if (!bridge || typeof bridge.beginSession !== 'function') {
    throw new Error('H5EBridge 未正确加载');
  }
  return bridge;
}

async function ensureSession() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const b = loadBridge();
    const r = await b.beginSession();
    if (String(r).startsWith('err:')) throw new Error('beginSession: ' + r);
    log('H5E', '解密会话就绪');
    return b;
  })().catch(e => {
    initPromise = null; // 允许重试
    throw e;
  });
  return initPromise;
}

// 串行解密一段 TS 分片。输入 Buffer，输出解密后的 Buffer。
// 解密失败抛错（调用方应回退原始分片或报错）。
function decryptSegment(tsBuffer) {
  const task = queue.then(async () => {
    const b = await ensureSession();
    //  decryption 是 CPU 密集同步 wasm 调用，串行使全局 session 安全
    const out = await b.decryptSegment(tsBuffer.toString('base64'));
    if (typeof out !== 'string' || out.startsWith('err:')) {
      throw new Error('decryptSegment: ' + (out || 'empty'));
    }
    return Buffer.from(out, 'base64');
  });
  // 队列不因单次失败而中断
  queue = task.catch(() => {});
  return task;
}

// 解密状态（供诊断端点使用）
function status() {
  return {
    loaded: !!bridge,
    sessionReady: !!initPromise,
    queuePending: true
  };
}

module.exports = { decryptSegment, ensureSession, status, setLogger };
