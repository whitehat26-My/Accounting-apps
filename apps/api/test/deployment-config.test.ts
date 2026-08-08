/**
 * The deployment path must be able to SET every setting the API reads.
 *
 * This exists because of a bug it would have caught. `PUBLIC_BASE_URL` — the
 * address printed as a QR code on every invoice, receipt, warranty card and
 * repair report — was read by `config.ts`, defaulted to `http://localhost:3000`,
 * and named in NO deployment file. `docker-compose.prod.yml` gives a container
 * only the variables listed in its `environment:` block, so the value could not
 * be set at all: every deployed shop printed a verification code pointing at the
 * customer's own machine. It was invisible because it is not an error — the
 * document renders perfectly, the QR code scans, and the link is dead.
 *
 * `SIGNUP_MODE` had the same shape and was worse for being documented:
 * `docs/DEPLOY.md` told the operator to set it in `.env.prod`, where compose
 * would have silently ignored it.
 *
 * So the test is not "these two variables are present" — it is that the set of
 * variables `config.ts` reads and the set the production path can supply cannot
 * drift apart without somebody saying, here, why.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig, verifyUrl } from '../src/config.js';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Variables `config.ts` reads that the production compose file deliberately
 * does NOT pass, each with the reason. Adding to this list is a decision;
 * that is the entire point of making it explicit.
 */
const NOT_PLUMBED: Record<string, string> = {
  NODE_ENV: 'set literally to `production` in the compose file, not interpolated.',
  PORT: 'the container port is fixed; the host mapping is WEB_PORT on `web`.',
  RATE_LIMIT: 'default 600/min is right for a shop; no operator has needed to move it.',
  RATE_LIMIT_WINDOW_MS: 'as RATE_LIMIT — the pair is tuned together or not at all.',
  PUBLIC_RATE_LIMIT: 'default 30/min guards the pay links; lowering is the only safe direction and nobody has asked.',
  EMIL_ENABLE_FAKE_GATEWAY: 'test-only, and `loadConfig` REFUSES it when NODE_ENV=production.',
  EMIL_ENABLE_SANDBOX_VALUES: 'test-only, and refused in production for the same reason.',
  EMIL_ENABLE_FAKE_ASSISTANT: 'test-only, and refused in production for the same reason.',
};

/**
 * Variables `apps/web` reads that the compose file deliberately does not pass.
 */
const WEB_NOT_PLUMBED: Record<string, string> = {
  NEXT_PUBLIC_BASE_PATH:
    'set by next.config.ts from DEMO_BASE_PATH for the GitHub Pages export, which '
    + 'is served under a repository sub-path. The real deployment is served from '
    + 'the root, where the correct value is the empty string it already defaults to.',
  NEXT_PUBLIC_DEMO:
    'the GitHub Pages static export, where the whole backend is a browser stub. '
    + 'Making it settable in the PRODUCTION compose file is the one thing it must '
    + 'never be: a real deployment silently serving fake books.',
};

/** Every `env['X']` the API config reads. */
function envNamesReadByConfig(): string[] {
  const source = read('apps/api/src/config.ts');
  return [...new Set([...source.matchAll(/env\['([A-Z0-9_]+)'\]/g)].map((m) => m[1]!))].sort();
}

/** One service's text, from its own line to the next service or top-level key. */
function serviceBlock(service: string): string[] {
  const lines = read('docker-compose.prod.yml').split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  expect(start, `docker-compose.prod.yml has no \`${service}\` service`).toBeGreaterThan(-1);

  const end = lines.findIndex((l, i) => i > start && /^(?: {2})?\S/.test(l));
  return lines.slice(start, end === -1 ? lines.length : end);
}

/**
 * The keys declared under one section of one service.
 *
 * Takes the section name rather than assuming `environment:`, because the two
 * that matter sit at different depths and mean different things: `environment:`
 * reaches a RUNNING container, `args:` (nested under `build:`) reaches the
 * BUILD. `NEXT_PUBLIC_*` is inlined by Next at build time, so for the web app
 * only the second one is capable of setting anything — an `environment:` entry
 * would look correct, do nothing, and never warn. Matching on indentation
 * relative to the section header keeps this true wherever the block sits.
 */
function composeKeys(service: string, section: 'environment' | 'args'): string[] {
  const lines = serviceBlock(service);
  const header = lines.findIndex((l) => l.trim() === `${section}:`);
  if (header === -1) return [];

  const depth = lines[header]!.search(/\S/);
  const keys: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.search(/\S/) <= depth) break;
    const key = /^\s*([A-Z][A-Z0-9_]*):/.exec(line);
    if (key) keys.push(key[1]!);
  }
  return [...new Set(keys)].sort();
}

const envNamesPassedToApi = () => composeKeys('api', 'environment');

/** Every `NEXT_PUBLIC_*` the web app reads, anywhere in its source. */
function envNamesReadByWeb(): string[] {
  const src = join(root, 'apps/web/src');
  const found = execFileSync('grep', ['-rhoE', 'NEXT_PUBLIC_[A-Z0-9_]+', src], { encoding: 'utf8' });
  return [...new Set(found.split('\n').filter(Boolean))].sort();
}

