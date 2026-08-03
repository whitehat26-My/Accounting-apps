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

RUN pnpm --filter @emil/web build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@emil/web", "start"]
