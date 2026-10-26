const characters = ['blue', 'mint', 'orange', 'purple'] as const;

/**
 * Stable identity keeps each specialist recognizable across views and reloads.
 * UUID-shaped ids concentrate in one color bucket under the plain multiplicative
 * hash, so the murmur3-style avalanche finalizer spreads the low bits first.
 */
function characterFor(identity?: string) {
  if (!identity) return characters[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  hash = hash ^ (hash >>> 16);
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = hash ^ (hash >>> 13);
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = hash ^ (hash >>> 16);
  hash = hash >>> 0;
  return characters[hash % characters.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
}) {
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <img
        className="dot-body"
        src={`/dots/${characterFor(identity)}.png`}
        alt={decorative ? '' : `${name} is ${state}`}
        width={512}
        height={512}
        draggable={false}
      />
    </span>
  );
}
