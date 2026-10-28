/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@blindseal/chain-reads'],
  // standalone server for the container image (scripts/deploy-site.sh); the explorer is a server
  // component, so the site needs a Node runtime, not a static export
  output: 'standalone',
  // hosting hygiene: no framework fingerprint header
  poweredByHeader: false,
  // Next 15 streams the metadata of dynamic routes (/explorer) into <body> and moves it into <head> after
  // hydration, except for user agents matching htmlLimitedBots. Match every agent: metadata is always
  // rendered blocking in <head>, so the server HTML is the DOM React hydrates (no post-hydration move).
  htmlLimitedBots: /.*/,
};
export default nextConfig;
