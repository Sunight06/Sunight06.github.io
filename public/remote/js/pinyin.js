// 汉字 → 拼音首字母（只要首字母，用于「wx」搜到「微信」）。
//
// 不带字典：借浏览器内置的中文排序（Intl.Collator zh-CN 按拼音排序），拿每个声母区间的第一个字作边界，
// 二分找出这个字落在哪个区间。覆盖 GB2312 常用字；生僻字、多音字可能不准，搜索时还有名称和包名兜底。

const BOUNDS = '阿芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'.split('');
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'.split('');
const collator = (() => { try { return new Intl.Collator('zh-CN'); } catch { return null; } })();

function initialOf(ch) {
  if (/[a-z0-9]/i.test(ch)) return ch.toUpperCase();
  if (!collator || !/[一-鿿]/.test(ch)) return '';
  let lo = 0, hi = BOUNDS.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (collator.compare(ch, BOUNDS[mid]) >= 0) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return hit < 0 ? '' : LETTERS[hit];
}

/** 「微信」→「WX」，「QQ音乐」→「QQYY」。 */
export function pinyinInitials(text) {
  let out = '';
  for (const ch of text) out += initialOf(ch);
  return out;
}
