// packages/src/decode.js

/**
 * 解码 trybox 的 t/p/k/v/a 结构
 * @param {any} node - 原始节点
 * @returns {any} 解码后的值
 */
export function decodeNode(node) {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;

  switch (node.t) {
    case 0: // 数字
    case 1: // 字符串
      return node.s;
    case 2: // null
      return null;
    case 9: // 数组
      return (node.a || []).map(decodeNode);
    case 10: { // 对象
      const obj = {};
      const keys = node.p?.k || [];
      const values = node.p?.v || [];
      for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = decodeNode(values[i]);
      }
      return obj;
    }
    case 11: // context 等特殊节点
      return null;
    default:
      return node.s !== undefined ? node.s : node;
  }
}

/**
 * 把 result 里的所有数组拍平
 * @param {object} result
 * @returns {Record<string, any[]>}
 */
export function flattenSections(result) {
  const sections = {};
  function walk(obj, path) {
    if (Array.isArray(obj)) {
      sections[path] = obj;
      return;
    }
    if (obj && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        walk(val, path ? `${path}.${key}` : key);
      }
    }
  }
  walk(result, '');
  return sections;
}