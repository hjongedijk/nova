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
# Pin the official GitHub MCP server and verify the upstream release checksum per architecture.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) gh_arch=x86_64; gh_sha=815e27d931c796af0c97f24fd211e14f8a4607d4528377719a5ad2352086b0b0 ;; \
      arm64) gh_arch=arm64; gh_sha=73f5e76c6a3b5e0d731e1134a7c38575df6ec96c646192095a3be2d4d0d6c1fc ;; \
      *) echo "Unsupported architecture for GitHub MCP: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/github-mcp \
    && wget -q "https://github.com/github/github-mcp-server/releases/download/v2.0.2/github-mcp-server_Linux_${gh_arch}.tar.gz" -O /tmp/github-mcp.tar.gz \
    && echo "$gh_sha  /tmp/github-mcp.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/github-mcp.tar.gz -C /opt/github-mcp github-mcp-server \
    && chmod 0755 /opt/github-mcp/github-mcp-server \
    && rm -f /tmp/github-mcp.tar.gz
COPY deploy/mcp-servers.json /app/mcp-servers.default.json
ENV NOVA_MCP_DEFAULT=/app/mcp-servers.default.json
# The Windows agent is downloaded from NOVA's settings screen.
COPY agents/windows-legacy/nova-agent.ps1 agents/windows-legacy/jarvis-agent.ps1 agents/windows-legacy/install.ps1 agents/windows-legacy/
ARG NOVA_VERSION=dev
ENV NOVA_VERSION=${NOVA_VERSION}
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/nova/health >/dev/null || exit 1
CMD ["node", "apps/api/dist/main.js"]
