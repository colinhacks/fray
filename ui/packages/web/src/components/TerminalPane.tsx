import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import type { TermClientMsg } from "@fray-ui/shared"
import { queuedTerminalInputBytes, terminalCloseKind, terminalReconnectDelay } from "../lib/terminalConnection.ts"

// One xterm + WebSocket per selected thread. Remounts on slug change (keyed by
// the parent), so mount = attach and unmount = detach. The server kills only the
// tmux attach client on ws close, so reattach cheaply replays the screen state.
//
// RENDERER: the built-in DOM renderer, NOT @xterm/addon-webgl. The WebGL addon desynced its
// canvas backing store from xterm's dpr-scaled cell geometry whenever the effective
// devicePixelRatio wasn't the integer it captured at load (a non-100% browser zoom, or the
// window dragged between a Retina panel and an external 1× monitor): the backing store stayed at
// 2× while the render service computed geometry at 1×, so — WebGL's origin being bottom-left —
// every row got packed into the bottom-left quarter at half scale, leaving the top of the pane
// blank. That was the "terminal never worked" bug: the WS attaches, the bytes stream, and the
// xterm BUFFER is fully correct (proven), but the WebGL layer paints it into a quarter of the
// canvas. The DOM renderer positions rows with plain CSS and renders correctly at every dpr. It
// also drops the WebGL addon's teardown crash (its dispose reached back into an already-disposed
// render service and took the whole React tree down on a Terminal→Chat tab switch). For an
// agent's TUI the DOM renderer's throughput is more than enough; revisit WebGL only with an
// explicit devicePixelRatio-resync if profiling ever demands it.
export function TerminalPane({ slug }: { slug: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [connection, setConnection] = useState<"connecting" | "open" | "reconnecting" | "exited">("connecting")
  const [inputOverflow, setInputOverflow] = useState(false)

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
    // Mounting TerminalPane is explicit user intent (or a persisted explicit choice after a server
    // reload). Focus immediately; input typed before the socket opens is queued below, never dropped.
    term.focus()
    // NEVER fit against a degenerate host (a mid-layout zero-height mount produced NaN grid state
    // that corrupted xterm internals and crashed dispose, unmounting the whole workpane).
    const initialDims = fit.proposeDimensions()
    if (initialDims && Number.isFinite(initialDims.cols) && Number.isFinite(initialDims.rows) && initialDims.rows > 1) {
      fit.fit()
    }

    const proto = location.protocol === "https:" ? "wss" : "ws"
    const url = `${proto}://${location.host}/term/${slug}`
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let pageSuspended = false
    let connectedOnce = false
    let terminalExited = false
    let failures = 0
    const pendingInput: string[] = []
    let pendingInputBytes = 0

    const send = (m: TermClientMsg): boolean => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(m))
        return true
      } catch {
        return false
      }
    }

    const flushInput = () => {
      while (pendingInput.length > 0) {
        const d = pendingInput[0]
        if (!send({ t: "input", d })) return
        pendingInput.shift()
        pendingInputBytes -= new TextEncoder().encode(d).byteLength
      }
    }

    const connect = () => {
      if (disposed || pageSuspended || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      setConnection(connectedOnce ? "reconnecting" : "connecting")
      const sock = new WebSocket(url)
      ws = sock
      sock.binaryType = "arraybuffer"

      sock.onopen = () => {
        if (disposed || ws !== sock) return
        connectedOnce = true
        send({ t: "resize", cols: term.cols, rows: term.rows })
        flushInput()
      }
      sock.onmessage = (e) => {
        if (disposed || ws !== sock) return
        failures = 0
        setConnection("open")
        if (typeof e.data === "string") term.write(e.data)
        else term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onerror = () => {} // close owns recovery
      sock.onclose = (event) => {
        if (disposed || ws !== sock) return
        ws = null
        if (terminalCloseKind(event.code, event.reason) === "exited") {
          terminalExited = true
          setConnection("exited")
          return
        }
        failures++
        setConnection(connectedOnce ? "reconnecting" : "connecting")
        reconnectTimer = setTimeout(connect, terminalReconnectDelay(failures))
      }
    }

    connect()

    const dataSub = term.onData((d) => {
      if (send({ t: "input", d })) return
      const nextBytes = queuedTerminalInputBytes(pendingInputBytes, d)
      if (nextBytes === null) {
        setInputOverflow(true)
        return
      }
      pendingInput.push(d)
      pendingInputBytes = nextBytes
    })

    // Browser/app chords must not steal native TUI keys. Copy remains native only when xterm has a
    // selection; paste uses the browser's paste event so bracketed/multiline paste reaches xterm.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true
      const key = event.key.toLowerCase()
      if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && key === "v") return false
      if ((event.metaKey || event.ctrlKey) && key === "c" && term.hasSelection()) return false
      return true
    })

    const reconnectNow = () => {
      if (disposed || pageSuspended || terminalExited) return
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      connect()
    }
    window.addEventListener("online", reconnectNow)
    window.addEventListener("focus", reconnectNow)
    const onVisibility = () => {
      if (!document.hidden) reconnectNow()
    }
    document.addEventListener("visibilitychange", onVisibility)
    // React cleanup is not guaranteed during a hard navigation or BFCache transition. Close the
    // attach on pagehide so Cmd-R / direct navigation cannot strand a live tmux client; pages restored
    // from BFCache reconnect through the same path without losing the xterm buffer or pending input.
    const onPageHide = () => {
      pageSuspended = true
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      const sock = ws
      ws = null
      if (!sock) return
      sock.onopen = null
      sock.onmessage = null
      sock.onerror = null
      sock.onclose = null
      sock.close()
    }
    const onPageShow = () => {
      pageSuspended = false
      reconnectNow()
    }
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("pageshow", onPageShow)

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
      clearTimeout(reconnectTimer)
      disposed = true
      window.removeEventListener("online", reconnectNow)
      window.removeEventListener("focus", reconnectNow)
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pageshow", onPageShow)
      document.removeEventListener("visibilitychange", onVisibility)
      ro.disconnect()
      dataSub.dispose()
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
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
      {(connection !== "open" || inputOverflow) && (
        <div role="status" aria-live="polite" className="absolute bottom-0 inset-x-0 flex items-center justify-between px-3 py-1.5 bg-panel border-t border-border text-xs">
          <span className="text-muted">
            {inputOverflow
              ? "Offline input limit reached — additional input was not sent."
              : connection === "connecting"
                ? "Connecting to terminal…"
                : connection === "reconnecting"
                  ? "Terminal disconnected — reconnecting…"
                  : "Session exited."}
          </span>
          {connection === "exited" && (
            <button
              className="text-fg hover:underline"
              onClick={() => document.getElementById("followup-input")?.focus()}
            >
              Resume →
            </button>
          )}
        </div>
      )}
    </div>
  )
}
