FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8787 \
    IP_FILE=/app/config/ip.txt \
    DATA_DIR=/app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node

EXPOSE 8787

VOLUME ["/app/data", "/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]