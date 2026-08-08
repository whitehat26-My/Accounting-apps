# The API. Runs from source via tsx — the same way `pnpm start` runs it in
# development, so there is no compiled artefact to drift from the tests.
FROM node:22-slim

WORKDIR /app
RUN corepack enable

# Manifests first, so dependency layers cache across source-only changes.
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

# Dev dependencies included on purpose: tsx (the runtime) is one of them.
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/api apps/api

# Drop root: the image ships a `node` user (uid 1000). The build ran as root,
# so hand the tree to that user and run as it — a container escape then lands
# as an unprivileged account, not root.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@emil/api", "start"]
