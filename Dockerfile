# place world server
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY world-server.js ./

ENV HOST=0.0.0.0 \
    PORT=8090
EXPOSE 8090

# WORLD_STATE_FILE=/data/world.bin + a mounted volume keeps the map across restarts.
CMD ["node", "world-server.js"]
