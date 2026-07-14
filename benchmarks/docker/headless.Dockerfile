# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ git make python3 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
  && npm rebuild node-pty \
  && npm cache clean --force
COPY . .
ARG ZCH_SOURCE_COMMIT=development
ARG ZCH_SOURCE_TREE_STATE=unknown
ENV ZCH_SOURCE_COMMIT=${ZCH_SOURCE_COMMIT}
ENV ZCH_SOURCE_TREE_STATE=${ZCH_SOURCE_TREE_STATE}
RUN npm run build:headless \
  && npm run build:worker-services \
  && npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 zch \
  && useradd --uid 10001 --gid zch --create-home --home-dir /home/zch zch
WORKDIR /opt/zch
COPY --from=build /src/dist-headless/zch-agent-headless.mjs ./
COPY --from=build /src/dist-worker/provider-proxy.mjs ./
COPY --from=build /src/dist-worker/fake-provider.mjs ./
COPY --from=build /src/dist-worker/grader.mjs ./
COPY --from=build /src/resources/prompts ./resources/prompts
COPY --from=build /src/node_modules ./node_modules
COPY --chmod=0555 benchmarks/docker/entrypoint.sh /usr/local/bin/zch-worker
ARG ZCH_SOURCE_COMMIT=development
ARG ZCH_SOURCE_TREE_STATE=unknown
LABEL org.opencontainers.image.title="Zch Agent Headless Worker" \
  org.opencontainers.image.revision="${ZCH_SOURCE_COMMIT}" \
  com.zch.source-tree="${ZCH_SOURCE_TREE_STATE}" \
  com.zch.runtime.platform="linux-x64" \
  com.zch.runtime.libc="glibc" \
  com.zch.runtime.node="v24"
ENV HOME=/home/zch
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zch-worker"]
CMD ["run"]
