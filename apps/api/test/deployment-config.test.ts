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

/** Every `env['X']` the API config reads. */
function envNamesReadByConfig(): string[] {
  const source = read('apps/api/src/config.ts');
  return [...new Set([...source.matchAll(/env\['([A-Z0-9_]+)'\]/g)].map((m) => m[1]!))].sort();
}

/** Every `${X...}` interpolation reaching the `api` service's environment. */
function envNamesPassedToApi(): string[] {
  const compose = read('docker-compose.prod.yml');
  const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  const block = api.slice(api.indexOf('environment:'));
  const declared = [...block.matchAll(/^\s{6}([A-Z0-9_]+):/gm)].map((m) => m[1]!);
  return [...new Set(declared)].sort();
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
