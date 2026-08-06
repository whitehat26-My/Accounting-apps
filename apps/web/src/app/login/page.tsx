'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, saveSession } from '@/lib/api';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { Icon } from '@/components/icons';
import mark from '@/brand/mark.png';
import wordmark from '@/brand/wordmark.png';
import shop from '@/brand/shop.jpg';

/**
 * Sign in / register, then land somewhere useful.
 *
 * The API's shape drives the flow: login returns a refresh token and the
 * user's organisations, but NO access token — that is minted per organisation
 * by /auth/switch. One organisation: switch straight into it. None: the user
 * is brand new, so they go to /setup carrying the refresh token. Several: pick.
 *
 * ---------------------------------------------------------------------------
 * THE DOOR SHOWS THE SHOP.
 *
 * The background is a photograph of Shah G Tech itself — the signboard, the
 * counter, the floor. Nobody signing in has to wonder whether they are in the
 * right system, and the five people who use this see their own workplace
 * rather than a stock gradient.
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
          body: { email, password, fullName },
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
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white px-4 py-3.5 text-left shadow-lg shadow-black/10 ring-1 ring-slate-900/5 transition-colors hover:bg-emerald-50 hover:ring-emerald-200"
            >
              <span className="font-medium text-slate-900">{org.tenantName}</span>
              <span className="text-xs text-slate-500">{org.role}</span>
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
        className="rounded-2xl bg-white p-6 shadow-2xl shadow-black/25 ring-1 ring-white/40
                   supports-[backdrop-filter]:bg-white/88 supports-[backdrop-filter]:backdrop-blur-2xl"
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === 'register' ? (
            <Field label="Your name">
              <Input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                autoComplete="name"
                placeholder="Ahmad bin Ismail"
              />
            </Field>
          ) : null}

          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@shahgtech.my"
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
                className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-slate-500 transition-colors hover:text-slate-800"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          {mode === 'register' ? (
            <p className="text-xs text-slate-400">
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

      <p className="text-center text-sm text-slate-300">
        {mode === 'login' ? 'New here?' : 'Already registered?'}{' '}
        <button
          className="font-medium text-emerald-300 underline-offset-2 hover:underline"
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
      <h1 className="text-2xl font-semibold tracking-tight text-white drop-shadow-sm">{title}</h1>
      <p className="text-sm text-slate-300">{subtitle}</p>
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
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* The shop itself, drifting slowly. `inset-0` with object-cover means
          the crop follows the viewport rather than the photo's own ratio. */}
      <img
        src={shop.src}
        alt=""
        aria-hidden
        className="emil-drift absolute inset-0 h-full w-full object-cover"
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
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white p-1.5 shadow-lg shadow-black/40">
              <img src={mark.src} alt="" className="h-full w-full object-contain" />
            </div>
            <div>
              <div className="text-base font-semibold leading-tight text-white">Shah G Tech</div>
              <div className="text-xs text-slate-300">shop &amp; books</div>
            </div>
          </div>

          <div className="space-y-8">
            <h2
              className="emil-rise max-w-md text-3xl font-semibold leading-snug tracking-tight text-white"
              style={{ animationDelay: '80ms' }}
            >
              The counter, the workshop and the accounts — one system, one set of numbers.
            </h2>
            <ul className="space-y-4">
              {PROMISES.map((promise, i) => (
                <li
                  key={promise.icon}
                  className="emil-rise flex items-start gap-3 text-sm text-slate-200"
                  style={{ animationDelay: `${160 + i * 90}ms` }}
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-400/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                    <Icon name={promise.icon} />
                  </span>
                  <span className="max-w-sm leading-relaxed">{promise.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <p
            className="emil-rise max-w-sm text-xs leading-relaxed text-slate-400"
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
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white p-1.5 shadow-lg shadow-black/40">
                <img src={mark.src} alt="" className="h-full w-full object-contain" />
              </div>
              <img src={wordmark.src} alt="Shah G Tech" className="h-9 w-auto brightness-0 invert" />
            </div>

            {children}

            {/* And so do the promises — on an iPad in portrait this is the whole
                of the sign-in screen, and a page that says nothing about itself
                is the thing this redesign set out to fix. */}
            <ul className="space-y-2.5 border-t border-white/15 pt-5 lg:hidden">
              {PROMISES.map((promise) => (
                <li key={promise.icon} className="flex items-start gap-2.5 text-xs text-slate-300">
                  <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-400/15 text-emerald-300">
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
