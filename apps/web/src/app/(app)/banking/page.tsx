'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * Banking: the statement in, the books agreeing, from a sofa.
 *
 * The flow mirrors how the money actually moves: pick the account, paste or
 * upload the bank's CSV, PREVIEW it (a wrong column map must fail in front of
 * the person who can fix it), import — rules auto-code what they recognise —
 * then work the "to sort" queue, where the matching engine explains each
 * suggestion in words an auditor would accept.
 *
 * No arithmetic here, as everywhere in this app: amounts are the server's
 * decimal strings end to end.
 */

interface BankAccount {
  id: string;
  name: string;
  bankName: string;
  currency: string;
  glAccountId: string;
}

interface WireMoney {
  amount: string;
  currency: string;
}

interface BankLine {
  id: string;
  txnDate: string;
  description: string;
  reference: string | null;
  amount: WireMoney;
  status: string;
}

interface SuggestionLine {
  bankTransactionId: string;
  suggestions: {
    candidateIds: string[];
    kind: string;
    confidence: number;
    reason: string;
  }[];
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface BankRule {
  id: string;
  name: string;
  contains: string | null;
  matchesDirection: string | null;
  accountId: string;
  accountName: string;
  autoApply: boolean;
  isActive: boolean;
  hitCount: number;
}

interface ImportResult {
  imported: number;
  duplicates: number;
  autoCategorised: { ruleName: string; amount: string }[];
  ruleSuggestions: number;
}

interface PreviewResult {
  rows: { txnDate: string; description: string; amount: string; duplicate: boolean }[];
  violations: unknown[];
}

/** The common Malaysian export: date, description, signed amount. */
const DEFAULT_PROFILE = {
  bankName: 'My bank',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY' as string,
  amountConvention: 'SIGNED' as string,
  columns: { txnDate: 0, description: 1, amount: 2 },
};

export default function BankingPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => api<{ bankAccounts: BankAccount[] }>('/v1/bank-accounts'),
  });

  const glAccounts = useQuery({
    queryKey: ['gl-accounts'],
    queryFn: () => api<{ accounts: GlAccount[] }>('/v1/accounts'),
    enabled: can(me.data, 'journal.read'),
  });

  const selected =
    accounts.data?.bankAccounts.find((a) => a.id === accountId) ??
    accounts.data?.bankAccounts[0];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['bank-lines'] });
    void queryClient.invalidateQueries({ queryKey: ['bank-suggestions'] });
    void queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Banking</h1>

      {accounts.data && accounts.data.bankAccounts.length === 0 ? (
        <CreateAccountCard
          glAccounts={glAccounts.data?.accounts ?? []}
          onCreated={() => void queryClient.invalidateQueries({ queryKey: ['bank-accounts'] })}
        />
      ) : null}

      {accounts.data && accounts.data.bankAccounts.length > 1 ? (
        <div className="flex gap-2">
          {accounts.data.bankAccounts.map((a) => (
            <button
              key={a.id}
              onClick={() => setAccountId(a.id)}
              className={`rounded-md px-3 py-1.5 text-sm ${
                selected?.id === a.id
                  ? 'bg-emerald-100 font-medium text-emerald-900'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {a.name}
            </button>
          ))}
        </div>
      ) : null}

      {selected ? (
        <>
          <ImportCard account={selected} onImported={refresh} />
          <ToSortCard
            account={selected}
            glAccounts={glAccounts.data?.accounts ?? []}
            onChanged={refresh}
          />
          <RulesCard glAccounts={glAccounts.data?.accounts ?? []} onChanged={refresh} />
          <ReconcileCard account={selected} />
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateAccountCard({
  glAccounts,
  onCreated,
}: {
  glAccounts: GlAccount[];
  onCreated: () => void;
}) {
  const [name, setName] = useState('Maybank Current');
  const [bankName, setBankName] = useState('Malayan Banking Berhad');
  const [glAccountId, setGlAccountId] = useState('');
  const assetAccounts = glAccounts.filter((a) => a.type === 'ASSET');

  const create = useMutation({
    mutationFn: () =>
      api('/v1/bank-accounts', { method: 'POST', body: { name, bankName, glAccountId } }),
    onSuccess: onCreated,
  });

  return (
    <Card title="Set up your bank account">
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          One-time: name the account and pick the ledger account it lives on — usually
          Cash and Bank.
        </p>
        <Field label="Account name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Bank">
          <Input value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </Field>
        <Field label="Ledger account">
          <select
            className="w-full rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-3 py-2 text-sm"
            value={glAccountId}
            onChange={(e) => setGlAccountId(e.target.value)}
          >
            <option value="">Choose…</option>
            {assetAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Button onClick={() => create.mutate()} disabled={!glAccountId || create.isPending}>
          Create account
        </Button>
        {create.isError ? <ErrorNote error={create.error} /> : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ImportCard({
  account,
  onImported,
}: {
  account: BankAccount;
  onImported: () => void;
}) {
  const [content, setContent] = useState('');
  const [format, setFormat] = useState<'CSV' | 'ADVICE'>('CSV');
  const [dateFormat, setDateFormat] = useState(DEFAULT_PROFILE.dateFormat);
  const [delimiter, setDelimiter] = useState(DEFAULT_PROFILE.delimiter);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const profile = useMemo(
    () => ({ ...DEFAULT_PROFILE, bankName: account.bankName, dateFormat, delimiter }),
    [account.bankName, dateFormat, delimiter],
  );

  const statementDate = new Date().toISOString().slice(0, 10);
  const parseBody =
    format === 'ADVICE'
      ? { content, format, statementDate }
      : { content, format, profile, statementDate };

  const doPreview = useMutation({
    mutationFn: () =>
      api<PreviewResult>(`/v1/bank-accounts/${account.id}/statements/preview`, {
        method: 'POST',
        body: parseBody,
      }),
    onSuccess: (r) => {
      setPreview(r);
      setResult(null);
    },
  });

  const doImport = useMutation({
    mutationFn: () =>
      api<ImportResult>(`/v1/bank-accounts/${account.id}/statements`, {
        method: 'POST',
        body: parseBody,
      }),
    onSuccess: (r) => {
      setResult(r);
      setPreview(null);
      setContent('');
      onImported();
    },
  });

  const readFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => setContent(text));
  };

  return (
    <Card title="Import a statement">
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Export CSV from your online banking, then upload or paste it here. Expected
          columns: date, description, amount (negative = money out). Preview first —
          wrong settings should fail here, not in your books.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          className="text-sm"
          onChange={(e) => readFile(e.target.files?.[0])}
        />
        <textarea
          className="h-28 w-full rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 p-2 font-mono text-xs"
          placeholder={'Date,Description,Amount\n05/08/2026,TNB BILL PAYMENT,-380.50'}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="flex flex-wrap gap-3">
          <Field label="File type">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-1.5 text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value as 'CSV' | 'ADVICE')}
            >
              <option value="CSV">Table — one row per transaction</option>
              <option value="ADVICE">Payment advice — “Label : value” pages</option>
            </select>
          </Field>
          {format === 'CSV' ? (
            <>
              <Field label="Date format">
                <select
                  className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-1.5 text-sm"
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value)}
                >
                  <option>DD/MM/YYYY</option>
                  <option>DD-MM-YYYY</option>
                  <option>YYYY-MM-DD</option>
                </select>
              </Field>
              <Field label="Separator">
                <select
                  className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-1.5 text-sm"
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                >
                  <option value=",">Comma</option>
                  <option value=";">Semicolon</option>
                  <option value={'\t'}>Tab</option>
                </select>
              </Field>
            </>
          ) : (
            <p className="max-w-sm self-end pb-2 text-xs text-slate-500">
              For Maybank “payment details” exports (Our Reference, Total Amount, …).
              Incoming payments only; an advice without its own date is dated today.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => doPreview.mutate()}
            disabled={content.length === 0 || doPreview.isPending}
          >
            Preview
          </Button>
          <Button
            onClick={() => doImport.mutate()}
            disabled={content.length === 0 || doImport.isPending}
          >
            {doImport.isPending ? 'Importing…' : 'Import'}
          </Button>
        </div>
        {doPreview.isError ? <ErrorNote error={doPreview.error} /> : null}
        {doImport.isError ? <ErrorNote error={doImport.error} /> : null}

        {preview ? (
          <div className="rounded-md bg-slate-50 p-3 text-xs">
            <p className="mb-2 font-medium">
              {preview.rows.length} rows read
              {preview.violations.length > 0
                ? ` — ${preview.violations.length} problem(s), fix before importing`
                : ' — looks good'}
            </p>
            {preview.rows.slice(0, 5).map((r, i) => (
              <div key={i} className="flex justify-between border-t border-slate-200 py-1">
                <span>
                  {displayDate(r.txnDate)} · {r.description}
                  {r.duplicate ? ' · already held' : ''}
                </span>
                <span className={r.amount.startsWith('-') ? 'text-red-600' : 'text-emerald-700'}>
                  {rm(r.amount)}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {result ? (
          <div className="rounded-md bg-emerald-50 p-3 text-xs text-emerald-900">
            <p className="font-medium">
              Imported {result.imported} line{result.imported === 1 ? '' : 's'}
              {result.duplicates > 0 ? `, skipped ${result.duplicates} already held` : ''}.
            </p>
            {result.autoCategorised.length > 0 ? (
              <ul className="mt-1">
                {result.autoCategorised.map((a, i) => (
                  <li key={i}>
                    Rule “{a.ruleName}” booked {rm(a.amount)} automatically.
                  </li>
                ))}
              </ul>
            ) : null}
            {result.ruleSuggestions > 0 ? (
              <p className="mt-1">
                {result.ruleSuggestions} more line{result.ruleSuggestions === 1 ? '' : 's'} have
                a rule suggestion below.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ToSortCard({
  account,
  glAccounts,
  onChanged,
}: {
  account: BankAccount;
  glAccounts: GlAccount[];
  onChanged: () => void;
}) {
  const lines = useQuery({
    queryKey: ['bank-lines', account.id],
    queryFn: () =>
      api<{ transactions: BankLine[]; bookBalance: string }>(
        `/v1/bank-accounts/${account.id}/transactions?status=UNRECONCILED`,
      ),
  });

  const suggestions = useQuery({
    queryKey: ['bank-suggestions', account.id],
    queryFn: () => api<{ lines: SuggestionLine[] }>(`/v1/bank-accounts/${account.id}/suggestions`),
  });

  const suggestionFor = (lineId: string) =>
    suggestions.data?.lines
      .find((l) => l.bankTransactionId === lineId)
      ?.suggestions[0];

  const unsorted = lines.data?.transactions ?? [];

  return (
    <Card title={`To sort — ${account.name}`}>
      {lines.data ? (
        unsorted.length > 0 ? (
          <div className="space-y-3">
            {unsorted.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                suggestion={suggestionFor(line.id)}
                glAccounts={glAccounts}
                onChanged={onChanged}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            Nothing to sort — every imported line is matched. That is what reconciled means.
          </p>
        )
      ) : (
        <p className="text-sm text-slate-500">Loading…</p>
      )}
    </Card>
  );
}

function LineRow({
  line,
  suggestion,
  glAccounts,
  onChanged,
}: {
  line: BankLine;
  suggestion: { candidateIds: string[]; kind: string; confidence: number; reason: string } | undefined;
  glAccounts: GlAccount[];
  onChanged: () => void;
}) {
  const [bookAccountId, setBookAccountId] = useState('');
  const out = line.amount.amount.startsWith('-');
  const plAccounts = glAccounts.filter((a) => a.type === 'EXPENSE' || a.type === 'INCOME');

  const accept = useMutation({
    mutationFn: () =>
      api(`/v1/bank-transactions/${line.id}/match`, {
        method: 'POST',
        body: {
          matchedType: suggestion!.kind,
          matchedId: suggestion!.candidateIds[0],
          amount: line.amount.amount,
          confidence: suggestion!.confidence,
          method: 'MANUAL',
          reason: suggestion!.reason,
        },
      }),
    onSuccess: onChanged,
  });

  const book = useMutation({
    mutationFn: () =>
      api(`/v1/bank-transactions/${line.id}/journal`, {
        method: 'POST',
        body: { accountId: bookAccountId },
      }),
    onSuccess: onChanged,
  });

  const singleCandidate = suggestion !== undefined && suggestion.candidateIds.length === 1;

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{line.description}</span>
        <span className={`text-sm font-semibold ${out ? 'text-red-600' : 'text-emerald-700'}`}>
          {rm(line.amount.amount)}
        </span>
      </div>
      <div className="text-xs text-slate-500">{displayDate(line.txnDate)}</div>

      {suggestion ? (
        <div className="mt-2 rounded-md bg-emerald-50 p-2 text-xs text-emerald-900">
          <p>{suggestion.reason}</p>
          {singleCandidate ? (
            <Button
              className="mt-2"
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
            >
              Accept match ({suggestion.confidence}%)
            </Button>
          ) : (
            <p className="mt-1 italic">
              Settles several documents at once — confirm this one from the desktop for now.
            </p>
          )}
          {accept.isError ? <ErrorNote error={accept.error} /> : null}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-1.5 text-xs"
            value={bookAccountId}
            onChange={(e) => setBookAccountId(e.target.value)}
          >
            <option value="">Book to…</option>
            {plAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <Button onClick={() => book.mutate()} disabled={!bookAccountId || book.isPending}>
            Book it
          </Button>
          {book.isError ? <ErrorNote error={book.error} /> : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ReconciliationView {
  asOfDate: string;
  adjustedBankBalance: string;
  adjustedBookBalance: string;
  variance: string;
  reconciles: boolean;
  unpresentedPayments: string;
  depositsInTransit: string;
  unrecordedBankMovement: string;
}

/**
 * The month-end handshake: bank says, books say, and the difference must be
 * ZERO before sign-off. The server refuses a session that does not balance —
 * "reconciled with a RM 12 difference" is not a thing this system records.
 */
function ReconcileCard({ account }: { account: BankAccount }) {
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [signedOff, setSignedOff] = useState(false);

  const recon = useQuery({
    queryKey: ['reconciliation', account.id, asOf],
    queryFn: () =>
      api<ReconciliationView>(`/v1/bank-accounts/${account.id}/reconciliation?asOf=${asOf}`),
  });

  const signOff = useMutation({
    mutationFn: () =>
      api(`/v1/bank-accounts/${account.id}/reconciliation`, {
        method: 'POST',
        body: { periodStart: `${asOf.slice(0, 8)}01`, periodEnd: asOf },
      }),
    onSuccess: () => setSignedOff(true),
  });

  const r = recon.data;

  return (
    <Card title="Reconcile — does the bank agree with the books?">
      <div className="space-y-3">
        <Field label="As at">
          <Input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setSignedOff(false); }} />
        </Field>
        {r ? (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Bank says (adjusted)</span>
              <span className="font-medium">{rm(r.adjustedBankBalance)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Books say (adjusted)</span>
              <span className="font-medium">{rm(r.adjustedBookBalance)}</span>
            </div>
            <div
              className={`flex justify-between rounded-md px-3 py-2 font-semibold ${
                r.reconciles ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'
              }`}
            >
              <span>Difference</span>
              <span>{rm(r.variance)}</span>
            </div>
            {!r.reconciles ? (
              <p className="text-xs text-slate-500">
                A non-zero difference means a missing entry, a duplicate, or a wrong
                amount — work the “to sort” list above until this reads RM 0.00.
                Sign-off is refused until it does.
              </p>
            ) : null}
            {r.reconciles && !signedOff ? (
              <Button onClick={() => signOff.mutate()} disabled={signOff.isPending}>
                {signOff.isPending ? 'Signing off…' : 'Sign off this period'}
              </Button>
            ) : null}
            {signedOff ? (
              <p className="text-sm text-emerald-700">
                Signed off. The evidence is recorded — an auditor can see who, and when.
              </p>
            ) : null}
            {signOff.isError ? <ErrorNote error={signOff.error} /> : null}
          </div>
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RulesCard({
  glAccounts,
  onChanged,
}: {
  glAccounts: GlAccount[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [contains, setContains] = useState('');
  const [ruleAccountId, setRuleAccountId] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const plAccounts = glAccounts.filter((a) => a.type === 'EXPENSE' || a.type === 'INCOME');

  const rules = useQuery({
    queryKey: ['bank-rules'],
    queryFn: () => api<{ rules: BankRule[] }>('/v1/bank-rules'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['bank-rules'] });
    onChanged();
  };

  const create = useMutation({
    mutationFn: () =>
      api('/v1/bank-rules', {
        method: 'POST',
        body: { name: name || contains, contains, accountId: ruleAccountId, autoApply },
      }),
    onSuccess: () => {
      setName('');
      setContains('');
      setAutoApply(false);
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; patch: Record<string, boolean> }) =>
      api(`/v1/bank-rules/${input.id}`, { method: 'POST', body: input.patch }),
    onSuccess: invalidate,
  });

  const run = useMutation({
    mutationFn: () => api('/v1/bank-rules/run', { method: 'POST', body: {} }),
    onSuccess: invalidate,
  });

  return (
    <Card title="Rules — teach it your recurring lines">
      <div className="space-y-3">
        {rules.data && rules.data.rules.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1">If it contains</th>
                <th className="pb-1">Book to</th>
                <th className="pb-1 text-center">Auto</th>
                <th className="pb-1 text-right">Hits</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {rules.data.rules.map((r) => (
                <tr key={r.id} className={`border-t border-slate-100 ${r.isActive ? '' : 'opacity-40'}`}>
                  <td className="py-1.5 font-mono text-xs">{r.contains}</td>
                  <td className="py-1.5">{r.accountName}</td>
                  <td className="py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={r.autoApply}
                      onChange={() =>
                        toggle.mutate({ id: r.id, patch: { autoApply: !r.autoApply } })
                      }
                    />
                  </td>
                  <td className="py-1.5 text-right text-slate-500">{r.hitCount}</td>
                  <td className="py-1.5 text-right">
                    <button
                      className="text-xs text-slate-400 hover:text-slate-700"
                      onClick={() =>
                        toggle.mutate({ id: r.id, patch: { isActive: !r.isActive } })
                      }
                    >
                      {r.isActive ? 'disable' : 'enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-slate-500">
            No rules yet. Example: lines containing “TNB” book to Utilities — tick Auto and
            the electricity bill files itself on every import.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <Field label="Contains">
            <Input
              value={contains}
              onChange={(e) => setContains(e.target.value)}
              placeholder="TNB"
            />
          </Field>
          <Field label="Book to">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
              value={ruleAccountId}
              onChange={(e) => setRuleAccountId(e.target.value)}
            >
              <option value="">Choose…</option>
              {plAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-1 pb-2 text-xs">
            <input
              type="checkbox"
              checked={autoApply}
              onChange={(e) => setAutoApply(e.target.checked)}
            />
            Auto-book
          </label>
          <Button
            onClick={() => create.mutate()}
            disabled={contains.trim().length < 3 || !ruleAccountId || create.isPending}
          >
            Add rule
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            Run rules now
          </Button>
        </div>
        {create.isError ? <ErrorNote error={create.error} /> : null}
        {run.isError ? <ErrorNote error={run.error} /> : null}
      </div>
    </Card>
  );
}
