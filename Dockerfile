# Pinned for reproducible builds; bump deliberately (see README → Deploying).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22.23.4-alpine3.23

# ---- build ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Optional: pass --build-arg BUILD_ID=<sha> to label the build; defaults to a timestamp.
ARG BUILD_ID
RUN npm run build && npm prune --omit=dev

# ---- runtime -------------------------------------------------------------
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
USER node
# Migrations run in Heroku's release phase (heroku.yml → dist/server/migrate.js) and again,
# under an advisory lock, on boot. The server handles SIGTERM/SIGINT itself (graceful
# shutdown), so it can run as PID 1 without an init.
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/index.js"]
