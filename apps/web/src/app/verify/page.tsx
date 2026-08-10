'use client';

import { Suspense, useEffect, useState } from 'react';
import { fromBase64Url, unpackAttestation } from '@emil/domain/attestation';
import type { DocumentAttestation } from '@emil/domain/attestation';
import { api } from '@/lib/api';
import { displayDate, rm } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * "Is this piece of paper real?"
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY OUTSIDE THE AUTHENTICATED SHELL.
 *
 * This page lives beside `(app)`, not inside it, so it renders with no session
 * and no nav rail. The people it is FOR — a customer with a receipt, an
 * accountant with a client's invoice, a bank looking at a statement someone
 * attached to a loan application — have no account here and never will.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO ASK, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 * 1. THE QR CODE (`#v=payload.signature`) — checked HERE, in the reader's own
 *    browser, against a published public key. It proves the shop issued a
 *    document with exactly these figures on this date, and it works with the
 *    shop's computer switched off, on mobile data, years later. What it cannot
 *    say is whether the document was later cancelled or credited: a signature
 *    is a statement about a moment, and the moment has passed.
 *
 * 2. THE PRINTED REFERENCE (`#d=<digest>`, or typed into the box) — asked of
 *    the shop's live system, which answers with the document's kind and date
 *    and deliberately nothing else. Needs the system reachable, and reflects
 *    the document's status NOW.
 *
 * Neither replaces the other, so the page says which one it used. Older
 * documents carry only form 2 and must keep working forever.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QR MAY SHOW AN AMOUNT WHEN THE SERVER REFUSES TO.
 *
 * `/public/verify` answers with the kind and the date and withholds the amount
 * on purpose — a digest typed into a box must not turn the server into a lookup
 * oracle for figures. That reasoning does not apply here. The amount shown below
 * came OUT OF THE QR THE READER JUST SCANNED; it was never fetched from
 * anywhere, and the fragment is never sent to any server. Displaying it is not
 * disclosure, it is decoding something already in the reader's hand — and it is
 * the whole point, because a signature that does not let you compare the figures
 * against the paper only proves that SOME document was signed.
 * ---------------------------------------------------------------------------
 */

const VERIFY_KEY = process.env['NEXT_PUBLIC_VERIFY_KEY'] ?? '';

interface Result {
  verdict: 'GENUINE' | 'UNKNOWN';
  documentType: 'INVOICE' | 'RECEIPT' | null;
  issuedOn: string | null;
}

type Offline =
  | { state: 'GENUINE'; document: DocumentAttestation }
  | { state: 'FORGED' }
  | { state: 'UNREADABLE'; why: string }
  | { state: 'CANNOT_CHECK'; why: string };

const TYPE_NAMES: Record<DocumentAttestation['documentType'], string> = {
  INVOICE: 'an invoice',
  RECEIPT: 'a receipt',
  REPAIR_JOB: 'a repair job',
  WARRANTY: 'a warranty card',
};

/**
 * Check the QR's signature in this browser.
 *
 * Returns a verdict for every input rather than throwing for some of them: this
 * runs in front of somebody deciding whether a piece of paper is real, and an
 * unhandled exception reads as "the website is broken", which is the one answer
 * that helps nobody.
 */
async function verifySignature(fragment: string): Promise<Offline> {
  /*
   * `crypto.subtle` does not exist outside a secure context, and that is a
   * browser rule rather than a bug to route around: served over plain http on
   * a LAN address (`http://192.168.1.50:8080`) it is simply undefined, while
   * `localhost` and any https origin have it. Say so and offer the other path,
   * because a page hosted on https never hits this and it would otherwise ship
   * unnoticed.
   */
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return {
      state: 'CANNOT_CHECK',
      why:
        'This page was opened over a plain (not secure) address, and browsers only '
        + 'allow signature checking on a secure one. Open it over https, or type the '
        + 'reference printed under the code into the box below instead.',
    };
  }
  if (!VERIFY_KEY) {
    return {
      state: 'CANNOT_CHECK',
      why:
        'This copy of the site was built without the shop’s public key, so it cannot '
        + 'check signatures. Type the reference printed under the code into the box below.',
    };
  }

  const [payloadPart, signaturePart] = fragment.split('.');
  if (!payloadPart || !signaturePart) {
    return { state: 'UNREADABLE', why: 'The code is incomplete.' };
  }

  let payload: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  let key: CryptoKey;
  try {
    payload = fromBase64Url(payloadPart);
    signature = fromBase64Url(signaturePart);
    key = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(VERIFY_KEY),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
  } catch {
    return { state: 'UNREADABLE', why: 'The code is not in a form this page understands.' };
  }

  const ok = await crypto.subtle
    .verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, payload)
    .catch(() => false);

  // Order matters. Check the SIGNATURE first and only then read the figures —
  // decoding an unsigned payload and showing its contents would display
  // whatever a forger put there, next to the word "genuine".
  if (!ok) return { state: 'FORGED' };

  try {
    return { state: 'GENUINE', document: unpackAttestation(payload, 'MYR') };
  } catch (error) {
    // Signed by the right key but unreadable here: a newer format version from
    // a system this page predates. Refuse rather than guess at the layout.
    return { state: 'UNREADABLE', why: error instanceof Error ? error.message : 'Unknown format.' };
  }
}

