# --- Use pre-built openclaw image ---
ARG OPENCLAW_IMAGE=ghcr.io/xmtplabs/openclaw:staging
FROM ${OPENCLAW_IMAGE} AS openclaw-build


# --- Runtime (no wrapper, just openclaw) ---
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates jq && rm -rf /var/lib/apt/lists/*

COPY --from=openclaw-build /app /openclaw

RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' \
    > /usr/local/bin/openclaw && chmod +x /usr/local/bin/openclaw

ENV OPENCLAW_BUNDLED_PLUGINS_DIR=/openclaw/extensions

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080
EXPOSE 8080
CMD ["/entrypoint.sh"]
