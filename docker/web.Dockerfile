# The web app, in REAL mode (no NEXT_PUBLIC_DEMO): the browser talks to
# /api/* and Next rewrites to API_ORIGIN at server start, so CORS never
# exists and only this container needs to face the internet.
FROM node:22-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
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

RUN pnpm --filter @emil/web build

# Drop root: run as the image's unprivileged `node` user (uid 1000). Done after
# the build so `.next/` and its cache are owned by the account that serves them.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@emil/web", "start"]
