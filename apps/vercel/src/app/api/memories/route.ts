import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

const createSchema = z
  .object({
    text: z.string().min(1).max(2000),
    id: z.string().min(1).optional(),
  })
  .strict();

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/memories`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const memories = await store.memories.list(uid);
    return NextResponse.json(memories);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/memories`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid memory payload.');
    }
    const memory = await store.memories.save(uid, parsed.data);
    return NextResponse.json(memory, { status: 201 });
  });
}
