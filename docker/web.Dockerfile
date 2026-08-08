# The web app, in REAL mode (no NEXT_PUBLIC_DEMO): the browser talks to
# /api/* and Next rewrites to API_ORIGIN at server start, so CORS never
# exists and only this container needs to face the internet.
FROM node:22-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The tsconfig every workspace project `extends`. Without it the extends target
# is missing, the whole tsconfig is discarded, and its compilerOptions go with
# it — which for the API means `experimentalDecorators` is lost and Nest's
# parameter-decorator dependency injection cannot be transformed at all.
COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json    packages/domain/
COPY packages/db/package.json        packages/db/
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/web/package.json           apps/web/

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/web apps/web

# The instance's own name — the sign-in page and the browser tab.
#
# A BUILD ARG rather than a runtime environment variable, and it has to be:
# Next INLINES `NEXT_PUBLIC_*` into the client bundle at build time, so a value
# handed to the running container arrives long after the only moment it could
# have mattered. Setting it in `environment:` looks right, changes nothing, and
# gives no error — which is why it is worth this comment.
#
# Consequence for the operator: changing it needs `up -d --build`, not `up -d`.
ARG NEXT_PUBLIC_APP_NAME
ENV NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME}

# Where /api/* is proxied to — ALSO a build arg, and for a less obvious reason
# than the name above.
#
# `rewrites()` in next.config.ts is evaluated during `next build` and the
# result is frozen into .next/routes-manifest.json. `next start` serves that
# manifest and never re-reads the config, so an API_ORIGIN supplied only at
# runtime arrives after the only moment it mattered — and the image keeps the
# development fallback, 127.0.0.1:3001, which inside a container is the
# container itself. Nothing is listening there, so every write fails with
# ECONNREFUSED while the API sits healthy one hostname away.
ARG API_ORIGIN
ENV API_ORIGIN=${API_ORIGIN}

RUN pnpm --filter @emil/web build

# Drop root: run as the image's unprivileged `node` user (uid 1000). Done after
# the build so `.next/` and its cache are owned by the account that serves them.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@emil/web", "start"]
