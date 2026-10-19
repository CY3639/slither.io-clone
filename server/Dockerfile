# Game server image (one authoritative world per container).
# Built for linux/arm64 to run on Fargate Graviton (cheaper per vCPU-hour than x86).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Run as the unprivileged user shipped with the official image.
USER node
EXPOSE 8080

# Liveness: fails if the tick loop stalls (see /health). ECS uses the same check.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec form so node is PID 1 and receives SIGTERM from ECS directly.
CMD ["node", "src/index.js"]
