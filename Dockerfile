# One NOVA image: the NestJS API (with speech and all tools) and the built Svelte app.
# Build: docker build -t ghcr.io/hjongedijk/nova:dev .

FROM node:24-alpine AS build
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

FROM node:24-alpine AS runtime
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
COPY deploy/stack-control/ /app/stack-control/
# MCP servers NOVA can use, installed once so nothing is downloaded at runtime. The default list is
# used until the user puts their own mcp-servers.json in the data folder.
RUN npm install -g --omit=dev \
      @modelcontextprotocol/server-sequential-thinking@1.0.0 \
      @modelcontextprotocol/server-filesystem@1.0.0 \
      @upstash/context7-mcp@4.3.0 \
    && npm cache clean --force
# Pin the read-only Git MCP runtime. It starts against one project directory per tool call.
RUN apk add --no-cache python3 py3-pip git tar \
    && python3 -m venv /opt/git-mcp \
    && /opt/git-mcp/bin/pip install --no-cache-dir 'mcp-server-git==2026.8.18'
# The optional arXiv literature server uses an isolated, pinned Python environment.
RUN python3 -m venv /opt/arxiv-mcp \
    && /opt/arxiv-mcp/bin/pip install --no-cache-dir 'arxiv-mcp-server==0.8.2'
# The reviewed CalDAV MCP runs read-only, with a fixed read-tool allowlist.
COPY deploy/mcp-servers/caldav/package.json deploy/mcp-servers/caldav/package-lock.json /opt/caldav-mcp/
RUN npm ci --omit=dev --prefix /opt/caldav-mcp \
    && npm cache clean --force
# The optional IMAP MCP uses an immutable package lock and a fixed read-only tool allowlist.
COPY deploy/mcp-servers/imap/package.json deploy/mcp-servers/imap/package-lock.json /opt/imap-mcp/
RUN npm ci --omit=dev --prefix /opt/imap-mcp \
    && npm cache clean --force
COPY deploy/mcp-servers.json /app/mcp-servers.default.json
ENV NOVA_MCP_DEFAULT=/app/mcp-servers.default.json
# The Windows agent is downloaded from NOVA's settings screen.
COPY agents/windows/nova-agent.ps1 agents/windows/jarvis-agent.ps1 agents/windows/install.ps1 agents/windows/
ARG NOVA_VERSION=dev
ENV NOVA_VERSION=${NOVA_VERSION}
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/nova/health >/dev/null || exit 1
CMD ["node", "apps/api/dist/main.js"]
