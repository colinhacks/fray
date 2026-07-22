import { useId, useMemo, useState } from "react"
import { useSnapshot } from "valtio"
import { ChevronDown, Clock, Loader2 } from "lucide-react"
import type { ThreadView } from "@fray-ui/shared"
import { rpc } from "../api/rpc.ts"
import { futureSnoozedUntil } from "../groups.ts"
import {
  SNOOZE_PRESETS,
  defaultCustomSnoozeValue,
  formatSnoozeWake,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
  snoozePresetLabel,
  type SnoozePreset,
} from "../lib/snooze.ts"
import { showToast } from "../store.ts"
import { prefs } from "../lib/prefs.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"

export function SnoozeButton({ thread, onSnoozed }: { thread: ThreadView; onSnoozed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState(() => defaultCustomSnoozeValue())
  const [customError, setCustomError] = useState("")
  const customInputId = useId()
  const customFormId = useId()
  const snoozedUntil = futureSnoozedUntil(thread)
  const heldByConfirmedWait = thread.awaitingWaitConfirmed === true
  const selectedPreset = useSnapshot(prefs).snoozePreset
  const selectedLabel = snoozePresetLabel(selectedPreset)
  const minCustom = useMemo(() => localDateTimeInputValue(new Date(Date.now() + 60_000)), [customOpen])

  async function apply(until: string | null): Promise<void> {
    if (!thread.sessionId) {
      showToast("This session changed; refresh before snoozing")
      return
    }
    setBusy(true)
    try {
      await rpc.setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId, until })
      if (until) {
        showToast(`Snoozed · ${formatSnoozeWake(until)}`)
        onSnoozed?.()
      } else {
        showToast("Snooze cleared")
      }
      setCustomOpen(false)
      setCustomError("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snooze failed"
      showToast(message.slice(0, 100))
      setCustomError(message)
    } finally {
      setBusy(false)
    }
  }

  function applyPreset(preset: SnoozePreset) {
    prefs.snoozePreset = preset
    void apply(snoozePresetInstant(preset))
  }

  function openCustom() {
    setCustomValue(defaultCustomSnoozeValue())
    setCustomError("")
    setCustomOpen(true)
  }

  function submitCustom() {
    const parsed = parseLocalSnooze(customValue)
    if (!parsed.ok) {
      setCustomError(parsed.message)
      return
    }
    void apply(parsed.until)
  }

  return (
    <>
      <div className="inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60">
        <button
          type="button"
          disabled={busy}
          aria-label={snoozedUntil || heldByConfirmedWait ? "Wake thread now" : `Snooze thread for ${selectedLabel.toLowerCase()}`}
          title={snoozedUntil
            ? `Wake now · ${formatSnoozeWake(snoozedUntil)}`
            : heldByConfirmedWait ? "Wake now · cancel confirmed wait" : `Snooze for ${selectedLabel.toLowerCase()}`}
          onClick={() => void apply(snoozedUntil || heldByConfirmedWait ? null : snoozePresetInstant(selectedPreset))}
          className="flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[12px] font-medium text-fg/75 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {snoozedUntil || heldByConfirmedWait ? "Wake now" : `Snooze ${selectedLabel}`}
        </button>
        <span aria-hidden className="my-1 w-px bg-border" />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label="Snooze options"
              title={`Selected snooze: ${selectedLabel}`}
              className="flex min-w-0 items-center justify-center gap-1 rounded-r-md px-2 text-fg/75 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ChevronDown size={12} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {SNOOZE_PRESETS.map((preset) => (
              <MenuItem key={preset.value} onSelect={() => applyPreset(preset.value)} icon={<Clock size={12} />}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                  <span>{preset.label}</span>
                  <span className="text-[10px] text-muted/55">{preset.detail}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={openCustom}>Custom date &amp; time…</MenuItem>
            {(snoozedUntil || heldByConfirmedWait) && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => void apply(null)}>Wake now</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>

      <Dialog
        open={customOpen}
        onOpenChange={(open) => {
          if (!busy) setCustomOpen(open)
        }}
        title="Snooze thread"
        className="w-[360px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCustomOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={customFormId}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              Snooze
            </button>
          </>
        }
      >
        <form
          id={customFormId}
          className="flex flex-col gap-2.5 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            submitCustom()
          }}
        >
          <label htmlFor={customInputId} className="text-[11px] font-medium text-muted">
            Wake at this local time
          </label>
          <input
            id={customInputId}
            type="datetime-local"
            required
            autoFocus
            min={minCustom}
            value={customValue}
            onChange={(event) => {
              setCustomValue(event.target.value)
              setCustomError("")
            }}
            className="w-full rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-fg outline-none focus:border-accent"
          />
          <p className="min-h-4 text-[10.5px] text-muted/65">
            Stored as an exact instant; shown here in your browser’s local time zone.
          </p>
          {customError && <p role="alert" className="text-[11px] text-red-400">{customError}</p>}
        </form>
      </Dialog>
    </>
  )
}
