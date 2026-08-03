/**
 * The handful of primitives every screen shares.
 *
 * Hand-rolled rather than a component library: a few components cover this
 * app, and a registry of fifty would be dependency surface with no second
 * user. If the design system grows past what a file can hold, that is the
 * moment to adopt one — with this file as the shopping list.
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary:
      'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:shadow-none',
    ghost:
      'bg-white text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-slate-300',
  }[variant];
  return (
    <button
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  /** Optional right-aligned header content — a button, a badge, a date. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-slate-900/5">
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {action ?? null}
        </div>
      ) : null}
      <div className="p-5">{children}</div>
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const tone =
    {
      RECEIVED: 'bg-slate-100 text-slate-700 ring-slate-200',
      QUOTED: 'bg-amber-50 text-amber-800 ring-amber-200',
      APPROVED: 'bg-sky-50 text-sky-800 ring-sky-200',
      IN_PROGRESS: 'bg-sky-50 text-sky-800 ring-sky-200',
      READY: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      COLLECTED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      DECLINED: 'bg-red-50 text-red-700 ring-red-200',
      CANCELLED: 'bg-red-50 text-red-700 ring-red-200',
      PAID: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      ISSUED: 'bg-amber-50 text-amber-800 ring-amber-200',
      PART_PAID: 'bg-amber-50 text-amber-800 ring-amber-200',
      ACTIVE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    }[status] ?? 'bg-slate-100 text-slate-700 ring-slate-200';
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-inset ring-red-200">
      {message}
    </p>
  );
}
