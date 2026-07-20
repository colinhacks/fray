import { createElement, Fragment } from "react"
import type {
  InteractionCapability,
  InteractionCommandAction,
  InteractionFileChangeDisplay,
  InteractionPayload,
} from "@fray-ui/shared"

type ApprovalPayload = Extract<InteractionPayload, {
  kind: "command-approval" | "file-approval" | "permission-approval"
}>

const h = createElement

export function ApprovalDetails({ payload }: { payload: ApprovalPayload }) {
  if (payload.kind === "command-approval") {
    return h(Fragment, null,
      h("div", { className: "text-[12px] text-muted" }, "Command"),
      h("div", { className: "mt-0.5 break-words text-[13px] font-medium text-fg" }, payload.command.summary),
      payload.command.workingDirectoryLabel
        ? h("div", { className: "mt-1 break-all text-[10.5px] text-muted/70" }, "Working directory: ", payload.command.workingDirectoryLabel)
        : null,
      h(PreviewDisclosure, { label: "Redacted command preview", text: payload.command.preview }),
      payload.command.actions ? h(CommandActionList, { actions: payload.command.actions }) : null,
      payload.capabilities ? h(CapabilityList, { capabilities: payload.capabilities }) : null,
    )
  }
  if (payload.kind === "file-approval") {
    return h(Fragment, null,
      h("div", { className: "text-[12px] text-muted" }, fileOperationLabel(payload.operation)),
      h("div", { className: "mt-0.5 break-all font-mono-keep text-[12px] text-fg" }, payload.pathLabel),
      payload.destinationLabel
        ? h("div", { className: "mt-1 break-all font-mono-keep text-[11px] text-muted" }, "→ ", payload.destinationLabel)
        : null,
      payload.grantRootLabel
        ? h("section", { "aria-label": "Requested session write root", className: "mt-2.5 min-w-0 rounded-md border border-amber-400/35 bg-amber-500/[0.06] px-2.5 py-2" },
            h("h4", { className: "text-[10px] font-medium uppercase tracking-[0.07em] text-amber-100/80" }, "Requested session write root"),
            h("div", { className: "mt-1 min-w-0 break-all font-mono-keep text-[10.5px] text-fg/85" }, payload.grantRootLabel),
            payload.scopeLabel
              ? h("div", { className: "mt-1.5 whitespace-pre-wrap break-words text-[10.5px] leading-snug text-amber-100/75" }, payload.scopeLabel)
              : null,
          )
        : null,
      payload.diffPreview ? h(PreviewDisclosure, { label: "Plain-text diff preview", text: payload.diffPreview }) : null,
      payload.changes ? h(FileChangeList, { changes: payload.changes }) : null,
    )
  }
  return h(Fragment, null,
    h("div", { className: "text-[12px] text-muted" }, "Requested permission"),
    h("div", { className: "mt-0.5 break-all font-mono-keep text-[12px] font-medium text-fg" }, payload.permission),
    payload.resourceLabel
      ? h("div", { className: "mt-1 break-all text-[11px] text-muted" }, "Resource: ", payload.resourceLabel)
      : null,
    payload.workingDirectoryLabel
      ? h("div", { className: "mt-1 break-all text-[10.5px] text-muted/70" }, "Working directory: ", payload.workingDirectoryLabel)
      : null,
    payload.scopeLabel
      ? h("div", { className: "mt-2 whitespace-pre-wrap break-words text-[11px] leading-snug text-muted" }, payload.scopeLabel)
      : null,
    payload.capabilities ? h(CapabilityList, { capabilities: payload.capabilities }) : null,
  )
}

function PreviewDisclosure({ label, text }: { label: string; text: string }) {
  return h("details", {
    className: "mt-2.5 min-w-0 rounded-md border border-border/70 bg-bg/35",
    open: text.length < 1_200,
  },
  h("summary", {
    className: "cursor-pointer px-2.5 py-2 text-[10.5px] text-muted outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/50",
  }, label),
  h("pre", {
    className: "max-h-64 max-w-full min-w-0 overflow-auto border-t border-border/60 px-2.5 py-2 whitespace-pre-wrap break-words font-mono-keep text-[11px] leading-relaxed text-fg/80",
  }, text))
}

function CommandActionList({ actions }: { actions: readonly InteractionCommandAction[] }) {
  return h("section", { "aria-label": "Parsed command actions", className: "mt-3 min-w-0" },
    h("h4", { className: "text-[10px] font-medium uppercase tracking-[0.07em] text-muted/75" }, "Parsed actions"),
    h("ul", { className: "mt-1.5 flex min-w-0 flex-col gap-2" }, actions.map((action, index) =>
      h("li", { key: index, className: "min-w-0 rounded-md border border-border/65 bg-bg/25 px-2.5 py-2" },
        h("div", { className: "text-[11px] font-medium text-fg/90" }, commandActionLabel(action.kind)),
        action.resourceLabel
          ? h("div", { className: "mt-0.5 break-all font-mono-keep text-[10.5px] text-muted" }, action.resourceLabel)
          : null,
        action.queryLabel
          ? h("div", { className: "mt-0.5 break-all text-[10.5px] text-muted" }, "Query: ", action.queryLabel)
          : null,
        h(PreviewDisclosure, { label: `${commandActionLabel(action.kind)} command detail`, text: action.commandPreview }),
      )),
    ),
  )
}

