/**
 * Next's ambient types, in a file that git actually tracks.
 *
 * `next-env.d.ts` carries these two references and is gitignored (Next
 * regenerates it on every dev/build), so it exists on every developer's disk
 * and has never existed in CI. `next/image-types/global` is what declares
 * `*.png` / `*.jpg` as modules — without it `import mark from '@/brand/mark.png'`
 * is TS2307, and `pnpm typecheck` passed locally while failing on a clean
 * checkout. That is the worst shape a check can have: green for everyone who
 * could fix it.
 *
 * Deliberately NOT a committed copy of `next-env.d.ts`. That file also carries
 * `/// <reference path="./.next/types/routes.d.ts" />`, which is BUILD output —
 * committing it trades TS2307 for TS6053 "file not found" whenever typecheck
 * runs before a build, which in CI is always.
 *
 * Duplicating the two `reference types` lines is free: TypeScript resolves each
 * to the same package types and includes them once.
 */

/// <reference types="next" />
/// <reference types="next/image-types/global" />
