/**
 * 站点全局配置：改这里就能换掉整站的身份信息与导航。
 */
export const SITE = {
  /** 站点标题，用于 <title> 与 RSS */
  title: 'Sunight的Blog',
  /** 站点副标题 / 一句话简介 */
  tagline: '冰冷似雨 · take what you love and see it through.',
  /** 站点描述，用于 SEO 与 RSS */
  description:
    'Sunight（夙夜）的个人技术博客：Android 系统开发、Shizuku / adb 权限、内核编译与调优、触摸注入、C/C++ 与底层逆向。',
  /** 作者信息 */
  author: 'Sunight',
  /** 展示用昵称 */
  nickname: '夙夜',
  /** 语言 */
  lang: 'zh-CN',
  /** 每页文章数 */
  postsPerPage: 8,
};

/** 顶部导航 */
export const NAV = [
  { label: '首页', href: '/' },
  { label: '归档', href: '/archive' },
  { label: '标签', href: '/tags' },
  // 「小白录制」官网：同一仓库的 screenrecorder/（VitePress），构建后挂在 /screenrecorder/ 下
  { label: '小白录制', href: '/screenrecorder/' },
  { label: '关于', href: '/about' },
];

/** 社交与订阅链接 */
export const SOCIALS = [
  { label: 'GitHub', href: 'https://github.com/Sunight06', icon: 'github' },
  { label: 'RSS', href: '/rss.xml', icon: 'rss' },
  { label: 'Email', href: 'mailto:3622281245@qq.com', icon: 'mail' },
];

/** 首页技能标签 */
export const SKILLS = [
  'Android Framework',
  'Shizuku / adb',
  'Kernel / GKI',
  'C / C++',
  'Reverse Engineering',
  'SurfaceFlinger',
  'Dear ImGui',
  'Accessibility',
];
