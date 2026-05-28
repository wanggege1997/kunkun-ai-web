'use client';

import { useSyncExternalStore } from 'react';

export type UserBalanceSnapshot = {
  balance: number | null;
  ready: boolean;
  isAuthed: boolean;
};

const BALANCE_KEY = 'dundun-balance-v1';
const AUTH_CACHE_KEY = 'auth_user_cache';

let snapshot: UserBalanceSnapshot = {
  balance: null,
  ready: false,
  isAuthed: false,
};

let cacheHydrated = false;
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

const setSnapshot = (next: UserBalanceSnapshot) => {
  snapshot = next;
  emit();
};

const hydrateFromCache = () => {
  if (cacheHydrated || typeof window === 'undefined') return;
  cacheHydrated = true;

  try {
    let cachedBalance: number | null = null;
    let cachedAuthed = false;

    const authRaw = window.localStorage.getItem(AUTH_CACHE_KEY);
    if (authRaw) {
      const auth = JSON.parse(authRaw) as { points?: number };
      const points = Number(auth?.points);
      if (!Number.isNaN(points) && points >= 0) {
        cachedBalance = points;
        cachedAuthed = true;
      }
    }

    const balanceRaw = window.localStorage.getItem(BALANCE_KEY);
    if (balanceRaw) {
      const points = Number(balanceRaw);
      if (!Number.isNaN(points) && points >= 0) {
        cachedBalance = points;
      }
    }

    if (cachedBalance !== null) {
      setSnapshot({
        balance: cachedBalance,
        ready: true,
        isAuthed: cachedAuthed,
      });
    }
  } catch {
    // ignore
  }
};

export const setUserBalance = (nextBalance: number | null) => {
  const normalized = typeof nextBalance === 'number' && Number.isFinite(nextBalance) && nextBalance >= 0
    ? nextBalance
    : null;

  setSnapshot({
    ...snapshot,
    balance: normalized,
    ready: true,
    isAuthed: normalized === null ? snapshot.isAuthed : true,
  });

  if (typeof window !== 'undefined') {
    try {
      if (normalized === null) {
        window.localStorage.removeItem(BALANCE_KEY);
      } else {
        window.localStorage.setItem(BALANCE_KEY, String(normalized));
      }
    } catch {
      // ignore
    }
  }
};

export const setUserAuthState = (isAuthed: boolean) => {
  const nextBalance = isAuthed ? snapshot.balance : null;
  setSnapshot({
    ...snapshot,
    isAuthed,
    ready: true,
    balance: nextBalance,
  });

  if (!isAuthed && typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(BALANCE_KEY);
      window.localStorage.removeItem(AUTH_CACHE_KEY);
    } catch {
      // ignore
    }
  }
};

export const refreshUserBalance = async () => {
  try {
    const response = await fetch('/api/me', { cache: 'no-store' });
    const data = await response.json().catch(() => null);

    if (response.ok && data?.success && data?.data) {
      const points = Number(data.data.points ?? 0);
      const safePoints = !Number.isNaN(points) && points >= 0 ? points : 0;

      setSnapshot({
        balance: safePoints,
        ready: true,
        isAuthed: true,
      });

      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(BALANCE_KEY, String(safePoints));
          window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(data.data));
        } catch {
          // ignore
        }
      }
      return;
    }

    if (response.status === 401) {
      setUserAuthState(false);
      return;
    }

    setSnapshot({ ...snapshot, ready: true });
  } catch {
    setSnapshot({ ...snapshot, ready: true });
  }
};

export const subscribeUserBalance = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getUserBalanceSnapshot = () => {
  hydrateFromCache();
  return snapshot;
};

export const useUserBalance = () => {
  return useSyncExternalStore(subscribeUserBalance, getUserBalanceSnapshot, getUserBalanceSnapshot);
};
