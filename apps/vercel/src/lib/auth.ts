import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { adminAuth } from './firebase-admin';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function requireUser(req: Request): Promise<{ uid: string }> {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, 'Sign in to continue.');
  }
  try {
    const decoded = await adminAuth.verifyIdToken(match[1]);
    if (!decoded.uid) {
      throw new ApiError(401, 'Sign in to continue.');
    }
    return { uid: decoded.uid };
  } catch {
    throw new ApiError(401, 'Sign in to continue.');
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, 'Invalid request payload.');
  }
}

export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid request payload.' }, { status: 400 });
    }
    console.error('API request failed.', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code).replace(/[^\w/-]/g, '').slice(0, 64)
        : undefined,
    });
    return NextResponse.json(
      { error: 'The server could not complete this request.' },
      { status: 500 },
    );
  }
}
