FROM node:22-bookworm-slim AS build

WORKDIR /workspace

ARG PHUB_RELEASE=development

COPY . .

RUN npm ci \
  && npm run contracts:generate \
  && npm run build:packages \
  && PHUB_RELEASE="$PHUB_RELEASE" npm run build -w @phub/web

FROM nginx:1.27-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
