'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiBlobUrl } from '@/lib/api';
import { Button, Card, ErrorNote } from '@/components/ui';

/**
 * Where the customer signs.
 *
 * ---------------------------------------------------------------------------
 * A SIGNATURE IS STORED AS A PHOTOGRAPH, ON PURPOSE — SEE MIGRATION 0048.
 *
 * The canvas is exported as a PNG and posted to the same route a camera shot
 * goes to, with `kind: 'SIGNATURE'`. That means it inherits everything the
 * photograph path already has: a SHA-256 computed server-side, the bytes in a
 * separate un-audited table so a substitution is detectable, an audit row, and
 * the freeze once the job closes. A second mechanism for an image that needs
 * exactly those properties would have been duplication with a worse story.
 *
 * PNG rather than JPEG, which is the one place this differs from a camera
 * shot: a signature is a few black strokes on white, which is precisely the
 * content JPEG's block transform ruins and PNG's run-length compression
 * flattens to nothing. The file comes out smaller AND cleaner.
 * ---------------------------------------------------------------------------
 *
 * Pointer events, not mouse or touch events. One code path covers a finger on
 * a phone, a stylus on a tablet and a mouse at the counter — which matters,
 * because the device this actually runs on is whichever one is nearest.
 */

const WIDTH = 640;
const HEIGHT = 200;

export function SignaturePad({
  jobId,
  stage,
  title,
  hint,
  onSigned,
}: {
  jobId: string;
  /** RECEIVED is signing for the condition at intake; COLLECTED is the handover. */
  stage: 'RECEIVED' | 'COLLECTED';
  title: string;
  hint: string;
  onSigned: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [marked, setMarked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  /*
   * Drawn at the device's own pixel density and scaled back down in CSS.
   * A signature captured at CSS resolution on a phone is a staircase; the
   * customer sees their own name rendered badly and reasonably wonders what
   * else the shop is careless about.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = WIDTH * ratio;
    canvas.height = HEIGHT * ratio;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    /*
     * -----------------------------------------------------------------------
     * DARK INK ON WHITE PAPER, IN BOTH THEMES. NOT A MISSED TOKEN.
     *
     * Everything else in this app takes its colour from the theme. This canvas
     * must not: it is exported as a PNG, stored as evidence, and embedded in
     * the intake slip and the repair report. A signature captured at night
     * with themed colours would be white strokes on a dark ground — invisible
     * the moment it is printed onto a white page, which is the only place it
     * ever really matters.
     *
     * The pad looks like a slip of paper on a dark screen because it IS one.
     * The colour-guard test lists these three lines by name with this reason.
     * -----------------------------------------------------------------------
     */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
    };
  };

  const ctxOf = () => canvasRef.current?.getContext('2d') ?? null;

  const clear = useCallback(() => {
    const ctx = ctxOf();
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    setMarked(false);
  }, []);

  async function save() {
    const canvas = canvasRef.current;
    if (!canvas || !marked) return;
    setError(null);
    setBusy(true);
    try {
      const dataUrl = canvas.toDataURL('image/png');
      await api(`/v1/repairs/${jobId}/photos`, {
        method: 'POST',
        body: {
          kind: 'SIGNATURE',
          stage,
          contentType: 'image/png',
          imageBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        },
      });
      clear();
      onSigned();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-ink">{title}</div>
        <p className="text-xs text-ink-muted">{hint}</p>
      </div>

      <canvas
        ref={canvasRef}
        // `touch-none` stops the browser scrolling the page when a finger
        // drags across the pad — without it the customer signs by scrolling.
        className="w-full touch-none rounded-xl bg-surface-raised ring-1 ring-inset ring-line-strong"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const ctx = ctxOf();
          if (!ctx) return;
          const p = at(e);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          drawing.current = true;
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = ctxOf();
          if (!ctx) return;
          const p = at(e);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          if (!marked) setMarked(true);
        }}
        onPointerUp={() => { drawing.current = false; }}
        onPointerLeave={() => { drawing.current = false; }}
      />

      <ErrorNote error={error} />

      <div className="flex gap-2">
        <Button variant="ghost" onClick={clear} disabled={!marked || busy}>
          Clear
        </Button>
        <Button onClick={() => void save()} disabled={!marked || busy}>
          {busy ? 'Saving…' : 'Save signature'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Both signatures on a job, in one card.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SITS ON THE SCREEN RATHER THAN ON A CLIPBOARD.
 *
 * The app refuses to hand a device back until both signatures exist, so if
 * they were only obtainable through some other screen the refusal would read
 * as a bug at the worst possible moment: customer at the counter, wallet out,
 * and the till saying no. Putting both pads on the job means the answer to
 * every refusal is visible on the same page as the refusal.
 *
 * A captured signature is shown, never re-captured. There is no "replace"
 * button here on purpose — the delete route already refuses once the job is
 * closed, and while it is open a wrong signature is removed the same way a
 * wrong photograph is, which leaves the removal in the audit log.
 * ---------------------------------------------------------------------------
 */
export function RepairSignatures({
  jobId,
  jobStatus,
  onChanged,
}: {
  jobId: string;
  jobStatus: string;
  onChanged: () => void;
}) {
  const signatures = useQuery({
    queryKey: ['repair-photos', jobId],
    queryFn: () => api<{ photos: { id: string; kind: string; stage: string }[] }>(
      `/v1/repairs/${jobId}/photos`,
    ),
  });
  const queryClient = useQueryClient();

  const has = (stage: string) =>
    (signatures.data?.photos ?? []).find((p) => p.kind === 'SIGNATURE' && p.stage === stage);

  const frozen = jobStatus === 'COLLECTED' || jobStatus === 'CANCELLED';
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['repair-photos', jobId] });
    onChanged();
  };

  const intake = has('RECEIVED');
  const collection = has('COLLECTED');

  return (
    <Card title="Signatures">
      <div className="space-y-5">
        <Slot
          jobId={jobId}
          stage="RECEIVED"
          title="Customer — condition at intake"
          hint="Ask them to sign that the photographs and the accessories above are how the device arrived."
          signature={intake}
          frozen={frozen}
          onSigned={refresh}
        />
        <Slot
          jobId={jobId}
          stage="COLLECTED"
          title="Customer — device collected"
          hint="Signed when the device goes back. The app will not let you collect without it."
          signature={collection}
          frozen={frozen}
          onSigned={refresh}
        />
      </div>
    </Card>
  );
}

