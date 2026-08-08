import { businessToday, type FeedProviderName } from '@emil/db';
import type { FeedTransaction } from '@emil/domain';

/**
 * The provider port — the socket a real bank connection plugs into.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SMALL, AND WHY THAT IS THE POINT.
 *
 * A live Malaysian bank feed needs an agreement — a direct API contract with
 * a bank, or a commercial aggregator. That is procurement, not engineering,
 * and no adapter is written here until its credentials and its documented
 * format exist (the same discipline as the statutory rates: nothing plausible,
 * only things that can be checked against a source).
 *
 * What exists NOW proves the loop end to end:
 *
 *   SANDBOX  — a deterministic fake bank. Same dates in, same lines out, so a
 *              second sync of the same day imports zero and the dedupe is
 *              visibly doing its job. It exercises every part of the pipeline
 *              a real adapter would: cursor in, transactions + cursor out.
 *   API_PUSH — deliberately NOT in this registry. A push feed has no fetch:
 *              lines arrive at the API with a scoped key. `syncFeed` refusing
 *              it is correct behaviour, not a missing case.
 *
 * The day an agreement exists, a real adapter implements `FeedProvider`,
 * registers itself below, and its name joins the CHECK in the migration.
 * Nothing else changes — that is what all of this bought.
 * ---------------------------------------------------------------------------
 */

export interface FeedPull {
  readonly transactions: readonly FeedTransaction[];
  /** The position to store; handed back on the next pull. */
  readonly cursor: string;
}

export interface FeedProvider {
  fetch(input: { readonly cursor: string | null }): Promise<FeedPull>;
}

/**
 * The fake bank. One day's activity per date, derived from the date itself so
 * every sync of the same window agrees with the last one.
 */
class SandboxBankProvider implements FeedProvider {
  async fetch(input: { readonly cursor: string | null }): Promise<FeedPull> {
    const today = businessToday();
    const from = input.cursor ?? shiftDays(today, -2);

    const transactions: FeedTransaction[] = [];
    for (let date = from; date <= today; date = shiftDays(date, 1)) {
      transactions.push(...dayAtTheShop(date));
    }
    return { transactions, cursor: today };
  }
}

/** Plausible shop banking for one date, deterministic in the date. */
function dayAtTheShop(date: string): FeedTransaction[] {
  const seed = hash(date);
  const takings = 800 + (seed % 1400); // RM 800–2,199, whole ringgit
  const rows: FeedTransaction[] = [
    {
      date,
      description: 'DUITNOW QR SETTLEMENT',
      amount: `${takings}.00`,
      reference: `SBX-${date}-QR`,
    },
    {
      date,
      description: 'IBG TRANSFER FR SANDBOX CUSTOMER',
      amount: `${350 + (seed % 240)}.50`,
      reference: `SBX-${date}-IBG`,
    },
  ];
  // A supplier payment every second day, so the feed shows money out too.
  if (seed % 2 === 0) {
    rows.push({
      date,
      description: 'BILL PAYMENT TO SANDBOX DISTRIBUTOR SDN BHD',
      amount: `-${420 + (seed % 300)}.00`,
      reference: `SBX-${date}-BP`,
    });
  }
  return rows;
}

function hash(value: string): number {
  let h = 0;
  for (const char of value) h = (h * 31 + char.charCodeAt(0)) % 100_000;
  return h;
}

function shiftDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const PROVIDERS: Partial<Record<FeedProviderName, FeedProvider>> = {
  SANDBOX: new SandboxBankProvider(),
};

/** Undefined for push feeds and for adapters that do not exist yet. */
export function feedProvider(name: FeedProviderName): FeedProvider | undefined {
  return PROVIDERS[name];
}
