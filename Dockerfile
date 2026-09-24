# One image for both roles:
#   app:    node dist/src/server/index.js   (UI + API, default)
#   worker: node dist/src/cli.js worker     (load generator)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=4100 \
    LT_DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server/index.js"]
