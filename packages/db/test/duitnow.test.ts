import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTlv, verifyQr } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { buildQrForAmount, DuitNowNotConfiguredError } from '../src/duitnow.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The wire between stored merchant configuration and the EMVCo encoder.
 *
 * The encoder itself is tested in packages/domain against the published CRC
 * check vector; what is tested here is the half that can go wrong in a shop —
 * a configuration that is incomplete in one of four different ways, each of
 * which must refuse rather than produce a QR that scans and pays nobody.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('duitnow');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'QR Shop Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

/** Replace the DuitNow row wholesale, so each test states its own world. */
async function configure(fields: {
  template?: readonly (readonly [string, string])[];
  tag?: string | null;
  name?: string | null;
  city?: string | null;
  mcc?: string | null;
  source?: string | null;
}): Promise<void> {
  const template = fields.template ?? [];
  await withTenant(sql, ctx(), async (tx) => {
    await tx`DELETE FROM payment_gateway_config
              WHERE tenant_id = ${ctx().tenantId} AND provider = 'DUITNOW'`;
    await tx`
        INSERT INTO payment_gateway_config (
            tenant_id, provider, display_name, clearing_account_id,
            merchant_template, merchant_template_tag, merchant_template_source,
            merchant_name, merchant_city, merchant_category_code
        ) VALUES (
            ${ctx().tenantId}, 'DUITNOW', 'DuitNow', ${tenant.accounts['1200']!},
            ${tx.json(template as never)},
            ${fields.tag === undefined ? '29' : fields.tag},
            ${fields.source === undefined
              ? (template.length > 0 ? 'PayNet onboarding pack ref DN-TEST-0001' : null)
              : fields.source},
            ${fields.name === undefined ? 'QR SHOP SDN BHD' : fields.name},
            ${fields.city === undefined ? 'KUALA LUMPUR' : fields.city},
            ${fields.mcc === undefined ? '5732' : fields.mcc}
        )
    `;
  });
}

/** A template shaped like PayNet's, with values that are plainly test data. */
const TEMPLATE = [
  ['00', 'TEST.NOT.A.REAL.AID'],
  ['01', 'TEST-MERCHANT-0001'],
] as const;

const build = (amount: string, reference: string) =>
  withTenant(sql, ctx(), (tx) => buildQrForAmount(tx, ctx(), { amount, reference }));

describe('refusing rather than guessing', () => {
  it('refuses when no DuitNow configuration row exists at all', async () => {
    await withTenant(sql, ctx(), (tx) =>
      tx`DELETE FROM payment_gateway_config
          WHERE tenant_id = ${ctx().tenantId} AND provider = 'DUITNOW'`,
    );
    await expect(build('35.00', 'INV-00001')).rejects.toBeInstanceOf(DuitNowNotConfiguredError);
  });

  it('refuses an empty merchant template', async () => {
    await configure({ template: [] });
    await expect(build('35.00', 'INV-00001')).rejects.toThrow(/merchant account template/i);
  });

  it('cannot even STORE a template with no EMVCo tag', async () => {
    // The gap migration 0053 closed, and it closed it harder than intended:
    // the constraint makes the state unrepresentable rather than merely
    // rejected at build time. Without a tag there is no way to know which of
    // 26-51 the merchant fields belong in, and picking one is exactly the guess
    // that pays the wrong party — so the database refuses to hold the question.
    //
    // Asserted against the database rather than the service because that is
    // where the guarantee actually lives; the equivalent check in
    // `buildQrForAmount` is now defence in depth for a row no migration can
    // produce.
    await expect(configure({ template: TEMPLATE, tag: null, source: null })).rejects.toThrow(
      /template_attributed/i,
    );
  });

  it('cannot store a tag outside the EMVCo merchant band', async () => {
    // 26-51 is the reserved band. A value outside it produces a QR that either
    // fails to scan or is read as some other field entirely.
    await expect(configure({ template: TEMPLATE, tag: '52' })).rejects.toThrow();
    await expect(configure({ template: TEMPLATE, tag: '25' })).rejects.toThrow();
  });

  it('refuses when the merchant name or city is missing', async () => {
    // Both are shown to the payer by their own bank app, so a blank one is a
    // customer being asked to approve a payment to nobody in particular.
    await configure({ template: TEMPLATE, city: null });
    await expect(build('35.00', 'INV-00001')).rejects.toThrow(/name and city/i);
  });

  it('refuses when the merchant category code is missing', async () => {
    await configure({ template: TEMPLATE, mcc: null });
    await expect(build('35.00', 'INV-00001')).rejects.toThrow(/category code/i);
  });

  it('names what is missing, not just that something is', async () => {
    await configure({ template: [] });
    const error = await build('35.00', 'INV-00001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuitNowNotConfiguredError);
    expect((error as DuitNowNotConfiguredError).missing).toBe('merchant template');
  });
});

describe('a complete configuration', () => {
  it('produces a payload that passes its own CRC', async () => {
    await configure({ template: TEMPLATE });
    const qr = await build('35.00', 'INV-00042');

    // `verifyQr` recomputes the CRC-16 over everything preceding it, which is
    // the check a scanner performs before it does anything else.
    expect(verifyQr(qr.payload)).toBe(true);
  });

  it('carries MYR as 458, the amount, and a dynamic point of initiation', async () => {
    await configure({ template: TEMPLATE });
    const qr = await build('1080.00', 'INV-00042');
    const tlv = parseTlv(qr.payload);

    expect(tlv.get('53')).toBe('458');
    expect(tlv.get('54')).toBe('1080.00');
    // `12` = dynamic. A till QR carries one amount and must not be re-scanned
    // tomorrow to pay again.
    expect(tlv.get('01')).toBe('12');
    expect(tlv.get('58')).toBe('MY');
  });

  it('puts the merchant fields in the tag the configuration names', async () => {
    await configure({ template: TEMPLATE, tag: '29' });
    const qr = await build('35.00', 'INV-00042');
    const tlv = parseTlv(qr.payload);

    expect(tlv.has('29')).toBe(true);
    expect(tlv.get('29')).toContain('TEST-MERCHANT-0001');
    // And nowhere else in the reserved band.
    expect(tlv.has('26')).toBe(false);
  });

  it('reports a sandbox template rather than quietly producing a payable-looking QR', async () => {
    await configure({
      template: [['00', 'SANDBOX.NOT.A.REAL.AID'], ['01', 'SANDBOX-NOT-A-REAL-MERCHANT']],
      source: 'SANDBOX VALUE — NOT CONFIRMED WITH PAYNET.',
    });
    const qr = await build('35.00', 'INV-00042');

    // It still encodes — the envelope is a public standard and is correct. The
    // flag is what stops the till drawing it for a real customer.
    expect(verifyQr(qr.payload)).toBe(true);
    expect(qr.sandbox).toBe(true);
  });

  it('is not sandbox when the template cites a real source', async () => {
    await configure({ template: TEMPLATE });
    expect((await build('35.00', 'INV-00042')).sandbox).toBe(false);
  });
});
