import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../../lib/auth';
import { rateLimit } from '../../../../../lib/rate-limit';
import { store } from '../../../../../lib/store';

const createSchema = z
  .object({
    title: z.string().min(1).max(160).default('Untitled page'),
    content: z.string().max(100_000).default(''),
    parentId: z.string().min(1).nullable().optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: { spaceId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces/${params.spaceId}/pages`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const pages = await store.pages.list(uid, params.spaceId);
    return NextResponse.json(pages);
  });
}

export async function POST(req: Request, { params }: { params: { spaceId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/spaces/${params.spaceId}/pages`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid page payload.');
    }
    const page = await store.pages.create(uid, params.spaceId, {
      title: parsed.data.title,
      content: parsed.data.content,
      parentId: parsed.data.parentId ?? null,
    });
    return NextResponse.json(page, { status: 201 });
  });
}
