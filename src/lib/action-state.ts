/** Shared shape returned by server actions (serialisable, safe to show to users). */
export type ActionState<T = unknown> =
  | { ok: true; message?: string; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined>; code?: string }
  | null;
