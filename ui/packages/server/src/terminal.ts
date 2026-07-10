import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, type WebSocket } from "ws"
import pty from "node-pty"
import { tmuxSessionName, type TermClientMsg } from "@fray-ui/shared"
import { socketName } from "./tmux.ts"

// One PTY per viewing client: each ws connection on /term/<slug> spawns its OWN
// `tmux -L <socket> attach-session -t fray-<slug>` through node-pty (tmux multiplexes the shared
// session across attaches). Killing the pty on ws close detaches THIS client only — the tmux
// session (and the agent) keeps running. Mirrors the M0 spike exactly. The socket is PER-PROJECT
// (tmux.socketName(), set at server init) so the attach hits the SAME server spawn() used.

const TERM_PATH = /^\/term\/([a-z0-9][a-z0-9-]*)$/

export function parseTermSlug(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0]
  const m = path.match(TERM_PATH)
  return m ? m[1] : null
}

export interface TerminalServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): void
}

// noServer mode: index.ts owns the single http server and routes upgrades here. Returns true
// iff the request was a /term/<slug> upgrade we claimed.
export function createTerminalServer(): TerminalServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const slug = parseTermSlug(req.url)
    if (!slug) {
      ws.close(1008, "bad term path")
      return
    }
    const term = pty.spawn("tmux", ["-L", socketName(), "attach-session", "-t", tmuxSessionName(slug)], {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      env: { ...process.env, TERM: "xterm-256color" },
    })

    term.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    term.onExit(({ exitCode }) => ws.readyState === ws.OPEN && ws.close(1000, `pty exit ${exitCode}`))

    ws.on("message", (raw) => {
      let msg: TermClientMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t === "input") term.write(msg.d)
      else if (msg.t === "resize") term.resize(msg.cols, msg.rows)
    })
    ws.on("close", () => term.kill()) // detaches this client, not the tmux session
  })

  return {
    handleUpgrade(req, socket, head) {
      if (parseTermSlug(req.url) === null) return false
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      return true
    },
    close: () => wss.close(),
  }
}
