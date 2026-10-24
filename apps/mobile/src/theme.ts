export const colors = {
  bg: '#0f1115',
  panel: '#171a21',
  panel2: '#1d212b',
  border: '#2a2f3a',
  text: '#e8eaf0',
  muted: '#9aa3b2',
  accent: '#7c9cff',
  danger: '#ff6b6b',
  ok: '#4ade80',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
} as const;

export const statusColor: Record<string, string> = {
  queued: colors.accent,
  running: colors.accent,
  completed: colors.ok,
  failed: colors.danger,
  interrupted: colors.muted,
  cancelled: colors.muted,
};
