import { NextResponse } from 'next/server';
import { ApiError, handle, requireUser } from '../../../../lib/auth';
import { rateLimit } from '../../../../lib/rate-limit';
import { store } from '../../../../lib/store';

export async function GET(req: Request, { params }: { params: { taskId: string } }) {
  return handle(async () => {
    const { uid } = await requireUser(req);
    if (!rateLimit(`${uid}:/api/tasks/${params.taskId}`)) {
      throw new ApiError(429, 'Too many requests. Try again shortly.');
    }
    const detail = await store.tasks.detail(uid, params.taskId);
    return NextResponse.json(detail);
  });
}
