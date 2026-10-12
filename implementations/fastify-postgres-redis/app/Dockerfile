# The Fastify application, containerized the same way as the Harper reference
# (ecommerce-store/containers/Dockerfile): the official node:24 slim image, a production
# dependency install, plain HTTP, NODE_ENV=production.
#
# Node 24 is the Active LTS line (Node 26 is Current until its LTS promotion). The patch release
# is pinned here and recorded with every run; the reference builds from the floating node:24-slim.
FROM docker.io/library/node:24.21.0-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY sql/ sql/
COPY src/ src/

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
