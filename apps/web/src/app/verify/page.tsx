'use client';

import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { displayDate } from '@/lib/display';
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
 * The digest arrives in the URL FRAGMENT (`#d=...`), not the query string:
 * a fragment is never sent to the server, so it stays out of access logs, the
 * proxy, and the Referer header of anything this page links to. The QR on the
 * document encodes exactly that form.
 * ---------------------------------------------------------------------------
 */

interface Result {
  verdict: 'GENUINE' | 'UNKNOWN';
  documentType: 'INVOICE' | 'RECEIPT' | null;
  issuedOn: string | null;
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
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);

  // Scanning the QR lands here with the reference already in the fragment;
  // check it immediately rather than making somebody press a button to
  // confirm what they just pointed a camera at.
  useEffect(() => {
    const fromHash = /[#&]d=([0-9a-fA-F]{64})/.exec(window.location.hash);
    if (fromHash) {
      setDigest(fromHash[1]!);
      void check(fromHash[1]!);
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
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">
        Check a document
      </h1>
      <p className="mb-5 text-sm text-slate-600">
        Enter the reference printed at the bottom of an invoice or receipt, or scan its
        code. You do not need an account.
      </p>

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
                ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                : 'bg-amber-50 text-amber-900 ring-amber-200'
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
      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        This checks the document against the issuing shop&rsquo;s own records, which are kept
        in an append-only ledger with a hash chain — so a document cannot be altered after
        the fact without the check failing. It is not a government certification and not a
        digital signature: it proves the paper agrees with the books, which is the question
        a dispute usually turns on.
      </p>
    </main>
  );
}
