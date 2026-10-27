import type { MetadataRoute } from 'next';
import { SITE_URL } from './meta';

// /robots.txt — everything is public; points at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/' }], sitemap: `${SITE_URL}/sitemap.xml`, host: SITE_URL };
}
