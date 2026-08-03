'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, saveSession } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * Sign in / register, then land somewhere useful.
 *
 * The API's shape drives the flow: login returns a refresh token and the
 * user's organisations, but NO access token — that is minted per organisation
 * by /auth/switch. One organisation: switch straight into it. None: the user
 * is brand new, so they go to /setup carrying the refresh token. Several: pick.
 */

interface LoginResponse {
  refreshToken: string;
  organisations: { tenantId: string; name: string; role: string }[];
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      <main className="mx-auto mt-24 max-w-sm space-y-4">
        <Card title="Choose an organisation">
          <div className="space-y-2">
            {organisations.map((org) => (
              <Button
                key={org.tenantId}
                variant="ghost"
                className="w-full text-left"
                onClick={() => void enter(org.tenantId, org.name, refreshToken)}
              >
                {org.name} <span className="text-xs text-slate-500">({org.role})</span>
              </Button>
            ))}
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-24 max-w-sm space-y-4">
      <h1 className="text-center text-2xl font-bold text-emerald-800">Emil</h1>
      <Card title={mode === 'login' ? 'Sign in' : 'Create your account'}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {mode === 'register' ? (
            <Field label="Your name">
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            </Field>
          ) : null}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Register'}
          </Button>
        </form>
        <button
          className="mt-3 w-full text-center text-xs text-slate-500 hover:text-slate-800"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already registered? Sign in'}
        </button>
      </Card>
    </main>
  );
}
