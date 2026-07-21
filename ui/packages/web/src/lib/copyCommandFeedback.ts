export const COPY_COMMAND_FEEDBACK_MS = 1500

interface FeedbackClock {
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(timer: number): void
}

export function createCopyCommandFeedback(
  setCopied: (copied: boolean) => void,
  clock: FeedbackClock,
) {
  let generation = 0
  let resetTimer: number | undefined

  function clearResetTimer() {
    if (resetTimer === undefined) return
    clock.clearTimeout(resetTimer)
    resetTimer = undefined
  }

  return {
    begin(): number {
      const current = ++generation
      setCopied(true)
      clearResetTimer()
      resetTimer = clock.setTimeout(() => {
        if (current === generation) setCopied(false)
        resetTimer = undefined
      }, COPY_COMMAND_FEEDBACK_MS)
      return current
    },
    fail(failedGeneration: number) {
      if (failedGeneration !== generation) return
      clearResetTimer()
      setCopied(false)
    },
    dispose() {
      generation++
      clearResetTimer()
    },
  }
}
