# MinIO server for the disposable test stand, built from the upstream source tag.
# Upstream stopped serving its quay.io / Docker Hub images (both answer 401), so the stand builds
# the same release itself. The tag is pinned to its commit; a moved tag fails the build.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS=linux TARGETARCH=amd64
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
  && git fetch -q --depth 1 https://github.com/minio/minio.git "refs/tags/$MINIO_RELEASE:refs/tags/$MINIO_RELEASE" \
  && git checkout -q "$MINIO_RELEASE" \
  && test "$(git rev-parse HEAD)" = "$MINIO_COMMIT"
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags kqueue -trimpath -ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio .

FROM alpine:3.20
# curl serves the compose healthcheck.
RUN apk add --no-cache ca-certificates curl
COPY --from=build /out/minio /usr/bin/minio
EXPOSE 9000
ENTRYPOINT ["/usr/bin/minio"]
