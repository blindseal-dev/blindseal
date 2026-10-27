import type { MetadataRoute } from 'next';
import { SITE_URL } from './meta';
import { ROUTES } from './routes';
import { PAGES } from './docs/content';

// /sitemap.xml — every route: the site's top-level routes (routes.ts) and every docs page (content.ts),
// so a new docs page is listed without touching this file. Each URL equals the canonical its page renders
// (home: no trailing slash).
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [...new Set([...Object.values(ROUTES), ...PAGES.map((p) => p.path)])];
  return paths.map((p) => ({ url: SITE_URL + (p === '/' ? '' : p), changeFrequency: p === '/explorer' ? 'hourly' : 'weekly', priority: p === '/' ? 1 : 0.7 }));
}
