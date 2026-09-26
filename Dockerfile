# Runs verdix-mcp over stdio (used by Glama's health check and inspector).
# Without VERDIX_PRIVATE_KEY only the free get_pricing tool can be used.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENTRYPOINT ["node", "src/index.js"]
