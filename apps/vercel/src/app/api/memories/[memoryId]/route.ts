import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../lib/auth';
import { rateLimit } from '../../../../lib/rate-limit';
import { store } from '../../../../lib/store';

const updateSchema = z
  .object({
    text: z.string().min(1).max(2000),
  })
  .strict();

export async function PUT(req: Request, { params }: { params: { memoryId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/memories/${params.memoryId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = updateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid memory payload.');
    }
    const memory = await store.memories.save(uid, { id: params.memoryId, text: parsed.data.text });
    return NextResponse.json(memory);
  });
}

export async function DELETE(req: Request, { params }: { params: { memoryId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/memories/${params.memoryId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    await store.memories.delete(uid, params.memoryId);
    return NextResponse.json({ ok: true });
  });
}
