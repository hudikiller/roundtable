ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tar \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.153.4 \
    && mkdir -p /workspace /codex /app && chown node:node /workspace /codex
# Optional model metadata (see scripts/extract-model-catalog.mjs); an empty directory is fine.
COPY docker/models/ /app/models/
COPY docker/proxy.mjs docker/entrypoint.mjs /app/
RUN chmod -R a+rX /app && chmod 0644 /app/proxy.mjs /app/entrypoint.mjs
ENV HOME=/tmp/home CODEX_HOME=/codex
WORKDIR /workspace
USER node
CMD ["node", "/app/entrypoint.mjs"]
