'use client';

import { useEffect } from 'react';

export type LeaveGuard = () => boolean | Promise<boolean>;
export type RegisterLeaveGuard = (guard: LeaveGuard | null) => void;

export function useBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
