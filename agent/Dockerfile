# --- Build openclaw from source ---
FROM node:22-bookworm AS openclaw-build

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git ca-certificates curl python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"
RUN corepack enable

WORKDIR /openclaw

ARG OPENCLAW_CACHE_BUST=1
ARG OPENCLAW_GIT_REPO=https://github.com/xmtplabs/openclaw.git
ARG OPENCLAW_GIT_REF=staging
RUN echo "cache-bust=${OPENCLAW_CACHE_BUST}" \
    && git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" "${OPENCLAW_GIT_REPO}" .

RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN git rev-parse HEAD > .git-commit
RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# --- Runtime (no wrapper, just openclaw) ---
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=openclaw-build /openclaw /openclaw

RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' \
    > /usr/local/bin/openclaw && chmod +x /usr/local/bin/openclaw

ENV OPENCLAW_BUNDLED_PLUGINS_DIR=/openclaw/extensions

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080
EXPOSE 8080
CMD ["/entrypoint.sh"]
