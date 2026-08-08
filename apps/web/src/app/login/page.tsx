'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, saveSession } from '@/lib/api';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { Icon } from '@/components/icons';
import { BrandMark, useImageFallback } from '@/components/brand';
import { APP_NAME, BRAND_PHOTO, BRAND_WORDMARK, appNameParts } from '@/lib/brand';

/**
 * Sign in / register, then land somewhere useful.
 *
 * The API's shape drives the flow: login returns a refresh token and the
 * user's organisations, but NO access token — that is minted per organisation
 * by /auth/switch. One organisation: switch straight into it. None: the user
 * is brand new, so they go to /setup carrying the refresh token. Several: pick.
 *
 * ---------------------------------------------------------------------------
 * THE DOOR SHOWS THE SHOP — WHICHEVER SHOP THIS IS.
 *
 * The background is a photograph of the operator's own premises, if they
 * supplied one at `public/brand/shop.jpg`: the signboard, the counter, the
 * floor. Nobody signing in has to wonder whether they are in the right
 * system, and the people who use it see their own workplace rather than a
 * stock gradient.
 *
 * Everything here is OPTIONAL and everything here is theirs. This page used to
 * hardcode one shop's name, wordmark and shopfront, which was fine while there
 * was one shop and wrong the moment a second company ran their own copy — they
 * would have signed in through somebody else's front door every morning. Name
 * comes from `NEXT_PUBLIC_APP_NAME`, images from `public/brand/`, and each has
 * a fallback that is a design rather than a gap: initials on a tile, and the
 * gradients below standing on their own.
 *
 * A photograph behind a form is only ever as good as its scrim. Two layers
 * sit over it: a heavy left-to-right gradient so the headline has near-black
 * behind it, and a flat wash so the busiest part of the shop floor cannot
 * fight the form card. The card itself stays opaque white — a frosted panel
 * over a photo this detailed makes small print work to read, and this is
 * where somebody types a password.
 *
 * Below lg — iPad portrait, phones — the layout collapses to one column,
 * because splitting 768px in half leaves two cramped ones. The photo stays.
 * ---------------------------------------------------------------------------
 */

interface LoginResponse {
  refreshToken: string;
  /**
   * `tenantName`, not `name` — the field the API actually sends
   * (`membershipsForUser`). This interface said `name` for as long as it has
   * existed, so every user who signed in through THIS screen stored an
   * `organisationName` of `undefined`; the rail rendered it as empty text and
   * nobody saw it. Only the person who had just created the organisation, and
   * who never passes through here, had a name in the rail.
   */
  organisations: { tenantId: string; tenantName: string; role: string }[];
}

