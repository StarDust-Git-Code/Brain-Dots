import { API_BASE_URL } from '../config';
import { auth } from './firebase';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  options: { uid?: string; timeoutMs?: number } = {},
): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  if (options.uid && user.uid !== options.uid) throw new Error('Session changed.');
  const token = await user.getIdToken();
  if (auth.currentUser?.uid !== user.uid) throw new Error('Session changed.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const response = await fetch(`${API_BASE_URL}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (auth.currentUser?.uid !== user.uid) throw new Error('Session changed.');
    if (!response.ok)
      throw new ApiError(
        data.error ?? `Request failed (${response.status}).`,
        response.status,
        data,
      );
    return data as T;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('Request timed out. Check your connection and retry.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
