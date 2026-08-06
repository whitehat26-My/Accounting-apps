import { createClient } from './client.js';
import { createInvite, listOpenInvites } from './invite.js';

/**
 * Mint an invitation to open an account on this installation.
 *
 * ---------------------------------------------------------------------------
 * A CLI, RUN ON THE SERVER, DELIBERATELY.
 *
 * There is no route for this and there should not be. `emil_app` — the role
 * the internet-facing API connects as — holds SELECT and UPDATE on
 * `signup_invite` and NOT INSERT (0051), so the API physically cannot mint one
 * even if somebody added an endpoint by mistake. Minting requires the
 * migrating role's connection string, which lives on the server and nowhere
 * else.
 *
 * The token is printed ONCE. Only its SHA-256 is stored, so it cannot be
 * recovered — if it is lost, mint another and let the first expire. That is
 * the correct property for a credential, not an inconvenience to design around.
 *
 *   docker compose -f docker-compose.prod.yml exec api \
 *     node dist/invite-cli.js --email owner@company.com --note "Delima, agreed 12/08"
 *
 * or from a checkout on the server:
 *
 *   DATABASE_URL=… pnpm --filter @emil/db invite -- --email owner@company.com
 *   DATABASE_URL=… pnpm --filter @emil/db invite -- --list
 * ---------------------------------------------------------------------------
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Minting needs the MIGRATING role — the app role ' +
        'has no INSERT on signup_invite, on purpose (see 0051).',
    );
  }

  const sql = createClient(url);
  try {
    if (process.argv.includes('--list')) {
      const open = await listOpenInvites(sql);
      if (open.length === 0) {
        console.log('No invitations outstanding.');
        return;
      }
      console.log(`${open.length} invitation(s) outstanding:\n`);
      for (const invite of open) {
        console.log(
          `  ${invite.expiresAt.slice(0, 10)}  ${invite.email ?? '(any email)'}` +
            `${invite.note ? `  — ${invite.note}` : ''}`,
        );
      }
      // Not the tokens: only their digests are stored, so they are gone.
      console.log('\n(Tokens are not stored and cannot be reprinted. Mint a new one.)');
      return;
    }

    const days = Number(flag('days') ?? 14);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('--days must be a whole number between 1 and 365.');
    }

    const invite = await createInvite(sql, {
      ...(flag('email') ? { email: flag('email')! } : {}),
      ...(flag('note') ? { note: flag('note')! } : {}),
      days,
    });

    console.log('\nInvitation created.\n');
    console.log(`  Code     ${invite.token}`);
    console.log(`  For      ${invite.email ?? 'any email address'}`);
    console.log(`  Expires  ${invite.expiresAt.slice(0, 10)}\n`);
    console.log('Send the code to the person signing up. It works once.');
    console.log('It is not stored anywhere and will not be shown again.\n');
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