/** What the shop gets, in the words the shop would use. */
const PROMISES: { icon: string; text: string }[] = [
  { icon: 'pos', text: 'Ring a sale and print the receipt — stock and cost post themselves.' },
  { icon: 'banking', text: 'Import the bank statement; rules code the lines you see every month.' },
  { icon: 'reports', text: 'Profit, balance sheet and cash flow your accountant will accept.' },
];

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [organisations, setOrganisations] = useState<LoginResponse['organisations'] | null>(null);
  const [refreshToken, setRefreshToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function enter(tenantId: string, name: string, token: string) {
    const switched = await api<{ accessToken: string; refreshToken: string }>('/v1/auth/switch', {
      method: 'POST',
      anonymous: true,
      body: { refreshToken: token, tenantId },
    });
    saveSession({
      refreshToken: switched.refreshToken,
      accessToken: switched.accessToken,
      tenantId,
      organisationName: name,
    });
    router.push('/');
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await api('/v1/auth/register', {
          method: 'POST',
          anonymous: true,
          body: {
            email,
            password,
            fullName,
            // Sent only when typed. On a server running SIGNUP_MODE=open, and
            // for the very first account on an empty one, there is no code to
            // give and an empty string would be a code that is simply wrong.
            ...(inviteToken.trim() ? { inviteToken: inviteToken.trim() } : {}),
          },
        });
      }

      const login = await api<LoginResponse>('/v1/auth/login', {
        method: 'POST',
        anonymous: true,
        body: { email, password },
      });

      if (login.organisations.length === 0) {
        window.sessionStorage.setItem('emil.onboarding.refreshToken', login.refreshToken);
        router.push('/setup');
      } else if (login.organisations.length === 1) {
        const only = login.organisations[0]!;
        await enter(only.tenantId, only.tenantName, login.refreshToken);
      } else {
        setRefreshToken(login.refreshToken);
        setOrganisations(login.organisations);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (organisations) {
    return (
      <AuthShell>
        <Heading
          title="Choose an organisation"
          subtitle="You have access to more than one set of books."
        />
        <div className="space-y-2">
          {organisations.map((org) => (
            <button
              key={org.tenantId}
              onClick={() => void enter(org.tenantId, org.tenantName, refreshToken)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-surface-raised px-4 py-3.5 text-left shadow-lg shadow-black/10 ring-1 ring-line transition-colors hover:bg-positive-soft hover:ring-positive/30"
            >
              <span className="font-medium text-ink">{org.tenantName}</span>
              <span className="text-xs text-ink-muted">{org.role}</span>
            </button>
          ))}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <Heading
        title={mode === 'login' ? 'Welcome back' : 'Create your account'}
        subtitle={
          mode === 'login'
            ? 'Sign in to the shop’s books.'
            : 'Register yourself first — the boss then adds you to the shop by email.'
        }
      />

      {/*
        The best surface in the app for this: the shop photograph sits directly
        behind, so the frosting has something real to pick up. Held at 88% —
        enough to read the glass, opaque enough that the labels and the password
        field never fight the photograph behind them.
      */}
      <div
        className="rounded-2xl bg-surface-raised p-6 shadow-2xl shadow-black/25 ring-1 ring-line
                   supports-[backdrop-filter]:bg-surface-raised/88 supports-[backdrop-filter]:backdrop-blur-2xl"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === 'register' ? (
            <>
              <Field label="Your name">
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  autoComplete="name"
                  placeholder="Ahmad bin Ismail"
                />
              </Field>
              {/*
                OPTIONAL in the form, because whether a code is needed is a
                property of the SERVER, not of the person typing. A shop PC on
                its own LAN accepts open sign-ups and would show a required
                field nobody can fill; a hosted server refuses without one and
                says so in the error, which is where that belongs.
              */}
              <Field label="Invitation code (if you were given one)">
                <Input
                  value={inviteToken}
                  onChange={(e) => setInviteToken(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Leave blank if you were not given a code"
                />
              </Field>
            </>
          ) : null}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@company.com"
            />
          </Field>

          <Field label="Password">
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="pr-16"
              />
              {/* Typing a twelve-character password blind on a tablet keyboard
                  is how people end up locked out of their own books. */}
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          {mode === 'register' ? (
            <p className="text-xs text-ink-faint">
              At least 12 characters. A short phrase you will remember beats a clever
              word you will not.
            </p>
          ) : null}

          <ErrorNote error={error} />

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </div>

      <p className="text-center text-sm text-rail-ink">
        {mode === 'login' ? 'New here?' : 'Already registered?'}{' '}
        <button
          className="font-medium text-rail-accent underline-offset-2 hover:underline"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Create an account' : 'Sign in instead'}
        </button>
      </p>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight text-rail-ink-strong drop-shadow-sm">{title}</h1>
      <p className="text-sm text-rail-ink">{subtitle}</p>
    </div>
  );
}

/**
 * The shop behind the glass, and the work in front of it.
 *
 * The photograph is a `<img>` rather than a CSS background so the drift can
 * transform it without repainting a background-position every frame, and so
 * the browser can pick it up as a normal image request.
 */
/**
 * The wordmark, or the name set as text.
 *
 * `brightness-0 invert` paints whatever the operator supplied flat white,
 * which is what makes an arbitrary logo sit correctly on a dark scrim without
 * anybody having to prepare a light-on-dark variant. The text fallback is
 * styled to match its weight, so a company with no wordmark gets a heading
 * rather than a hole.
 */
function Wordmark() {
  const { ref, failed, onError } = useImageFallback();

  if (failed) {
    return (
      <span className="text-lg font-semibold tracking-tight text-rail-ink-strong">
        {appNameParts().primary}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={BRAND_WORDMARK}
      alt={APP_NAME}
      className="h-9 w-auto brightness-0 invert"
      onError={onError}
    />
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  /*
   * No photograph is the ordinary case for a fresh installation, so its
   * absence is handled rather than assumed away. On a 404 the <img> is dropped
   * entirely: the two scrims and the brand wash below already paint a complete
   * background, and they were designed to sit over dark anyway, so what is
   * left reads as a deliberate deep-navy page rather than as a missing image.
   */
  const photo = useImageFallback();

  return (
    <div className="relative min-h-screen overflow-hidden bg-rail">
      {/* The shop itself, drifting slowly. `inset-0` with object-cover means
          the crop follows the viewport rather than the photo's own ratio.
          Hidden rather than unmounted when it fails, so the element survives
          for the hook to inspect — a load that ended before hydration cannot
          be detected from a node that is no longer there. */}
      <img
        ref={photo.ref}
        src={BRAND_PHOTO}
        alt=""
        aria-hidden
        className={
          photo.failed
            ? 'hidden'
            : 'emil-drift absolute inset-0 h-full w-full object-cover'
        }
        onError={photo.onError}
      />

      {/* Scrim one, in two directions.
          Wide: dark from the left, where the headline lives, easing off over
          the shop so the photo is actually seen.
          Narrow: near-uniform, because a sideways gradient on a portrait iPad
          just makes one edge bright and the layout look lopsided. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 lg:hidden"
        style={{
          background:
            'linear-gradient(180deg, rgba(2,6,23,0.80) 0%, rgba(2,6,23,0.88) 40%, rgba(2,6,23,0.86) 100%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden lg:block"
        style={{
          background:
            'linear-gradient(100deg, rgba(2,6,23,0.94) 0%, rgba(2,6,23,0.88) 38%, rgba(2,6,23,0.70) 68%, rgba(2,6,23,0.80) 100%)',
        }}
      />
      {/* Scrim two: the brand's own colours, so the photo sits inside the
          product rather than behind it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(40rem 30rem at 3% 100%, rgba(5,150,105,0.26), transparent 62%), ' +
            'radial-gradient(36rem 26rem at 97% 0%, rgba(24,117,190,0.30), transparent 60%)',
        }}
      />

      <div className="relative flex min-h-screen flex-col lg:flex-row">
        <aside className="hidden w-[46%] max-w-2xl flex-col justify-between p-12 lg:flex">
          <div className="emil-rise flex items-center gap-3.5">
            <BrandMark />
            <div>
              <div className="text-base font-semibold leading-tight text-rail-ink-strong">
                {appNameParts().primary}
              </div>
              {appNameParts().secondary ? (
                <div className="text-xs text-rail-ink">{appNameParts().secondary}</div>
              ) : null}
            </div>
          </div>

          <div className="space-y-8">
            <h2
              className="emil-rise max-w-md text-3xl font-semibold leading-snug tracking-tight text-rail-ink-strong"
              style={{ animationDelay: '80ms' }}
            >
              The counter, the workshop and the accounts — one system, one set of numbers.
            </h2>
            <ul className="space-y-4">
              {PROMISES.map((promise, i) => (
                <li
                  key={promise.icon}
                  className="emil-rise flex items-start gap-3 text-sm text-rail-ink-strong"
                  style={{ animationDelay: `${160 + i * 90}ms` }}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-rail-accent/15 text-rail-accent ring-1 ring-inset ring-rail-accent/20">
                    <Icon name={promise.icon} />
                  </span>
                  <span className="max-w-sm leading-relaxed">{promise.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <p
            className="emil-rise max-w-sm text-xs leading-relaxed text-rail-ink-dim"
            style={{ animationDelay: '440ms' }}
          >
            Ringgit Malaysia, Kuala Lumpur time. The ledger is append-only — a mistake is
            corrected by a reversing entry, never quietly edited away.
          </p>
        </aside>

        <main className="flex flex-1 items-center justify-center px-5 py-12">
          <div
            className="emil-rise w-full max-w-sm space-y-5"
            style={{ animationDelay: '120ms' }}
          >
            {/* The brand panel is hidden below lg, so the mark comes along here. */}
            <div className="mb-2 flex items-center justify-center gap-3 lg:hidden">
              <BrandMark className="h-10 w-10" textClass="text-xs" />
              <Wordmark />
            </div>

            {children}

            {/* And so do the promises — on an iPad in portrait this is the whole
                of the sign-in screen, and a page that says nothing about itself
                is the thing this redesign set out to fix. */}
            <ul className="space-y-2.5 border-t border-rail-line pt-5 lg:hidden">
              {PROMISES.map((promise) => (
                <li key={promise.icon} className="flex items-start gap-2.5 text-xs text-rail-ink">
                  <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-rail-accent/15 text-rail-accent">
                    <Icon name={promise.icon} className="!h-3 !w-3" />
                  </span>
                  <span className="leading-relaxed">{promise.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </main>
      </div>
    </div>
  );
}
