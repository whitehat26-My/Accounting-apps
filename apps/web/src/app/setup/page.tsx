'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, saveSession } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * First run: create the organisation.
 *
 * One form, one POST, and the response carries a working access token — the
 * user lands on the dashboard of a tenant that exists, with a chart of
 * accounts, a fiscal year and document numbering already in place.
 */
export default function SetupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [ssm, setSsm] = useState('');
  const currentYear = new Date().getFullYear();
  const [fiscalStart, setFiscalStart] = useState(`${currentYear}-01-01`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const refreshToken = window.sessionStorage.getItem('emil.onboarding.refreshToken');
      if (!refreshToken) {
        router.push('/login');
        return;
      }

      const created = await api<{
        organisation: { tenantId: string; name: string };
        accessToken: string;
        refreshToken: string;
      }>('/v1/organisations', {
        method: 'POST',
        anonymous: true,
        body: {
          refreshToken,
          organisation: {
            name,
            ...(ssm ? { ssmRegistrationNo: ssm } : {}),
            fiscalYearStart: fiscalStart,
          },
        },
      });

      window.sessionStorage.removeItem('emil.onboarding.refreshToken');
      saveSession({
        refreshToken: created.refreshToken,
        accessToken: created.accessToken,
        tenantId: created.organisation.tenantId,
        organisationName: created.organisation.name,
      });
      router.push('/');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto mt-24 max-w-md space-y-4">
      <h1 className="text-center text-2xl font-bold text-positive">Set up your shop</h1>
      <Card>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Business name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Emil Computer Centre Sdn Bhd"
            />
          </Field>
          <Field label="SSM registration number (optional)">
            <Input value={ssm} onChange={(e) => setSsm(e.target.value)} placeholder="202401012345" />
          </Field>
          <Field label="First day of your financial year">
            <Input
              type="date"
              value={fiscalStart}
              onChange={(e) => setFiscalStart(e.target.value)}
              required
            />
          </Field>
          <p className="text-xs text-ink-muted">
            This creates your chart of accounts, twelve monthly periods and document numbering.
            Tax codes are added afterwards, each citing the regulation its rate comes from.
          </p>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Creating…' : 'Create organisation'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
