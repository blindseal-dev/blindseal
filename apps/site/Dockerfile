# Blindseal public site — Next.js standalone server in a small image.
# Build context = the repo root (pnpm workspace): `docker build -f apps/site/Dockerfile .`
# Runtime env: BLINDSEAL_RPC_URL (mainnet RPC for the explorer's server-side reads; public endpoint
# when unset — rate-limited), PORT (default 3000).

FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
# workspace manifests first (layer cache), then the sources the site build needs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/
COPY packages/verifier-wasm/package.json packages/verifier-wasm/
COPY packages/chain-reads/package.json packages/chain-reads/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile --filter @blindseal/site... --ignore-scripts
COPY apps/site apps/site
COPY packages/verifier-wasm packages/verifier-wasm
COPY packages/chain-reads packages/chain-reads
COPY packages/sdk packages/sdk
# prebuild copies the verifier wasm into public/; standalone output lands in .next/standalone
RUN cd apps/site && pnpm run build

FROM node:20-alpine AS run
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S web && adduser -S web -G web
COPY --from=build --chown=web:web /app/apps/site/.next/standalone ./
COPY --from=build --chown=web:web /app/apps/site/.next/static ./apps/site/.next/static
COPY --from=build --chown=web:web /app/apps/site/public ./apps/site/public
USER web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
# Force the bind address at exec time: App Runner (and other platforms) inject their own HOSTNAME,
# which Next's standalone server would otherwise bind to — then the loopback health check fails.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node apps/site/server.js"]