export default function VerifyPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const [digest, setDigest] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [offline, setOffline] = useState<Offline | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  // Scanning the QR lands here with everything already in the fragment; check
  // it immediately rather than making somebody press a button to confirm what
  // they just pointed a camera at.
  useEffect(() => {
    const signed = /[#&]v=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(window.location.hash);
    if (signed) {
      void verifySignature(signed[1]!).then(setOffline);
      return;
    }
    const reference = /[#&]d=([0-9a-fA-F]{64})/.exec(window.location.hash);
    if (reference) {
      setDigest(reference[1]!);
      void check(reference[1]!);
    }
  }, []);

  async function check(value: string) {
    setError(null);
    setResult(null);
    setChecking(true);
    try {
      // Spaces are how it is PRINTED, in groups of sixteen so a person can
      // read it aloud. Strip them rather than making the reader do it.
      const cleaned = value.replace(/\s+/g, '').toLowerCase();
      setResult(await api<Result>('/public/verify', {
        method: 'POST',
        body: { digest: cleaned },
        anonymous: true,
      }));
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">
        Check a document
      </h1>
      <p className="mb-5 text-sm text-ink-muted">
        Enter the reference printed at the bottom of an invoice or receipt, or scan its
        code. You do not need an account.
      </p>

      {offline ? <OfflineVerdict offline={offline} /> : null}

      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void check(digest);
          }}
        >
          <Field label="Document reference">
            <Input
              value={digest}
              onChange={(e) => setDigest(e.target.value)}
              placeholder="0123456789abcdef 0123456789abcdef …"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Button type="submit" disabled={checking || digest.trim() === ''}>
            {checking ? 'Checking…' : 'Check this document'}
          </Button>
          <ErrorNote error={error} />
        </form>

        {result ? (
          <div
            className={`emil-rise mt-4 rounded-lg px-4 py-3 text-sm ring-1 ring-inset ${
              result.verdict === 'GENUINE'
                ? 'bg-positive-soft text-positive ring-positive/30'
                : 'bg-caution-soft text-caution ring-caution/30'
            }`}
          >
            {result.verdict === 'GENUINE' ? (
              <>
                <p className="font-semibold">This document is genuine.</p>
                <p className="mt-1">
                  It is {result.documentType === 'INVOICE' ? 'an invoice' : 'a receipt'} issued
                  on {displayDate(result.issuedOn!)}, and the figures printed on it are
                  exactly the figures in the shop&rsquo;s records. Any change to an amount, a
                  date or a name would have made this check fail.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">No matching document.</p>
                <p className="mt-1">
                  Nothing in these records has that reference. Most often the reference was
                  mistyped — check it again. If it was scanned from a document that claims to
                  come from this shop, the document does not match anything the shop issued.
                </p>
              </>
            )}
          </div>
        ) : null}
      </Card>

      {/*
        The honest description of what was and was not proved. A page that let
        somebody read "verified" as "independently certified" would be
        overclaiming, and this whole feature is worth less than nothing if it
        is trusted further than it can carry.
      */}
      <p className="mt-4 text-xs leading-relaxed text-ink-muted">
        {offline?.state === 'GENUINE' || offline?.state === 'FORGED' ? (
          <>
            A scanned code is checked against the shop&rsquo;s published signature, in this
            browser, with nothing sent anywhere — which is why it works when their computer
            is off. A typed reference is checked against the shop&rsquo;s live records
            instead, which are kept in an append-only ledger with a hash chain. Neither is a
            government certification: together they prove the paper agrees with the books,
            which is the question a dispute usually turns on.
          </>
        ) : (
          <>
            This checks the document against the issuing shop&rsquo;s own records, which are
            kept in an append-only ledger with a hash chain — so a document cannot be altered
            after the fact without the check failing. It is not a government certification:
            it proves the paper agrees with the books, which is the question a dispute
            usually turns on.
          </>
        )}
      </p>
    </main>
  );
}

/** The result of checking the QR's signature, before any server is involved. */
function OfflineVerdict({ offline }: { offline: Offline }) {
  if (offline.state === 'GENUINE') {
    const { documentType, documentNo, issuedOn, total } = offline.document;
    return (
      <div className="emil-rise mb-4 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive ring-1 ring-inset ring-positive/30">
        <p className="font-semibold">This document is genuine.</p>
        <p className="mt-1">
          The code carries the shop&rsquo;s signature, and it matches. It is {TYPE_NAMES[documentType]}:
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-medium">
          <dt>Number</dt>
          <dd className="tabular-nums">{documentNo}</dd>
          <dt>Date</dt>
          <dd className="tabular-nums">{displayDate(issuedOn)}</dd>
          <dt>Total</dt>
          <dd className="tabular-nums">{rm(total.toDecimalString())}</dd>
        </dl>
        <p className="mt-2">
          <strong>Compare these with the paper in your hand.</strong> If anything differs,
          the paper was altered after it was issued.
        </p>
        <p className="mt-2 text-xs">
          Checked in this browser, without contacting the shop — so it works even when their
          computer is off. It cannot tell you whether the document was later cancelled or
          refunded; for that, type the reference printed under the code into the box below.
        </p>
      </div>
    );
  }

  if (offline.state === 'FORGED') {
    return (
      <div className="emil-rise mb-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical ring-1 ring-inset ring-critical/30">
        <p className="font-semibold">This document did NOT pass the check.</p>
        <p className="mt-1">
          The code does not carry a valid signature from this shop. Either something on the
          document was changed after it was issued, or it did not come from this shop at all.
          Do not rely on it. If you believe it is real, contact the shop directly.
        </p>
      </div>
    );
  }

  return (
    <div className="emil-rise mb-4 rounded-lg bg-caution-soft px-4 py-3 text-sm text-caution ring-1 ring-inset ring-caution/30">
      <p className="font-semibold">
        {offline.state === 'UNREADABLE' ? 'This code could not be read.' : 'Cannot check here.'}
      </p>
      <p className="mt-1">{offline.why}</p>
    </div>
  );
}
