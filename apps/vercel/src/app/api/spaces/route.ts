import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

const createSchema = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().max(500).default(''),
  })
  .strict();

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const spaces = await store.spaces.list(uid);
    return NextResponse.json(spaces);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid space payload.');
    }
    const space = await store.spaces.create(uid, parsed.data);
    return NextResponse.json(space, { status: 201 });
  });
}
