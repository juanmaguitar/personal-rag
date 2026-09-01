# The MCP retrieval server, containerised.
#
# Only the RAG query path runs in here: retrieve.mjs + mcp-server.mjs, which
# need @modelcontextprotocol/sdk and zod. Capture (jsdom, turndown, the twitter
# scraper) stays on the Mac and is never exercised in the container.
#
# The index is NOT baked in. It is mounted read-only from a host directory, so
# refreshing the corpus is copying one file, not rebuilding and redeploying.

FROM node:24-alpine

WORKDIR /app

# Deps first: this layer is only invalidated when package-lock.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY *.mjs ./

ENV NODE_ENV=production \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=8770 \
    RAG_INDEX=/indexes/karakeep.json

USER node
EXPOSE 8770

# --host 0.0.0.0 is safe here: the port is never published to the host, so the
# container is only reachable from inside its private Docker network.
CMD ["node", "mcp-server.mjs", "--http"]
