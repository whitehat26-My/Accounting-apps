'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, apiBlobUrl } from '@/lib/api';
import { preparePhoto } from '@/lib/image';
import { Button, Card, ErrorNote } from '@/components/ui';

/**
 * The evidence on a repair job.
 *
 * The whole point is the photograph taken at the counter, with the customer
 * standing there, before the machine goes into the back. Everything here is
 * shaped around that moment: one big obvious button, the camera opens straight
 * away on a phone, and the stage defaults to what the job's state implies so
 * nobody has to think about a dropdown while a customer waits.
 */

interface Photo {
  id: string;
  kind: string;
  stage: string;
  caption: string | null;
  byteSize: number;
  width: number | null;
  height: number | null;
  takenAt: string;
}

const STAGES = [
  { key: 'RECEIVED', label: 'As received' },
  { key: 'DIAGNOSIS', label: 'Diagnosis' },
  { key: 'IN_PROGRESS', label: 'During work' },
  { key: 'READY', label: 'Finished' },
] as const;

/** What a photograph taken right now most likely shows, given where the job is. */
function stageFor(jobStatus: string): string {
  if (jobStatus === 'RECEIVED') return 'RECEIVED';
  if (jobStatus === 'QUOTED' || jobStatus === 'APPROVED') return 'DIAGNOSIS';
  if (jobStatus === 'READY') return 'READY';
  return 'IN_PROGRESS';
}

export function RepairPhotos({ jobId, jobStatus }: { jobId: string; jobStatus: string }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState(() => stageFor(jobStatus));
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  // A closed job's photographs are the record of something nobody can go back
  // and re-examine. The server enforces this; the UI just stops offering it.
  const frozen = jobStatus === 'COLLECTED' || jobStatus === 'CANCELLED';

  const photos = useQuery({
    queryKey: ['repair-photos', jobId],
    queryFn: () => api<{ photos: Photo[] }>(`/v1/repairs/${jobId}/photos`),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['repair-photos', jobId] });
  };

  const remove = useMutation({
    mutationFn: (photoId: string) =>
      api(`/v1/repairs/${jobId}/photos/${photoId}`, { method: 'DELETE' }),
    onSuccess: () => { setError(null); refresh(); },
    onError: setError,
  });

  async function onPicked(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // One at a time, deliberately: a phone on shop WiFi uploading four
      // photographs at once is how you get four timeouts instead of four
      // photographs.
      for (const file of Array.from(files)) {
        const prepared = await preparePhoto(file);
        await api(`/v1/repairs/${jobId}/photos`, {
          method: 'POST',
          body: {
            kind: 'PHOTO',
            stage,
            contentType: prepared.contentType,
            imageBase64: prepared.base64,
            ...(caption.trim() ? { caption: caption.trim() } : {}),
          },
        });
      }
      setCaption('');
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /*
   * Photographs only. Signatures live in the same table — same digest, same
   * freeze, same audit row (migration 0048) — but a customer's signature is
   * not a picture of the device, and putting the two in one grid would invite
   * somebody to delete a signature while tidying up blurred shots.
   */
  const list = (photos.data?.photos ?? []).filter((p) => p.kind !== 'SIGNATURE');

  return (
    <Card
      title="Photos — the evidence"
      action={<span className="text-xs text-slate-500">{list.length} of 12</span>}
    >
      {!frozen ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setStage(s.key)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  stage === s.key
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <input
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            placeholder="What does it show? e.g. dent on lid, top left"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={300}
          />

          {/*
            `capture="environment"` opens the rear camera directly on a phone
            instead of the file picker — the difference between two taps and
            five while a customer waits. On a desktop it is ignored and the
            normal file chooser opens.
          */}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => void onPicked(e.target.files)}
          />
          <Button
            onClick={() => fileInput.current?.click()}
            disabled={busy || list.length >= 12}
          >
            {busy ? 'Adding…' : 'Take or choose a photo'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          This job is closed. Its photographs are the record of what was done and
          cannot be added to or removed.
        </p>
      )}

      <ErrorNote error={error} />

      {list.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No photographs yet. The one worth taking is of the machine as it arrives —
          it is what settles an argument about a mark later.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((p) => (
            <Thumbnail
              key={p.id}
              jobId={jobId}
              photo={p}
              frozen={frozen}
              onOpen={() => setViewing(p.id)}
              onRemove={() => remove.mutate(p.id)}
            />
          ))}
        </div>
      )}

      {viewing ? (
        <Lightbox jobId={jobId} photoId={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </Card>
  );
}

/**
 * One photograph.
 *
 * The bytes come through `apiBlobUrl` rather than a plain <img src>, because
 * the route is authenticated and an <img> tag cannot carry the bearer token.
 * The object URL is revoked on unmount — a gallery that leaks one per thumbnail
 * is a gallery that eventually stalls the tab.
 */
function Thumbnail({
  jobId, photo, frozen, onOpen, onRemove,
}: {
  jobId: string;
  photo: Photo;
  frozen: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void apiBlobUrl(`/v1/repairs/${jobId}/photos/${photo.id}`).then((u) => {
      if (cancelled) { URL.revokeObjectURL(u); return; }
      revoked = u;
      setUrl(u);
    }).catch(() => { /* a missing thumbnail is not worth an error banner */ });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [jobId, photo.id]);

  const label = STAGES.find((s) => s.key === photo.stage)?.label ?? photo.stage;

  return (
    <figure className="group relative overflow-hidden rounded-xl ring-1 ring-slate-900/10">
      <button type="button" onClick={onOpen} className="block w-full">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={photo.caption ?? label}
            className="aspect-square w-full bg-slate-100 object-cover"
          />
        ) : (
          <div className="aspect-square w-full animate-pulse bg-slate-100" />
        )}
      </button>
      <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-left">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white/80">{label}</div>
        {photo.caption ? (
          <div className="truncate text-[11px] text-white">{photo.caption}</div>
        ) : null}
      </figcaption>
      {!frozen ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this photo"
          className="absolute right-1.5 top-1.5 rounded-full bg-black/55 px-2 py-0.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
        >
          ✕
        </button>
      ) : null}
    </figure>
  );
}

/** Full size, over the page. */
function Lightbox({
  jobId, photoId, onClose,
}: { jobId: string; photoId: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    void apiBlobUrl(`/v1/repairs/${jobId}/photos/${photoId}`).then((u) => {
      revoked = u;
      setUrl(u);
    }).catch(() => undefined);
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [jobId, photoId]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
      ) : (
        <div className="text-sm text-white/70">Loading…</div>
      )}
    </div>
  );
}
