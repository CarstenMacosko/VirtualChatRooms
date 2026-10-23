# One always-on machine for the API, the realm and the built web app (ADR 0016's "later"
# setup): the API serves the app, answers /api and forwards /realm, so it's all one origin.
# Fly.io: see docs/deploy.md. Data (PGlite database, uploaded room scans) lives on /data.

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Clerk's publishable key is baked into the web app at build time (fly deploy --build-arg).
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN pnpm --filter @vcr/web build

FROM node:24-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=8080 \
    REALM_PORT=2567 \
    API_URL=http://127.0.0.1:8080 \
    REALM_PROXY_URL=http://127.0.0.1:2567 \
    WEB_DIST_DIR=/app/apps/web/dist \
    PGLITE_DIR=/data/pglite \
    STORAGE_DIR=/data/storage
EXPOSE 8080
CMD ["node", "scripts/start-production.mjs"]
