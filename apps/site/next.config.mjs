/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@blindseal/chain-reads'],
  // standalone server for the container image (scripts/deploy-site.sh); the explorer is a server
  // component, so the site needs a Node runtime, not a static export
  output: 'standalone',
  // hosting hygiene: no framework fingerprint header
  poweredByHeader: false,
};
export default nextConfig;
