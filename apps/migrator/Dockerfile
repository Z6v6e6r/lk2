FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /workspace
COPY . .
RUN npm ci \
  && npm run contracts:generate \
  && npm run build:packages \
  && npm run build:migrator

FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production
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
