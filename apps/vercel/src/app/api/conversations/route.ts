import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

const createSchema = z
  .object({
    dotId: z.string().min(1),
    title: z.string().min(1).max(120).default('A new thought'),
  })
  .strict();

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/conversations`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const conversations = await store.conversations.list(uid);
    return NextResponse.json(conversations);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/conversations`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid conversation payload.');
    }
    const conversation = await store.conversations.create(uid, parsed.data);
    return NextResponse.json(conversation, { status: 201 });
  });
}
