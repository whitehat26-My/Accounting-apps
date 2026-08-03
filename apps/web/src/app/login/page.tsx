'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { api, saveSession } from '@/lib/api';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { Icon } from '@/components/icons';
import mark from '@/brand/mark.png';
import wordmark from '@/brand/wordmark.png';

/**
 * Sign in / register, then land somewhere useful.
 *
 * The API's shape drives the flow: login returns a refresh token and the
 * user's organisations, but NO access token — that is minted per organisation
 * by /auth/switch. One organisation: switch straight into it. None: the user
 * is brand new, so they go to /setup carrying the refresh token. Several: pick.
 *
 * ---------------------------------------------------------------------------
 * THE DOOR SHOULD LOOK LIKE THE BUILDING.
 *
 * A lone form card on an empty page tells a first-time user nothing — not what
 * this is, not that they are in the right place. So the sign-in screen wears
 * the app's own furniture: the dark rail from `(app)/layout.tsx`, the shop's
 * mark, and three plain sentences about what the system does. The form sits on
 * the light side, exactly where the work will be once they are in.
 *
 * The brand panel is `lg:` and up. Below that — iPad portrait, phones — it
 * collapses to a centred card, because splitting 768px in half leaves two
 * cramped columns rather than one comfortable one.
 * ---------------------------------------------------------------------------
 */

interface LoginResponse {
  refreshToken: string;
  organisations: { tenantId: string; name: string; role: string }[];
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
        await enter(only.tenantId, only.name, login.refreshToken);
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
              onClick={() => void enter(org.tenantId, org.name, refreshToken)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white px-4 py-3.5 text-left shadow-sm ring-1 ring-slate-900/5 transition-colors hover:bg-emerald-50 hover:ring-emerald-200"
            >
              <span className="font-medium text-slate-900">{org.name}</span>
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

      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-900/5">
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

      <p className="text-center text-sm text-slate-500">
        {mode === 'login' ? 'New here?' : 'Already registered?'}{' '}
        <button
          className="font-medium text-emerald-700 underline-offset-2 hover:underline"
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
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <p className="text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}

/**
 * The brand half and the working half, side by side.
 *
 * The glow is two soft radial gradients — emerald from the app's accent, blue
 * from the logo's own hexagon — so the panel carries both of the shop's
 * colours without a background image to load.
 */
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-slate-950 p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(42rem 32rem at 5% 100%, rgba(5,150,105,0.30), transparent 62%), ' +
              'radial-gradient(38rem 28rem at 95% 0%, rgba(24,117,190,0.38), transparent 60%)',
          }}
        />

        <div className="relative flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white p-1.5 shadow-lg shadow-black/40">
            <img src={mark.src} alt="" className="h-full w-full object-contain" />
          </div>
          <div>
            <div className="text-base font-semibold leading-tight text-white">Shah G Tech</div>
            <div className="text-xs text-slate-400">shop &amp; books</div>
          </div>
        </div>

        <div className="relative space-y-8">
          <h2 className="max-w-md text-3xl font-semibold leading-snug tracking-tight text-white">
            The counter, the workshop and the accounts — one system, one set of numbers.
          </h2>
          <ul className="space-y-4">
            {PROMISES.map((promise) => (
              <li key={promise.icon} className="flex items-start gap-3 text-sm text-slate-300">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Icon name={promise.icon} />
                </span>
                <span className="max-w-sm leading-relaxed">{promise.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative max-w-sm text-xs leading-relaxed text-slate-500">
          Ringgit Malaysia, Kuala Lumpur time. The ledger is append-only — a mistake is
          corrected by a reversing entry, never quietly edited away.
        </p>
      </aside>

      <main
        className="flex flex-1 items-center justify-center px-5 py-12"
        style={{
          background:
            'radial-gradient(38rem 26rem at 50% 0%, #ffffff, transparent 70%), ' +
            'radial-gradient(30rem 22rem at 50% 100%, rgba(5,150,105,0.07), transparent 65%), #f1f5f9',
        }}
      >
        <div className="w-full max-w-sm space-y-5">
          {/* The brand panel is hidden below lg, so the mark comes along here. */}
          <img src={wordmark.src} alt="Shah G Tech" className="mx-auto mb-2 h-12 w-auto lg:hidden" />
          {children}

          {/* And so do the promises — on an iPad in portrait this is the whole
              of the sign-in screen, and a page that says nothing about itself
              is the thing this redesign set out to fix. */}
          <ul className="space-y-2.5 border-t border-slate-200 pt-5 lg:hidden">
            {PROMISES.map((promise) => (
              <li key={promise.icon} className="flex items-start gap-2.5 text-xs text-slate-500">
                <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
                  <Icon name={promise.icon} className="!h-3 !w-3" />
                </span>
                <span className="leading-relaxed">{promise.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
