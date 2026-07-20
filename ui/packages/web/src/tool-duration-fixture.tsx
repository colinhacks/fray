import { createRoot } from "react-dom/client"
import { ToolStatusMeta } from "./components/ChatView.tsx"
import { ToolDisclosureHeader } from "./components/ToolDisclosureHeader.ts"
import "./styles.css"
import "./lib/diff/diff.css"

function Card({ expanded, status, name = "Bash", summary = "Re-run pnpm probe synchronously with exit code", input = "pnpm probe --sync --exit-code" }: { expanded: boolean; status: "completed" | "cancelled" | "pending"; name?: string; summary?: string; input?: string }) {
  return (
    <div className="fray-bash">
      <ToolDisclosureHeader
        className="fray-bash-header"
        controls={`body-${status}-${expanded}`}
        expanded={expanded}
        label={`${expanded ? "Collapse" : "Expand"} ${name}: ${summary}`}
        onToggle={() => {}}
        meta={<ToolStatusMeta status={status} durationMs={128 * 60_000} />}
      >
        <span className="petite-caps fray-bash-label shrink-0">{name}</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>
      </ToolDisclosureHeader>
      {expanded && <pre id={`body-${status}-${expanded}`} className="fray-bash-body">{input}</pre>}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 px-4 py-8 text-fg">
    <h1 className="text-lg font-semibold">Tool duration and optical-alignment fixture</h1>
    <Card expanded={false} status="completed" />
    <Card expanded status="cancelled" />
    <Card expanded={false} status="pending" />
    <Card expanded status="completed" name="Interrupt process" summary="session 35985" input={"Ctrl-C\n\n^C"} />
  </main>,
)
