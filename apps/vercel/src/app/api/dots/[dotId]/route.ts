import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../lib/auth';
import { rateLimit } from '../../../../lib/rate-limit';
import { store } from '../../../../lib/store';

const updateSchema = z
  .object({
    name: z.string().min(1).max(40).optional(),
    instructions: z.string().min(3).max(2000).optional(),
    researchAllowed: z.boolean().optional(),
    memoryAllowed: z.boolean().optional(),
    spaceId: z.string().min(1).optional(),
    spaceIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export async function PUT(req: Request, { params }: { params: { dotId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/dots/${params.dotId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = updateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid dot payload.');
    }
    const dot = await store.dots.update(uid, params.dotId, parsed.data);
    return NextResponse.json(dot);
  });
}
