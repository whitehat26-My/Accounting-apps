# The worker: outbox relay + scheduled jobs. Connects as emil_worker_login —
# the role that may call the cross-tenant definer functions; the API cannot.
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
COPY apps/worker apps/worker

# Drop root: run as the image's unprivileged `node` user (uid 1000).
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@emil/worker", "start"]
