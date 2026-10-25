import { timingSafeEqual } from 'node:crypto';

export function matchesWorkerToken(
  authorization: string | null,
  expectedToken: string | undefined,
): boolean {
  const expected = expectedToken?.trim();
  const supplied = authorization?.match(/^Bearer\s+([^\s]+)\s*$/i)?.[1];
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