describe('the production deployment can set what the API reads', () => {
  it('names every configurable variable in docker-compose.prod.yml', () => {
    const passed = new Set(envNamesPassedToApi());
    const unreachable = envNamesReadByConfig()
      .filter((name) => !passed.has(name) && !(name in NOT_PLUMBED));

    expect(
      unreachable,
      `config.ts reads ${unreachable.join(', ')}, but docker-compose.prod.yml never passes `
        + 'it to the api container — so a deployment CANNOT set it, whatever .env.prod says. '
        + 'Add it to the api service\'s environment: block, or add it to NOT_PLUMBED in this '
        + 'test with the reason it does not need to be settable.',
    ).toEqual([]);
  });

  it('documents every plumbed variable in the DEPLOY.md reference table', () => {
    const table = read('docs/DEPLOY.md');
    const undocumented = envNamesPassedToApi()
      // Not a knob: the compose file composes it from the two role passwords.
      .filter((name) => name !== 'DATABASE_URL' && name !== 'NODE_ENV')
      .filter((name) => !table.includes(`\`${name}\``));

    expect(
      undocumented,
      `${undocumented.join(', ')} can be set in .env.prod but appears nowhere in `
        + 'docs/DEPLOY.md. A setting nobody can find is a setting nobody sets.',
    ).toEqual([]);
  });

  it('offers every settable variable in .env.prod.example', () => {
    const example = read('.env.prod.example');
    const missing = envNamesPassedToApi()
      .filter((name) => name !== 'DATABASE_URL' && name !== 'NODE_ENV')
      // The two role passwords are interpolated into DATABASE_URL, not read directly.
      .filter((name) => !new RegExp(`^#?\\s*${name}=`, 'm').test(example));

    expect(
      missing,
      `${missing.join(', ')} is missing from .env.prod.example, so an operator who copies `
        + 'the example gets a file that cannot express it.',
    ).toEqual([]);
  });
});

describe('the production deployment can set what the WEB APP reads', () => {
  // This suite exists because the API-only version of it did not catch the bug
  // it was written for. `NEXT_PUBLIC_APP_NAME` — the name on the sign-in page,
  // the first thing a second company's staff would see — was read by the web
  // app, documented in DEPLOY.md as settable, and reachable from no deployment
  // at all: no ARG in web.Dockerfile, and nothing but API_ORIGIN passed to the
  // `web` service. Every install would have said "Shah G Tech" for ever.
  it('passes every NEXT_PUBLIC_* the web app reads as a BUILD ARG', () => {
    const passed = new Set(composeKeys('web', 'args'));
    const unreachable = envNamesReadByWeb()
      .filter((name) => !passed.has(name) && !(name in WEB_NOT_PLUMBED));

    expect(
      unreachable,
      `apps/web reads ${unreachable.join(', ')}, but docker-compose.prod.yml does not pass `
        + 'it under the web service\'s build.args. Next INLINES NEXT_PUBLIC_* at build time, '
        + 'so an environment: entry cannot set it and would fail silently. Add it to '
        + 'build.args, or to WEB_NOT_PLUMBED with the reason it must not be settable.',
    ).toEqual([]);
  });

  it('never lets a runtime environment entry pretend to set a build-time value', () => {
    const runtime = composeKeys('web', 'environment').filter((k) => k.startsWith('NEXT_PUBLIC_'));

    expect(
      runtime,
      `${runtime.join(', ')} is under the web service's environment:, where it reaches the `
        + 'running container long after Next compiled the value into the pages. It looks '
        + 'set, it is not, and nothing reports the difference. Move it to build.args.',
    ).toEqual([]);
  });

  it('offers and documents what it passes', () => {
    const example = read('.env.prod.example');
    const deploy = read('docs/DEPLOY.md');

    for (const name of composeKeys('web', 'args')) {
      expect(
        new RegExp(`^#?\\s*${name}=`, 'm').test(example),
        `${name} is a build arg but is missing from .env.prod.example`,
      ).toBe(true);
      expect(deploy.includes(`\`${name}\``), `${name} appears nowhere in docs/DEPLOY.md`).toBe(true);
    }
  });
});

describe('PUBLIC_BASE_URL', () => {
  const base = {
    DATABASE_URL: 'postgres://x@localhost/x',
    JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
  };

  it('is what the document QR code points at', () => {
    expect(verifyUrl({ PUBLIC_BASE_URL: 'https://books.shahgtech.com' }))
      .toBe('https://books.shahgtech.com/verify');
  });

  it('tolerates the trailing slash somebody will paste from a browser', () => {
    expect(verifyUrl({ PUBLIC_BASE_URL: 'https://books.shahgtech.com///' }))
      .toBe('https://books.shahgtech.com/verify');
  });

  it('treats a blank value as unset rather than refusing to boot', () => {
    // `.env.prod.example` ships `PUBLIC_BASE_URL=`, and compose hands that to
    // the container as '' rather than as absent. `'' ?? default` is `''`, which
    // the URL schema rejects — so before this the API died on a blank line in a
    // config file, at boot, with a validation error about a QR code.
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: '   ' })).not.toThrow();
    expect(verifyUrl({ PUBLIC_BASE_URL: '' })).toBe('http://localhost:3000/verify');
  });

  it('agrees with loadConfig, which reads the same variable separately', () => {
    const env = { ...base, PUBLIC_BASE_URL: 'https://books.example.com/' };
    expect(verifyUrl(env)).toBe(`${loadConfig(env).publicBaseUrl.replace(/\/+$/, '')}/verify`);
  });
});

describe('SIGNUP_MODE', () => {
  const base = {
    DATABASE_URL: 'postgres://x@localhost/x',
    JWT_SECRET: 'a-secret-that-is-at-least-32-characters',
  };

  it('closes registration when nobody has said otherwise', () => {
    expect(loadConfig(base).signupMode).toBe('invite');
    expect(loadConfig({ ...base, SIGNUP_MODE: '' }).signupMode).toBe('invite');
  });

  it('opens only on the explicit word', () => {
    expect(loadConfig({ ...base, SIGNUP_MODE: 'open' }).signupMode).toBe('open');
  });
});
