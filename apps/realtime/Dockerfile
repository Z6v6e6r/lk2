FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY . .
RUN npm ci \
  && npm run contracts:generate \
  && npm run build:packages \
  && npm run build:realtime

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs appuser
COPY --from=build /workspace/package.json /workspace/package-lock.json ./
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/node_modules ./node_modules
RUN npm prune --omit=dev --workspaces
USER appuser
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/realtime/dist/main.js"]
