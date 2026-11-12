// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages 用户站点（sunight06.github.io）发布在根路径。
  // 若改用自定义域名（例如 https://www.sunight.cn），只需修改这里并添加 public/CNAME。
  site: 'https://sunight06.github.io',
  trailingSlash: 'ignore',
  integrations: [
    sitemap({
      filter: (page) => !page.includes('/404'),
    }),
  ],
  markdown: {
    // 双主题语法高亮：跟随站点明暗模式自动切换
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: false,
    },
  },
  devToolbar: {
    enabled: false,
  },
});
