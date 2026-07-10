// Shown when .fray/ doesn't exist in this repo — the app has nothing to watch.
export function NoFray({ dir }: { dir: string }) {
  return (
    <div className="h-screen flex items-center justify-center bg-bg text-fg">
      <div className="max-w-md text-center px-6">
        <h1 className="text-lg font-semibold mb-2">No fray board here</h1>
        <p className="text-sm text-muted mb-1">
          This repo has no <code className="text-fg">.fray/</code> directory yet — dispatch a first thread and it will be
          created.
        </p>
        <p className="text-xs text-muted/70 break-all">{dir}</p>
      </div>
    </div>
  )
}
