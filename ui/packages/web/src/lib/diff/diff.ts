// Self-contained line diff (no `diff` npm dependency). Trims the common prefix/suffix, then runs a
// classic LCS DP over the differing middle. Inputs are small (transcript edits are capped at a few
// KB), so the O(n·m) table is cheap; the prefix/suffix trim keeps the common case near-linear.

export type OpType = "eq" | "del" | "add"

export interface DiffOp {
  type: OpType
  a: number | null // 0-based index into the old lines (eq/del)
  b: number | null // 0-based index into the new lines (eq/add)
}

function lcsOps(a: string[], b: string[], off: number): DiffOp[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", a: off + i, b: off + j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", a: off + i, b: null })
      i++
    } else {
      ops.push({ type: "add", a: null, b: off + j })
      j++
    }
  }
  while (i < n) ops.push({ type: "del", a: off + i++, b: null })
  while (j < m) ops.push({ type: "add", a: null, b: off + j++ })
  return ops
}

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const N = a.length
  const M = b.length

  let s = 0
  while (s < N && s < M && a[s] === b[s]) s++

  let e = 0
  while (e < N - s && e < M - s && a[N - 1 - e] === b[M - 1 - e]) e++

  const ops: DiffOp[] = []
  for (let i = 0; i < s; i++) ops.push({ type: "eq", a: i, b: i })
  ops.push(...lcsOps(a.slice(s, N - e), b.slice(s, M - e), s))
  for (let i = 0; i < e; i++) ops.push({ type: "eq", a: N - e + i, b: M - e + i })
  return ops
}
