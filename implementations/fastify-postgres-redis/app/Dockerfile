# The Fastify application, containerized the same way as the Harper reference
# (ecommerce-store/containers/Dockerfile): the official node:24 slim image, a production
# dependency install, plain HTTP, NODE_ENV=production.
#
# Node 24 is the Active LTS line (Node 26 is Current until its LTS promotion). The base image is
# pinned by its multi-arch index digest, so tier 1 (arm64) and tier 2 (x86-64) build on the same
# release; compose.yaml passes the same value and every run records it.
ARG NODE_IMAGE=docker.io/library/node:24.21.0-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${NODE_IMAGE}

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY sql/ sql/
COPY src/ src/

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
