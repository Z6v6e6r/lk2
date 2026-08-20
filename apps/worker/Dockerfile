FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY . .
RUN npm ci \
  && npm run contracts:generate \
  && npm run build:packages \
  && npm run build:worker

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs appuser
COPY --from=build /workspace/package.json /workspace/package-lock.json /workspace/.npmrc ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/scripts/verify-production-workspace-imports.js ./scripts/verify-production-workspace-imports.js
COPY --from=build /workspace/scripts/verify-runtime-imports.js ./scripts/verify-runtime-imports.js
RUN find apps packages -name node_modules -prune -exec rm -rf -- {} + \
  && npm ci --omit=dev --include=optional --workspaces --no-audit --no-fund \
  && node scripts/verify-production-workspace-imports.js worker \
  && node scripts/verify-runtime-imports.js \
  && node --input-type=module --eval "await import('sharp')"
USER appuser
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/worker/dist/main.js"]
