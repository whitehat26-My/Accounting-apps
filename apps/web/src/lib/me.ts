'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Who is signed in, and what they may see.
 *
 * The SERVER is the security boundary — every request is authorised there.
 * This exists so the cashier's screen simply does not offer the reports she
 * cannot open: hiding a door is courtesy, the lock is elsewhere.
 */

export interface Me {
  userId: string;
  role: string;
  permissions: string[];
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/v1/auth/me'),
    staleTime: 5 * 60_000,
  });
}

export function can(me: Me | undefined, permission: string): boolean {
  return me?.permissions.includes(permission) ?? false;
}

export const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  ACCOUNTANT: 'Accountant',
  APPROVER: 'Approver',
  BOOKKEEPER: 'Bookkeeper',
  SALES: 'Cashier / Sales',
  TECHNICIAN: 'Technician',
  READ_ONLY: 'Read-only',
  EXTERNAL_AUDITOR: 'External auditor',
};
