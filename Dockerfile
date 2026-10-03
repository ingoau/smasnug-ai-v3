# One image for both processes: the default command runs the worker; run ingress with
# `node dist/ingress/main.js` and migrations with `node dist/db/migrate.js`.
FROM node:26-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production IMAGE_CACHE_DIR=/app/.cache/images
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p .cache/images && chown -R node:node .cache
USER node
CMD ["node", "dist/worker/main.js"]
