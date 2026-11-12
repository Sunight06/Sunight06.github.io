import type { APIContext } from 'astro';

export async function GET({ site }: APIContext) {
  const base = (site?.href ?? 'https://sunight06.github.io/').replace(/\/+$/, '');

  const body = `User-agent: *
Allow: /

# 构建产物与索引文件不必抓取
Disallow: /search.json

Sitemap: ${base}/sitemap-index.xml
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
