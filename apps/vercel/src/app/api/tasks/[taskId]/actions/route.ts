import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { z } from 'zod';
import { ApiError, handle, readJson, requireUser } from '../../../../../lib/auth';
import { rateLimit } from '../../../../../lib/rate-limit';
import { store } from '../../../../../lib/store';

const actionSchema = z
  .object({
    action: z.enum(['run', 'pause', 'cancel']),
  })
  .strict();

export async function POST(req: Request, { params }: { params: { taskId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/tasks/${params.taskId}/actions`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const parsed = actionSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError(400, 'Invalid action payload.');
    }
    const task = await store.tasks.action(uid, params.taskId, parsed.data.action);
    return NextResponse.json(task);
  });
}
