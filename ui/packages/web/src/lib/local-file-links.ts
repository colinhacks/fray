import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"

// One delegated listener covers every sanitized markdown surface (chat, scratchpad, plans, and
// drawers). It never follows file:// or an accidental same-origin pathname: only explicit data
// attributes emitted by markdown.ts reach the server's canonical-path allowlist gate.
export function installLocalFileLinkInterceptor(): () => void {
  const handler = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return
    const source = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-local-path]") : null
    const path = source?.dataset.localPath
    if (!source || !path) return
    event.preventDefault()
    event.stopPropagation()
    void open(path, source.dataset.localImage === "true")
  }
  document.addEventListener("click", handler)
  return () => document.removeEventListener("click", handler)
}

async function open(path: string, image: boolean) {
  try {
    const result = await rpc.openLocalFile({ path, ...(image ? { image: true } : {}) })
    if (result.action === "copy") {
      await navigator.clipboard.writeText(result.path)
      showToast("Copied local path")
    }
  } catch (error) {
    showToast(`Could not open local file: ${(error as Error).message.slice(0, 100)}`)
  }
}
