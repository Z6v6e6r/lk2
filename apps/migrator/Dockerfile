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
COPY --from=build /workspace/package.json /workspace/package-lock.json /workspace/.npmrc ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/packages/database/migrations ./migrations
COPY --from=build /workspace/scripts/verify-production-workspace-imports.js ./scripts/verify-production-workspace-imports.js
RUN find apps packages -name node_modules -prune -exec rm -rf -- {} + \
  && npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund \
  && node scripts/verify-production-workspace-imports.js migrator
USER appuser
CMD ["node", "apps/migrator/dist/main.js"]
