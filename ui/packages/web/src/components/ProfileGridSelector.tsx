import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown, Loader2 } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  moveProfileGridSelection,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridDisplayLabel,
  profileGridEfforts,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridTemplateColumns,
  type ProfileGridGroup,
  type ProfileGridMoveKey,
  type ProfileGridSelection,
} from "../lib/profileGrid.ts"
import { registerOpenSelect } from "../lib/selectOverlay.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"

function effortLabel(effort: string): string {
  return effort === "xhigh" ? "X-high" : effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function ProfileGridSelector({
  groups,
  value,
  pending,
  onValueChange,
  placeholder,
  ariaLabel,
  menuAriaLabel = "Choose model and effort",
  title,
  disabled = false,
  compact = false,
  side = "bottom",
  className = "",
}: {
  groups: readonly ProfileGridGroup[]
  value?: Partial<ProfileGridSelection>
  pending?: Partial<ProfileGridSelection>
  onValueChange: (selection: ProfileGridSelection) => void
  placeholder?: string
  ariaLabel: string
  menuAriaLabel?: string
  title?: string
  disabled?: boolean
  compact?: boolean
  side?: "top" | "bottom"
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(open)
  const disabledRef = useRef(disabled)
  const unregisterOpenRef = useRef<(() => void) | undefined>(undefined)
  const cellRefs = useRef(new Map<string, HTMLElement>())
  const committedKeyRef = useRef<string | undefined>(undefined)
  const efforts = useMemo(() => profileGridEfforts(groups), [groups])
  const selections = useMemo(
    () => groups.flatMap((group) => group.options.flatMap((option) => option.efforts.map((effort) => ({
      provider: group.id,
      model: option.model,
      effort,
    })))),
    [groups],
  )
  const typography = compact ? PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS : PROFILE_GRID_TYPOGRAPHY_CLASS
  const triggerInteraction = disabled
    ? "cursor-not-allowed opacity-45"
    : "cursor-pointer transition-colors hover:border-border hover:bg-panel-2 hover:text-fg"
  const known = profileGridSelectionKnown(groups, value)
  const currentKey = known && value?.provider && value.model && value.effort
    ? profileGridSelectionKey(value as ProfileGridSelection)
    : undefined
  const pendingLabel = pending?.model || pending?.effort
    ? profileGridDisplayLabel(groups, pending, "Pending profile")
    : undefined
  openRef.current = open
  disabledRef.current = disabled

  function closeFromRegistry() {
    openRef.current = false
    unregisterOpenRef.current = undefined
    setOpen(false)
  }

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !openRef.current || disabledRef.current) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      unregisterOpenRef.current?.()
      closeFromRegistry()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])

  useLayoutEffect(() => {
    if (!disabled || !open) return
    unregisterOpenRef.current?.()
    closeFromRegistry()
  }, [disabled, open])

  useLayoutEffect(() => () => unregisterOpenRef.current?.(), [])

  // A pointer selection also reaches RadioGroup's onValueChange. Clear the one-event guard once
  // its controlled value has caught up, so keyboard activation remains available while one click
  // can never enqueue two preference writes.
  useLayoutEffect(() => {
    if (currentKey === committedKeyRef.current) committedKeyRef.current = undefined
  }, [currentKey])

  function commitSelection(selection: ProfileGridSelection) {
    const key = profileGridSelectionKey(selection)
    if (committedKeyRef.current === key) return
    committedKeyRef.current = key
    onValueChange(selection)
  }

  function handleCellKeyDown(event: KeyboardEvent<HTMLElement>, current: ProfileGridSelection) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const next = moveProfileGridSelection(groups, current, event.key as ProfileGridMoveKey)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    cellRefs.current.get(profileGridSelectionKey(next))?.focus()
  }

  return (
    <RadixMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        unregisterOpenRef.current?.()
        unregisterOpenRef.current = undefined
        openRef.current = next
        setOpen(next)
        if (next) unregisterOpenRef.current = registerOpenSelect(closeFromRegistry)
      }}
    >
      <RadixMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-invalid={!known && Boolean(value?.model || value?.effort) ? true : undefined}
          aria-description={pendingLabel ? `Pending ${pendingLabel}` : undefined}
          title={title}
          data-profile-known={known ? "true" : "false"}
          data-profile-pending={pendingLabel ? "true" : undefined}
          className={`profile-grid-trigger group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none data-[state=open]:border-border data-[state=open]:bg-panel-2 ${triggerInteraction} ${className} ${typography}`}
        >
          <span className={`profile-grid-value relative -top-px min-w-0 flex-1 truncate text-left ${typography}`}>
            {profileGridDisplayLabel(groups, value, placeholder)}
          </span>
          {pendingLabel && <Loader2 aria-hidden="true" size={compact ? 10 : 11} className="shrink-0 animate-spin text-muted/65" />}
          <ChevronDown aria-hidden="true" size={compact ? 11 : 13} className="shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          aria-label={menuAriaLabel}
          align="start"
          side={side}
          sideOffset={5}
          collisionPadding={8}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          className={`profile-grid-menu ${OPAQUE_PORTAL_SURFACE_CLASS} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-1rem)] overflow-auto rounded-lg p-1.5 ${typography}`}
        >
          {groups.map((group) => (
            <RadixMenu.Group key={group.id}>
              {group.label && (
                <RadixMenu.Label className="px-1.5 pb-1 pt-1 text-left font-medium tracking-[0.07em] text-muted/55 first:pt-0.5">
                  {group.label}
                </RadixMenu.Label>
              )}
              <RadixMenu.RadioGroup
                value={currentKey}
                // RadioGroup keeps keyboard selection semantic. Pointer activation also commits
                // from RadioItem's own select event below, before DropdownMenu tears this
                // controlled subtree down during dismissal.
                onValueChange={(key) => {
                  const selection = profileGridSelectionFromKey(groups, key)
                  if (selection) commitSelection(selection)
                }}
              >
                {group.options.map((option) => (
                  <div
                    key={option.model}
                    data-profile-grid-row={option.model}
                    className="grid min-w-max items-center gap-1 py-0.5"
                    style={{ gridTemplateColumns: profileGridTemplateColumns(efforts.length) }}
                  >
                    <span className={`profile-grid-model-label min-w-0 max-w-[9.5rem] truncate px-1.5 text-left text-muted ${typography}`} title={option.label}>
                      {option.label}
                    </span>
                    {efforts.map((effort) => {
                      if (!option.efforts.includes(effort)) return <span key={effort} aria-hidden="true" className="cursor-default" />
                      const selection = { provider: group.id, model: option.model, effort }
                      const key = profileGridSelectionKey(selection)
                      return (
                        <RadixMenu.RadioItem
                          key={effort}
                          value={key}
                          ref={(node) => {
                            if (node) cellRefs.current.set(key, node)
                            else cellRefs.current.delete(key)
                          }}
                          onKeyDown={(event) => handleCellKeyDown(event, selection)}
                          onSelect={(event) => {
                            // Radix dismisses a DropdownMenu as part of selection. Commit this
                            // pointer path first and own the close, otherwise a controlled menu
                            // can close with its RadioGroup callback already unmounted.
                            event.preventDefault()
                            commitSelection(selection)
                            unregisterOpenRef.current?.()
                            closeFromRegistry()
                          }}
                          aria-label={`${option.label}, ${effortLabel(effort)} effort`}
                          title={`${option.label} › ${effortLabel(effort)}`}
                          className={PROFILE_GRID_CELL_CLASS}
                        >
                          <span>{effortLabel(effort)}</span>
                        </RadixMenu.RadioItem>
                      )
                    })}
                  </div>
                ))}
              </RadixMenu.RadioGroup>
              {group !== groups.at(-1) && <RadixMenu.Separator className="my-1 h-px bg-border" />}
            </RadixMenu.Group>
          ))}
          {selections.length === 0 && (
            <div className="px-2 py-1.5 text-muted/60">No profiles available</div>
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
