import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

const createSchema = z
  .object({
    name: z.string().min(1).max(40),
    instructions: z.string().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    spaceId: z.string().min(1),
    spaceIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/dots`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const dots = await store.dots.list(uid);
    return NextResponse.json(dots);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/dots`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid dot payload.');
    }
    const dot = await store.dots.create(uid, parsed.data);
    return NextResponse.json(dot, { status: 201 });
  });
}
