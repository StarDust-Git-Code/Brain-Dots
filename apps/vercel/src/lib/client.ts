'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { createContext, createElement, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
const ClientUserContext = createContext<string | null>(null);

export function ClientUserScope({ userId, children }: { userId: string; children: ReactNode }) {
  return createElement(ClientUserContext.Provider, { value: userId }, children);
}

function firebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedApp =
    getApps()[0] ??
    initializeApp({
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    });
  cachedAuth = getAuth(cachedApp);
  return cachedAuth;
}

export function useAuthState(): { user: User | null; loading: boolean } {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = firebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  return { user, loading };
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface ApiOptions {
  signal?: AbortSignal;
  expectedUserId?: string;
}

export async function api<T>(
  path: string,
  method: ApiMethod = 'GET',
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const auth = firebaseAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new ApiError('Sign in required.', 401);
  }
  if (options.expectedUserId && options.expectedUserId !== user.uid) {
    throw new DOMException('Account changed. Request cancelled.', 'AbortError');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
    if (nextUser?.uid !== user.uid) abort();
  });
  const checkScope = () => {
    if (controller.signal.aborted || auth.currentUser?.uid !== user.uid) {
      throw new DOMException('Request cancelled.', 'AbortError');
    }
  };

  try {
    checkScope();
    const token = await user.getIdToken();
    checkScope();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });

    let data: unknown = null;
    const text = await res.text();
    checkScope();
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        if (res.ok) throw new ApiError('The server returned an invalid response.', res.status);
      }
    }

    if (!res.ok) {
      let message = `Request failed (${res.status}).`;
      if (
        data &&
        typeof data === 'object' &&
        'error' in data &&
        typeof (data as { error: unknown }).error === 'string'
      ) {
        message = (data as { error: string }).error;
      }
      throw new ApiError(message, res.status, data);
    }

    return data as T;
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Bind requests to the account that rendered this component, including between auth events. */
export function useScopedApi(): typeof api {
  const userId = useContext(ClientUserContext);
  return useCallback(<T>(path: string, method: ApiMethod = 'GET', body?: unknown, options: ApiOptions = {}) =>
    api<T>(path, method, body, { ...options, expectedUserId: userId ?? undefined }), [userId]);
}

export async function signIn(email: string, password: string): Promise<User> {
  const credential = await signInWithEmailAndPassword(firebaseAuth(), email, password);
  return credential.user;
}

export async function signUp(email: string, password: string): Promise<User> {
  const credential = await createUserWithEmailAndPassword(firebaseAuth(), email, password);
  return credential.user;
}

export async function signOutUser(): Promise<void> {
  await signOut(firebaseAuth());
}
