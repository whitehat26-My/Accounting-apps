'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { encodeQr } from '@emil/domain';
import { api } from '@/lib/api';
import { rm } from '@/lib/display';
import { Skeleton } from '@/components/ui';

/**
 * The DuitNow QR a customer scans at the counter.
 *
 * ---------------------------------------------------------------------------
 * NO QR LIBRARY, AND THAT IS DELIBERATE.
 *
 * The obvious move is `qrcode.react`. This app already contains a tested
 * ISO/IEC 18004 encoder — `encodeQr` in @emil/domain — and it is the encoder
 * that prints the verification code on every invoice, receipt and warranty
 * card. Adding a second one would mean two encoders in one product that can
 * disagree, and the disagreement would show up as a symbol that scans on the
 * screen and not on the paper, or the reverse.
 *
 * So this renders the matrix `encodeQr` returns, as inline SVG. The whole
 * renderer is the twenty lines below, it has no dependency, and it prints.
 *
 * WHY THE PAYLOAD COMES FROM THE SERVER. The merchant template, its EMVCo tag,
 * the category code — all of it is tenant configuration that lives in
 * `payment_gateway_config`. Building the payload in the browser would mean
 * shipping that configuration to every till and re-implementing the CRC there.
 * The server answers with one string; this draws it.
 * ---------------------------------------------------------------------------
 */

interface QrAvailable {
  available: true;
  payload: string;
  amount: string;
  reference: string;
  merchantName: string;
  /** The template is a sandbox value: structurally valid, pays nobody. */
  sandbox: boolean;
}

interface QrUnavailable {
  available: false;
  reason: string;
  missing: string;
}

type QrAnswer = QrAvailable | QrUnavailable;

export function DuitNowQr({ amount, reference }: { amount: string; reference: string }) {
  const qr = useQuery({
    queryKey: ['duitnow-qr', amount, reference],
    queryFn: () =>
      api<QrAnswer>(
        `/v1/pos/duitnow-qr?amount=${encodeURIComponent(amount)}` +
          `&reference=${encodeURIComponent(reference)}`,
      ),
    // A QR carries one amount and is not reusable, so there is nothing to keep.
    staleTime: 0,
    retry: false,
  });

  if (qr.isPending) return <Skeleton rows={4} />;

  if (qr.isError) {
    return (
      <p className="text-sm text-negative">
        Could not build the QR. Take the payment another way and check the
        payment settings afterwards.
      </p>
    );
  }

  // Not an error state: most shops have never configured DuitNow. Saying which
  // piece is missing is the difference between a fixable message and a shrug.
  if (!qr.data.available) {
    return (
      <div className="rounded-lg border border-line bg-surface-sunken p-3">
        <p className="text-sm font-medium text-ink">QR payment is not set up</p>
        <p className="mt-1 text-xs text-ink-muted">{qr.data.reason}</p>
        <p className="mt-2 text-xs text-ink-faint">Missing: {qr.data.missing}</p>
      </div>
    );
  }

  /*
   * A sandbox template produces a QR that scans perfectly and pays nobody. The
   * payer would find that out only after scanning — so it is refused here
   * rather than drawn with a caption nobody reads mid-transaction.
   */
  if (qr.data.sandbox) {
    return (
      <div className="rounded-lg border border-caution/40 bg-caution-soft p-3">
        <p className="text-sm font-medium text-caution">Sandbox merchant — no QR shown</p>
        <p className="mt-1 text-xs text-caution">
          This organisation is configured with a demonstration merchant template.
          A QR built from it would scan correctly and pay nobody. Take the
          payment another way.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <QrSymbol payload={qr.data.payload} />
      <div className="text-center">
        <p className="text-lg font-bold text-ink">{rm(qr.data.amount)}</p>
        <p className="text-xs text-ink-muted">
          {qr.data.merchantName} · {qr.data.reference}
        </p>
        <p className="mt-1 text-xs text-ink-faint">
          Scan with any Malaysian banking app or e-wallet
        </p>
      </div>
    </div>
  );
}

/**
 * The matrix as SVG.
 *
 * One `<rect>` per dark module rather than an image: it stays sharp at any size,
 * it prints at the printer's resolution rather than the screen's, and it needs
 * no canvas. The quiet zone is drawn here because `encodeQr` deliberately does
 * not include one — a scanner needs the light border, and the caller is the only
 * one who knows what it is being drawn onto.
 */
function QrSymbol({ payload, size = 220 }: { payload: string; size?: number }) {
  const matrix = encodeQr(payload);
  const QUIET = 4;
  const span = matrix.length + QUIET * 2;

  /*
   * Clear the floating chrome off the symbol for as long as it is drawn.
   *
   * The assistant launcher and the notice stack are `fixed` to the viewport, so
   * no amount of layout here moves them; at 390px they land on the QR and it
   * stops scanning. The attribute is set on `document.body` — see globals.css
   * for the rule and for how the overlap was proved.
   *
   * Cleared on unmount, which is every path out: ringing the next sale,
   * switching tender, leaving the till.
   */
  useEffect(() => {
    document.body.dataset['scanning'] = '1';
    return () => {
      delete document.body.dataset['scanning'];
    };
  }, []);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`DuitNow payment QR code for ${payload.length} characters of payment data`}
      className="rounded-lg bg-white p-1"
    >
      <rect width={span} height={span} fill="#ffffff" />
      {matrix.map((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect key={`${x}-${y}`} x={x + QUIET} y={y + QUIET} width={1} height={1} fill="#000000" />
          ) : null,
        ),
      )}
    </svg>
  );
}
