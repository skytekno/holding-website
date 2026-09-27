FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY dashboard/package.json ./dashboard/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY tsconfig.base.json ./
COPY dashboard ./dashboard
RUN npm run build --workspace @sky-holding/dashboard

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
COPY --from=builder --chown=node:node /app/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/dashboard/.next/static ./dashboard/.next/static
COPY --from=builder --chown=node:node /app/dashboard/public ./dashboard/public
USER node
EXPOSE 8080
CMD ["node", "dashboard/server.js"]
