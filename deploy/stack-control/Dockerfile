FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
COPY code-sandbox.mjs mcp-sandbox.mjs mcp-stream.mjs ./
USER root
EXPOSE 8090
CMD ["node", "server.mjs"]
