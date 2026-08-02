/**
 * The handful of primitives every screen shares.
 *
 * Hand-rolled rather than a component library: five components cover this
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
    primary: 'bg-emerald-700 text-white hover:bg-emerald-800 disabled:bg-neutral-300',
    ghost: 'border border-neutral-300 text-neutral-800 hover:bg-neutral-100',
    danger: 'bg-red-700 text-white hover:bg-red-800',
  }[variant];
  return (
    <button
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>
      {children}
    </label>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      {title ? <h2 className="mb-3 text-sm font-semibold text-neutral-800">{title}</h2> : null}
      {children}
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const tone =
    {
      RECEIVED: 'bg-neutral-100 text-neutral-700',
      QUOTED: 'bg-amber-100 text-amber-800',
      APPROVED: 'bg-blue-100 text-blue-800',
      IN_PROGRESS: 'bg-blue-100 text-blue-800',
      READY: 'bg-emerald-100 text-emerald-800',
      COLLECTED: 'bg-emerald-100 text-emerald-800',
      DECLINED: 'bg-red-100 text-red-700',
      CANCELLED: 'bg-red-100 text-red-700',
      PAID: 'bg-emerald-100 text-emerald-800',
      ISSUED: 'bg-amber-100 text-amber-800',
    }[status] ?? 'bg-neutral-100 text-neutral-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {message}
    </p>
  );
}
