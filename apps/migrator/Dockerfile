FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY . .
RUN npm ci \
  && npm run contracts:generate \
  && npm run build:packages \
  && npm run build:migrator

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs appuser
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/database/migrations ./migrations
RUN npm prune --omit=dev --workspaces
USER appuser
CMD ["node", "apps/migrator/dist/main.js"]
