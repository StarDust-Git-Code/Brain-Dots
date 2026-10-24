import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../../../lib/auth';
import { rateLimit } from '../../../../../../lib/rate-limit';
import { store } from '../../../../../../lib/store';

const patchSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    content: z.string().max(100_000).optional(),
    parentId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export async function GET(
  req: Request,
  { params }: { params: { spaceId: string; pageId: string } },
) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces/${params.spaceId}/pages/${params.pageId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const page = await store.pages.get(uid, params.spaceId, params.pageId);
    return NextResponse.json(page);
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { spaceId: string; pageId: string } },
) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces/${params.spaceId}/pages/${params.pageId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = patchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid page payload.');
    }
    const page = await store.pages.update(uid, params.spaceId, params.pageId, parsed.data);
    return NextResponse.json(page);
  });
}
