import { z } from "zod"

// One identifier contract for every thread-bearing boundary. Keeping this deliberately narrower
// than a filesystem basename also makes the value safe as a tmux target, environment value, and
// literal path segment without relying on shell escaping or platform-specific filename rules.
export const THREAD_SLUG_MAX_CHARS = 200
export const ThreadSlug = z.string()
  .min(1)
  .max(THREAD_SLUG_MAX_CHARS)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
export type ThreadSlug = z.infer<typeof ThreadSlug>

export function parseThreadSlug(value: unknown): ThreadSlug {
  return ThreadSlug.parse(value)
}
