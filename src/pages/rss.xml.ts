import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { SITE } from '../consts';
import { byDateDesc, postUrl, published } from '../utils';

export async function GET(context: APIContext) {
  const posts = byDateDesc(published(await getCollection('blog')));

  return rss({
    title: SITE.title,
    description: SITE.description,
    site: context.site ?? 'https://sunight06.github.io',
    trailingSlash: true,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: postUrl(post),
      categories: post.data.tags,
      author: SITE.author,
    })),
    customData: `<language>zh-cn</language><copyright>© ${new Date().getFullYear()} ${SITE.author}</copyright>`,
  });
}
