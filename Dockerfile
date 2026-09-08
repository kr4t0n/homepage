# Two stages: build the site and bundle the server, then ship only the results.
#
# The runtime stage carries no node_modules at all. `npm run build:server`
# bundles Hono and @hono/node-server into one file, so the image is the Node
# base plus dist/ and a single .mjs. That also keeps every build-time dependency
# out of the published image, which is the cheapest way to keep its
# vulnerability surface close to whatever the base image has.

# Pinned to the major that `npm run verify:api` already requires (Node's type
# stripping sets that floor). Alpine because nothing here needs glibc.
FROM node:22-alpine AS build

WORKDIR /app

# Copied first and separately so this layer caches on the lockfile alone. Source
# edits then rebuild without re-resolving every dependency.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `npm run build` runs `tsc -b` before Vite, so a type error fails the image
# build rather than shipping. Both outputs are needed: dist/ is the site,
# dist-server/ is the process that serves it.
RUN npm run build && npm run build:server

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

# The base image ships this unprivileged user. Nothing here writes to disk, so
# there is no reason to run the server as root.
USER node

EXPOSE 8080

# Uses the liveness route the API already exposes, which deliberately does not
# touch Argus: an upstream outage must not make this container look dead. Node
# rather than wget or curl, so the check does not depend on which of those the
# base image happens to include.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, no shell. The server drains on SIGTERM, and a shell wrapper would
# swallow the signal and leave Kubernetes to SIGKILL it after the grace period.
CMD ["node", "dist-server/server.mjs"]
