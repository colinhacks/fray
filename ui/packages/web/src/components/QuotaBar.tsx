import { useQuery } from "@tanstack/react-query"
import type { ProviderQuota, QuotaWindow } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { ProviderMark } from "./ProviderMark.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// THE SIDEBAR QUOTA STRIP — a thin row floating directly above the dispatch box, one compact chip per
// backend (Claude, Codex) showing REMAINING subscription quota as a battery-style meter. Click a chip
// for the full per-window breakdown.
//
// The live connection state is NOT repeated here: it already lives in the top-left IdentityMark (the
// one canonical connection indicator). This strip used to carry a second "connected" dot+word, which
// was pure redundancy sitting a few hundred px from the first — removed.
//
// Quota is polled (rpc.quota) rather than pushed on the board: it is ACCOUNT-global, not per-thread,
// and its sources are slow/rate-limited (Codex rollout tail; Claude's undocumented OAuth usage
// endpoint), so a 60s poll with a long stale window is the right cadence.

export function QuotaBar() {
  // Poll every 60s; keep the last value through refetches so the bar never flickers to empty. The
  // query never rejects meaningfully (the server degrades each provider to "unavailable").
  const quota = useQuery({
    queryKey: ["quota"],
    queryFn: () => rpc.quota(),
    refetchInterval: 60_000,
    staleTime: 55_000,
    refetchOnWindowFocus: true,
  })

  return (
    <div data-quota-bar className="flex items-center justify-end gap-2.5 px-1.5 py-1 text-[11px]">
      <QuotaChip backend="claude" quota={quota.data?.claude} loading={quota.isLoading} />
      <QuotaChip backend="codex" quota={quota.data?.codex} loading={quota.isLoading} />
    </div>
  )
}

// One provider's chip: the provider mark + a battery meter of the TIGHTEST window's remaining quota,
// with a percentage. Clicking opens a Popover with the full per-window breakdown (both windows + reset
// times + plan). Unavailable → a muted dash whose Popover explains why; loading (first fetch) → a quiet
// non-interactive placeholder.
function QuotaChip({ backend, quota, loading }: { backend: "claude" | "codex"; quota: ProviderQuota | undefined; loading: boolean }) {
  const providerLabel = backend === "claude" ? "Claude" : "Codex"

  // First fetch, nothing cached yet — a quiet placeholder, no popover (there is nothing to show).
  if (!quota && loading) {
    return (
      <span className="flex items-center gap-1 text-muted/45">
        <ProviderMark backend={backend} className="translate-y-0!" />
        <span className="tabular-nums">··</span>
      </span>
    )
  }

  const unavailable = !quota || quota.status !== "ok" || quota.windows.length === 0
  const detail = quota?.detail ?? "quota unavailable"

  // The headline PREFERS the 5-hour window — "how much can I do right now" is the number that matters
  // most day-to-day. A tighter OTHER window (the weekly / Opus wall) only takes over the headline once it
  // drops into the warn zone; while everything's healthy the 5h number leads instead of falling back to
  // weekly. Falls back to the tightest window when there is no 5h window at all.
  const headline = unavailable ? undefined : pickHeadline(quota!.windows)
  const remaining = headline ? clampPct(100 - headline.usedPercent) : 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={unavailable ? `${providerLabel} quota: ${detail}` : `${providerLabel} quota: ${remaining}% remaining`}
          className="flex items-center gap-1.5 min-w-0 rounded outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          {unavailable ? (
            <span className="flex items-center gap-1 text-muted/45">
              <ProviderMark backend={backend} className="translate-y-0!" />
              <span className="tabular-nums">—</span>
            </span>
          ) : (
            <>
              <ProviderMark backend={backend} className="translate-y-0!" />
              <span className={`tabular-nums ${toneText(remaining)}`}>{remaining}%</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[min(15rem,calc(100vw-1.5rem))] p-3 text-[11px] leading-relaxed text-fg">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium">
          <ProviderMark backend={backend} />
          <span>{providerLabel}</span>
          {quota?.planType && <span className="text-muted/70">· {cap(quota.planType)} plan</span>}
        </div>
        {unavailable ? (
          <div className="text-muted/80">{detail}</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {quota!.windows.map((w) => {
              const left = clampPct(100 - w.usedPercent)
              const reset = resetText(w)
              return (
                <li key={w.key} className="flex items-center justify-between gap-3">
                  <span className="text-muted/80">{w.label}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className={toneText(left)}>{left}% left</span>
                    {reset && <span className="text-muted/55">resets {reset}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

// The remaining % at/below which a window is no longer "a good amount of quota" — it enters the warn
// zone. Shared by the headline picker (when to surface the tighter window) and the tone (when to drop
// the healthy green for the amber alarm), so the two stay in lockstep.
const HEALTHY_MIN = 25

// Which window's number leads the chip. Default to the 5-hour window — the immediate runway, the number
// that matters most day-to-day. Only when some window has fallen into the warn zone (≤ HEALTHY_MIN% left)
// do we surface the TIGHTEST window instead — that's the limit about to bite, and it earns the headline.
// With no 5h window at all we always show the tightest.
function pickHeadline(windows: QuotaWindow[]): QuotaWindow {
  const tightest = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
  const fiveHour = windows.find((w) => w.key === "5h")
  if (!fiveHour) return tightest
  return clampPct(100 - tightest.usedPercent) > HEALTHY_MIN ? fiveHour : tightest
}

// Severity by REMAINING: healthy (neutral light gray — no alarm), low (amber), critical (red). Color is
// spent only on states that want attention; a healthy quota is just information, so it reads as a calm
// neutral light gray rather than any hue (green, in any shade, fought the muted dark palette).
function toneText(remaining: number): string {
  if (remaining <= 8) return "text-red-400"
  if (remaining <= HEALTHY_MIN) return "text-accent"
  return "text-fg/70"
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

// A short reset label from a unix-seconds instant: "3:40pm" if within a day, else a weekday ("Thu").
// A reset in the PAST (stale data past its rollover) is suppressed rather than shown as a misleading
// already-elapsed clock time.
function resetText(w: QuotaWindow): string | null {
  if (!w.resetsAt) return null
  const ms = w.resetsAt * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const delta = ms - Date.now()
  if (delta <= 0) return null
  const withinDay = delta < 24 * 3600_000
  if (withinDay) {
    let h = d.getHours()
    const m = d.getMinutes()
    const ap = h >= 12 ? "pm" : "am"
    h = h % 12 || 12
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`
  }
  return d.toLocaleDateString(undefined, { weekday: "short" })
}
