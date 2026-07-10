import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import type { TermClientMsg } from "@fray-ui/shared"

// One xterm + WebSocket per selected thread. Remounts on slug change (keyed by
// the parent), so mount = attach and unmount = detach. The server kills only the
// tmux attach client on ws close, so reattach cheaply replays the screen state.
export function TerminalPane({ slug }: { slug: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "Menlo, ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#0d0e10", foreground: "#e6e7e9" },
      scrollback: 10000,
      allowProposedApi: true,
      cursorBlink: true,
    })
    termRef.current = term
    // No auto-focus on attach (that would swallow keys the user meant elsewhere) — clicking the
    // terminal focuses it natively; there is no focus machine anymore.
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      const webgl = new WebglAddon()
      term.loadAddon(webgl)
      webglRef.current = webgl
    } catch (e) {
      console.warn("webgl unavailable", e)
    }
    // NEVER fit against a degenerate host (a mid-layout zero-height mount produced NaN grid state
    // that corrupted xterm internals and crashed dispose, unmounting the whole workpane).
    const initialDims = fit.proposeDimensions()
    if (initialDims && Number.isFinite(initialDims.cols) && Number.isFinite(initialDims.rows) && initialDims.rows > 1) {
      fit.fit()
    }

    const proto = location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${proto}://${location.host}/term/${slug}`)
    ws.binaryType = "arraybuffer"
    const send = (m: TermClientMsg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m))

    // Deliberately NO focus on open: the nav owns the keyboard until the user steps in (→ / ⌘T /
    // click). Focusing here would swallow arrow keys the moment a thread is selected.
    ws.onopen = () => {
      setExited(false)
      send({ t: "resize", cols: term.cols, rows: term.rows })
    }
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data)
      else term.write(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => setExited(true)

    const dataSub = term.onData((d) => send({ t: "input", d }))

    // Resize ONLY when the grid actually changes. The naive version (fit + send on every
    // ResizeObserver tick) fed a repaint storm: each ~1s board push re-rendered the layout, the
    // observer fired on no-op layout passes, every fit() forced an xterm reflow, and every resize
    // message forced tmux to redraw the whole pane ("random line-shifting repaints"). Now we
    // debounce a beat, compute the PROPOSED grid, and touch xterm/tmux only on a real cols/rows
    // change.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const dims = fit.proposeDimensions()
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.rows <= 1) return
        if (dims.cols === term.cols && dims.rows === term.rows) return
        fit.fit()
        send({ t: "resize", cols: term.cols, rows: term.rows })
      }, 120)
    })
    ro.observe(host)

    return () => {
      clearTimeout(resizeTimer)
      ro.disconnect()
      dataSub.dispose()
      ws.close()
      // Dispose the WebGL addon BEFORE the terminal. term.dispose() DOES dispose loaded addons,
      // but @xterm/addon-webgl's teardown reaches back into the terminal's render service — once the
      // terminal is torn down first that read lands on `undefined`, throwing "Cannot read properties
      // of undefined (reading '_isDisposed')" and taking the whole React tree down on a Terminal→Chat
      // tab switch. Disposing the addon first (while the terminal is still intact), guarded, and
      // clearing the ref so term.dispose() below can't double-dispose it, closes that path.
      try {
        webglRef.current?.dispose()
      } catch (e) {
        console.warn("webgl addon dispose failed", e)
      }
      webglRef.current = null
      // dispose() can throw if xterm internals were corrupted (e.g. a zero-dim fit) — a cleanup
      // throw would take the whole React tree down with it, which is far worse than a leak.
      try {
        term.dispose()
      } catch (e) {
        console.warn("xterm dispose failed", e)
      }
    }
  }, [slug])

  return (
    <div className="relative flex-1 min-h-0 bg-bg">
      <div ref={hostRef} className="absolute inset-0 p-2" />
      {exited && (
        <div className="absolute bottom-0 inset-x-0 flex items-center justify-between px-3 py-1.5 bg-panel border-t border-border text-xs">
          <span className="text-muted">Session exited.</span>
          <button
            className="text-fg hover:underline"
            onClick={() => document.getElementById("followup-input")?.focus()}
          >
            Resume →
          </button>
        </div>
      )}
    </div>
  )
}