function FileChangeList({ changes }: { changes: readonly InteractionFileChangeDisplay[] }) {
  return h("section", { "aria-label": "Affected file changes", className: "mt-3 min-w-0" },
    h("h4", { className: "text-[10px] font-medium uppercase tracking-[0.07em] text-muted/75" }, "Affected changes"),
    h("ol", { className: "mt-1.5 flex min-w-0 flex-col gap-2" }, changes.map((change, index) =>
      h("li", { key: index, className: "min-w-0 rounded-md border border-border/65 bg-bg/25 px-2.5 py-2" },
        h("div", { className: "text-[11px] font-medium text-fg/90" }, fileOperationLabel(change.operation)),
        h("div", { className: "mt-0.5 break-all font-mono-keep text-[10.5px] text-fg/80" }, change.pathLabel),
        change.destinationLabel
          ? h("div", { className: "mt-0.5 min-w-0 break-all font-mono-keep text-[10.5px] text-muted" }, "→ ", change.destinationLabel)
          : null,
        change.diffPreview
          ? h(PreviewDisclosure, { label: `${fileOperationLabel(change.operation)} plain-text diff`, text: change.diffPreview })
          : null,
      )),
    ),
  )
}

function CapabilityList({ capabilities }: { capabilities: readonly InteractionCapability[] }) {
  return h("section", { "aria-label": "Requested capabilities", className: "mt-3 min-w-0" },
    h("h4", { className: "text-[10px] font-medium uppercase tracking-[0.07em] text-muted/75" }, "Requested capabilities"),
    h("ul", { className: "mt-1.5 flex min-w-0 flex-col gap-2" }, capabilities.map((capability, index) =>
      h("li", { key: index, className: "min-w-0 rounded-md border border-border/65 bg-bg/25 px-2.5 py-2" },
        h(CapabilityDetail, { capability }),
      )),
    ),
  )
}

function CapabilityDetail({ capability }: { capability: InteractionCapability }) {
  if (capability.kind === "network") {
    const state = capability.enabled === true
      ? "Enable network access"
      : capability.enabled === false
        ? "Disable network access"
        : "Network access request"
    return h(Fragment, null,
      h("div", { className: "text-[11px] font-medium text-fg/90" }, state),
      capability.hosts.length > 0 ? h(PlainResourceList, { label: "Hosts and protocols", values: capability.hosts }) : null,
    )
  }
  if (capability.kind === "filesystem") {
    const access = capability.access === "read"
      ? "Read filesystem paths"
      : capability.access === "write"
        ? "Write filesystem paths"
        : "Deny filesystem paths"
    return h(Fragment, null,
      h("div", { className: "text-[11px] font-medium text-fg/90" }, access),
      h(PlainResourceList, { label: "Paths", values: capability.resources }),
    )
  }
  if (capability.kind === "glob-scan") {
    return h(Fragment, null,
      h("div", { className: "text-[11px] font-medium text-fg/90" }, "Filesystem glob scanning"),
      h("div", { className: "mt-0.5 text-[10.5px] text-muted" }, "Maximum depth: ", String(capability.depth)),
    )
  }
  if (capability.kind === "exec-policy") {
    return h(Fragment, null,
      h("div", { className: "text-[11px] font-medium text-fg/90" }, "Future command policy amendment"),
      h(PlainResourceList, { label: "Command prefix tokens", values: capability.prefixes }),
    )
  }
  return h(Fragment, null,
    h("div", { className: "text-[11px] font-medium text-fg/90" }, capability.access === "allow" ? "Allow future network hosts" : "Deny future network hosts"),
    h(PlainResourceList, { label: "Hosts", values: capability.hosts }),
  )
}

function PlainResourceList({ label, values }: { label: string; values: readonly string[] }) {
  return h("div", { className: "mt-1 min-w-0" },
    h("div", { className: "sr-only" }, label),
    h("ul", { "aria-label": label, className: "flex min-w-0 flex-col gap-0.5" }, values.map((value, index) =>
      h("li", { key: index, className: "min-w-0 break-all font-mono-keep text-[10.5px] text-muted" }, value),
    )),
  )
}

function commandActionLabel(kind: InteractionCommandAction["kind"]): string {
  switch (kind) {
    case "read": return "Read a file"
    case "list-files": return "List files"
    case "search": return "Search files"
    case "unknown": return "Unclassified command"
  }
}

export function fileOperationLabel(
  operation: Extract<InteractionPayload, { kind: "file-approval" }>["operation"] | InteractionFileChangeDisplay["operation"],
): string {
  switch (operation) {
    case "read": return "Read file"
    case "create": return "Create file"
    case "write": return "Modify file"
    case "move": return "Move file"
    case "delete": return "Delete file"
    case "execute": return "Execute file"
    case "other": return "File operation"
  }
}

export type { ApprovalPayload }
