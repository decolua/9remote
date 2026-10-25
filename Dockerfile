FROM node:24-bookworm-slim AS web
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY host/package.json host/package.json
COPY web/package.json web/package.json
COPY desktop/package.json desktop/package.json
COPY gitbook/package.json gitbook/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web web
COPY scripts/buildWebStatic.mjs scripts/buildWebStatic.mjs
RUN node scripts/buildWebStatic.mjs

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server server
COPY shared shared
COPY --from=web /app/web/out /app/web/out
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 DATA_PATH=/data/aremote.sqlite WEB_DIR=/app/web/out
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
