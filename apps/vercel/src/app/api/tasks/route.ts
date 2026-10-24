import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';
import { store } from '../../../lib/store';

const createSchema = z
  .object({
    prompt: z.string().min(3).max(4000),
    intervalSeconds: z.number().int().min(60).max(31_536_000).nullable().optional(),
    threadId: z.string().min(1).nullable().optional(),
    dotId: z.string().min(1).nullable().optional(),
  })
  .strict();

export async function GET(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/tasks`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const tasks = await store.tasks.list(uid);
    return NextResponse.json(tasks);
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/tasks`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = createSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid task payload.');
    }
    const task = await store.tasks.create(uid, {
      prompt: parsed.data.prompt,
      intervalSeconds: parsed.data.intervalSeconds ?? null,
      threadId: parsed.data.threadId ?? null,
      dotId: parsed.data.dotId ?? null,
    });
    return NextResponse.json(task, { status: 201 });
  });
}
