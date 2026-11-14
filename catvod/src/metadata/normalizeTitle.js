// 标题清洗：从「庆余年第二季粤语」提取 { baseName, season, lang }
const LANG_RE = /(粤语|国语|英语|日语|韩语|中字|双语|普通话)$/;
const SEASON_RE = /第([一二三四五六七八九十\d]+)季|Season\s*(\d+)|S(\d+)/i;

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

export function cnToNumber(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s.length === 2 && s[0] === "十") return 10 + (CN_NUM[s[1]] || 0);
  if (s.length === 2 && s[1] === "十") return (CN_NUM[s[0]] || 0) * 10;
  return null;
}

export function parseSourceTitle(raw) {
  if (!raw) return { baseName: "", season: null, lang: null };
  let name = String(raw).trim();

  let lang = null;
  const lm = name.match(LANG_RE);
  if (lm) { lang = lm[1]; name = name.slice(0, -lang.length).trim(); }

  let season = null;
  const sm = name.match(SEASON_RE);
  if (sm) {
    season = cnToNumber(sm[1] || sm[2] || sm[3]);
    name = name.replace(SEASON_RE, "").trim();
  }
  return { baseName: name, season, lang };
}

/** 归一化用于相似度比较：去空格/标点、小写 */
export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\-_·:：,，.。!！?？'"“”‘’()（）\[\]【】]/g, "");
}