# Flights Overhead: paperlesspaper Open Integration host.
# server.mjs has no runtime dependencies, so no npm install is needed.
FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production \
    PORT=4400
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4400/health || exit 1
CMD ["node", "server.mjs"]