function Slot({
  jobId, stage, title, hint, signature, frozen, onSigned,
}: {
  jobId: string;
  stage: 'RECEIVED' | 'COLLECTED';
  title: string;
  hint: string;
  signature: { id: string } | undefined;
  frozen: boolean;
  onSigned: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const photoId = signature?.id;

  useEffect(() => {
    if (!photoId) { setUrl(null); return; }
    let revoked: string | null = null;
    let cancelled = false;
    void apiBlobUrl(`/v1/repairs/${jobId}/photos/${photoId}`).then((u) => {
      if (cancelled) { URL.revokeObjectURL(u); return; }
      revoked = u;
      setUrl(u);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [jobId, photoId]);

  if (signature) {
    return (
      <div>
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="mt-1 rounded-xl bg-surface-raised p-2 ring-1 ring-inset ring-positive/30">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={title} className="h-16 w-auto object-contain" />
          ) : (
            <div className="h-16 animate-pulse rounded bg-surface-sunken" />
          )}
        </div>
        <p className="mt-1 text-xs text-positive">Signed.</p>
      </div>
    );
  }

  if (frozen) {
    return (
      <div>
        <div className="text-sm font-medium text-ink">{title}</div>
        <p className="mt-1 text-xs text-ink-muted">
          Not captured, and this job is closed — the record stands as it is.
        </p>
      </div>
    );
  }

  return (
    <SignaturePad jobId={jobId} stage={stage} title={title} hint={hint} onSigned={onSigned} />
  );
}
