# --- Pool agent: uses convos-managed-agent-runtime (OpenClaw from npm) ---
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates jq ripgrep \
    chromium fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdrm2 libgbm1 libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# Install deps (openclaw comes from npm via package.json)
COPY runtime/package.json runtime/pnpm-lock.yaml /app/
RUN pnpm install --no-frozen-lockfile
ENV NODE_PATH=/app/node_modules

COPY runtime/openclaw /app/openclaw
COPY runtime/cli /app/cli
RUN chmod +x /app/cli/scripts/*.sh

ENV OPENCLAW_STATE_DIR=/app
ENV HUSKY=0
RUN npm install -g husky

ENV CHROMIUM_PATH=/usr/bin/chromium
ENV PORT=8080
EXPOSE 8080

# Pool-server is the entrypoint (not pnpm start)
CMD ["node", "cli/pool-server.js"]
