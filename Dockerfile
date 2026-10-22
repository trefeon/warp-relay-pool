FROM node:22-alpine
WORKDIR /app
# Lockfile-pinned install: the relay is the network boundary, so two builds of
# the same commit must resolve the same undici.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs signal-writer.mjs ./
EXPOSE 3000-3064
# No privileged ports or filesystem writes.
USER node
CMD ["node", "server.mjs"]
