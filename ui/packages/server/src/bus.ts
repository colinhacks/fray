import type { ServerEvent } from "@fray-ui/shared"

// The single fan-out point: board rebuilds + notifications publish here, the /events
// SSE endpoint is the only subscriber (one listener per connected client). Kept a plain
// listener set (not node:EventEmitter) so a throwing listener can't break the others.
type Listener = (event: ServerEvent) => void

export class Bus {
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(event: ServerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // one bad subscriber must not starve the rest
      }
    }
  }
}

// A minimal generic fan-out — the INTERNAL (non-wire) signal sibling to Bus. Used to carry the tailer's
// per-tick "these thread transcripts advanced" batch from the tailer to the /ws transcript producer,
// without polluting the wire ServerEvent union. Same throwing-listener isolation as Bus.
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>()

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value)
      } catch {
        // one bad subscriber must not starve the rest
      }
    }
  }
}
