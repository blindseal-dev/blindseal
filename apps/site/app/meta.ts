// Per-page metadata: each route's own canonical URL, og:/twitter: title and description, and the shared
// og:image (public/og-image.png, 1200×630, rendered by scripts/render-brand.mjs). Next merges openGraph and
// twitter SHALLOWLY per page — a page's openGraph drops the parent's images, including a file-convention
// opengraph-image — so every page gets the complete objects from here, image included.
import type { Metadata } from 'next';

export const SITE_URL = 'https://blindseal.tech';
export const SITE_NAME = 'Blindseal';
export const ONE_LINER = "Prove an agent's action was screened — without showing what it was.";

export const OG_IMAGE = { url: '/og-image.png', width: 1200, height: 630, type: 'image/png', alt: "Blindseal — Prove an agent's action was screened, without showing what it was." };

export function pageMeta(o: { path: string; title: string; description: string; ogDescription?: string }): Metadata {
  const ogDescription = o.ogDescription ?? o.description;
  return {
    title: o.title,
    description: o.description,
    alternates: { canonical: o.path },
    openGraph: { type: 'website', siteName: SITE_NAME, url: o.path, title: o.title, description: ogDescription, images: [OG_IMAGE] },
    twitter: { card: 'summary_large_image', title: o.title, description: ogDescription, images: [OG_IMAGE] },
  };
}
