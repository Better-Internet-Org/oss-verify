# SPDX-License-Identifier: MIT
#
# Container image: ghcr.io/better-internet-org/oss-verify:<tag>
#
# Built + published by .github/workflows/release.yml on every `v*` tag.
# Designed to run in CI environments where Node 22 + the CLI's deps need
# to be available without a per-job install step.
#
# Image is intentionally minimal — Alpine-based, no shell utilities beyond
# what node needs, no cosign (callers install cosign separately if they
# want to sign the resulting predicate).

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY spec ./spec
COPY tsconfig.json ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine
WORKDIR /work
COPY --from=build /app/dist /opt/oss-verify
COPY --from=build /app/node_modules /opt/oss-verify/node_modules
RUN ln -s /opt/oss-verify/cli.mjs /usr/local/bin/oss-verify
ENTRYPOINT ["oss-verify"]
