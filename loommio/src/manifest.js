// src/manifest.js
// Stremio Addon Manifest（静态常量）
// 只声明实际支持的能力：catalog(series) / meta(series) / stream(series)
// 不声明 subtitles（底层无字幕接口，不声明未支持的能力）
// 不声明 genre（底层无 genre 字段）；不声明 skip（客户端默认会传，handler 已支持）

export const MANIFEST = {
  id: 'com.loommio.cartoons',
  version: '1.0.0',
  name: 'Loommio Cartoons',
  description: '来自Loommio的儿童影片，英文内容。',
  logo: 'https://loommio.com/assets/loommio_icon_180.png',
  // background: 留空，不设置该字段

  types: ['series'],

  // 对象数组精确声明各资源的 types / idPrefixes
  // catalog 不使用 idPrefixes；meta/stream 使用 loommio_ 前缀
  resources: [
    { name: 'catalog', types: ['series'] },
    { name: 'meta', types: ['series'], idPrefixes: ['loommio_'] },
    { name: 'stream', types: ['series'], idPrefixes: ['loommio_'] },
  ],
idPrefixes: ['loommio_'],
  catalogs: [
    {
      type: 'series',
      id: 'loommio_cartoons',
      name: 'Loommio Cartoons',
      extra: [
        { name: 'search', isRequired: false },
      ],
    },
  ],

  // 顶层 idPrefixes 不设：由 resources 对象数组按资源精确声明，
  // 避免 catalog 被 idPrefixes 误过滤（idPrefixes 只影响 meta/stream）
};

export function getManifest() {
  return MANIFEST;
}