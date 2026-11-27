# MiniEmpire: one container serves the game client and the WebSocket relay.
#   docker build -t miniempire .
#   docker run -p 8080:8080 miniempire
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --no-audit --no-fund
COPY . .
RUN node scripts/check-determinism.mjs && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY --from=build /app/packages/client/package.json ./packages/client/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "--import", "tsx", "packages/server/src/index.ts"]
