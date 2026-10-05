# One NOVA image: NestJS API + the built Svelte app (+ TTS and tools once ported).
# Build: docker build -t ghcr.io/hjongedijk/nova:dev .

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --workspace @nova/api --workspace @nova/web --workspace @nova/contracts --include-workspace-root
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build -w @nova/web && npm run build -w @nova/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NOVA_AGENTS_DIR=/app/agents \
    PORT=8080 \
    HTTPS_PORT=8443 \
    NOVA_DATA_DIR=/data \
    NOVA_WEB_DIR=/app/web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev --workspace @nova/api && npm cache clean --force
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/web/build web
# MCP servers NOVA can use, installed once so nothing is downloaded at runtime. The default list is
# used until the user puts their own mcp-servers.json in the data folder.
RUN npm install -g --omit=dev \
      @modelcontextprotocol/server-sequential-thinking \
      @modelcontextprotocol/server-filesystem \
      @upstash/context7-mcp \
    && npm cache clean --force
COPY deploy/mcp-servers.json /app/mcp-servers.default.json
ENV NOVA_MCP_DEFAULT=/app/mcp-servers.default.json
# The Windows agent is downloaded from NOVA's settings screen.
COPY agents/windows/jarvis-agent.ps1 agents/windows/install.ps1 agents/windows/
ARG NOVA_VERSION=dev
ENV NOVA_VERSION=${NOVA_VERSION}
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/nova/health >/dev/null || exit 1
CMD ["node", "apps/api/dist/main.js"]
