import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../../lib/auth';
import { rateLimit } from '../../../../../lib/rate-limit';
import { store } from '../../../../../lib/store';

const appendSchema = z
  .object({
    role: z.literal('user'),
    content: z.string().min(1).max(4000),
  })
  .strict();

export async function GET(
  req: Request,
  { params }: { params: { conversationId: string } },
) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/conversations/${params.conversationId}/messages`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const messages = await store.conversations.getMessages(uid, params.conversationId, 100);
    return NextResponse.json(messages);
  });
}

export async function POST(
  req: Request,
  { params }: { params: { conversationId: string } },
) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/conversations/${params.conversationId}/messages`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = appendSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid message payload.');
    }
    const message = await store.conversations.appendMessage(uid, params.conversationId, {
      role: parsed.data.role,
      content: parsed.data.content,
    });
    return NextResponse.json(message, { status: 201 });
  });
}
