# Pittwater Signage server image
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 needs build tools at install time only.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --build-from-source=false \
 && npm cache clean --force

# ---- runtime image ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# Copy node_modules from build stage so we don't ship build tools
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# Make the app code readable by the unprivileged 'node' user no matter what
# permissions the host files happen to have. Persistent state lives in
# /app/data — mount this as a volume.
RUN chown -R node:node /app \
 && find /app/server /app/public -type d -exec chmod 755 {} + \
 && find /app/server /app/public -type f -exec chmod 644 {} + \
 && mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node

EXPOSE 3000
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

CMD ["node", "server/index.js"]
