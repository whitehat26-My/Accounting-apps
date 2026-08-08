'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { NoticeProvider } from '@/components/notice';

export function Providers({ children }: { children: ReactNode }) {
  // Constructed in state so React strict-mode double-render reuses ONE client.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
        },
      }),
  );
  /*
   * Notices sit HERE rather than in the signed-in shell, so they cover login,
   * onboarding and the public verify page too. Somebody failing to sign in is
   * exactly as entitled to be told why as somebody failing to print a receipt.
   */
  return (
    <QueryClientProvider client={client}>
      <NoticeProvider>{children}</NoticeProvider>
    </QueryClientProvider>
  );
}
