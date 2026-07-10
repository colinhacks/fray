import type { Router, AnyProcedure, QueryDef, MutationDef, StreamDef } from "./server.ts"
import type { z } from "zod"

// ---- Type-level: infer client shape from router ----

type InferInput<P> = P extends { input: infer I }
  ? I extends z.ZodType
    ? z.infer<I>
    : void
  : void

type InferOutput<P> = P extends QueryDef<any, infer O>
  ? z.infer<O>
  : P extends MutationDef<any, infer O>
    ? O extends z.ZodType
      ? z.infer<O>
      : void
    : never

type InferEvent<P> = P extends StreamDef<any, infer E> ? z.infer<E> : never

type ClientProcedure<P extends AnyProcedure> = P extends StreamDef<any, any>
  ? InferInput<P> extends void
    ? () => AsyncGenerator<InferEvent<P>>
    : (input: InferInput<P>) => AsyncGenerator<InferEvent<P>>
  : InferInput<P> extends void
    ? () => Promise<InferOutput<P>>
    : (input: InferInput<P>) => Promise<InferOutput<P>>

export type ClientFromRouter<R extends Router> = {
  [K in keyof R]: ClientProcedure<R[K]>
}

// ---- Runtime: procedure type map ----

// The server passes a map of { procedureName: "query" | "mutation" | "stream" }
// so the client knows how to call each procedure.
export type ProcedureMap = Record<string, "query" | "mutation" | "stream">

export function createClient<R extends Router>(
  baseUrl: string,
  procedureMap: ProcedureMap,
): ClientFromRouter<R> {
  return new Proxy({} as ClientFromRouter<R>, {
    get(_target, prop: string) {
      const procType = procedureMap[prop]
      if (!procType) return undefined

      if (procType === "stream") {
        // Return a function that returns an async generator
        return (input?: unknown) => streamCall(baseUrl, prop, input)
      }

      // Query or mutation → return a function that returns a promise
      return async (input?: unknown) => {
        if (procType === "query") {
          const url = new URL(`${baseUrl}/${prop}`, getOrigin())
          if (input !== undefined) {
            url.searchParams.set("input", JSON.stringify(input))
          }
          const res = await fetch(url.toString())
          const json = await res.json()
          if (!res.ok) throw new RPCError(json.error, res.status)
          return json.result
        }

        // Mutation
        const url = new URL(`${baseUrl}/${prop}`, getOrigin())
        const res = await fetch(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
        const json = await res.json()
        if (!res.ok) throw new RPCError(json.error, res.status)
        return json.result
      }
    },
  })
}

async function* streamCall(baseUrl: string, name: string, input?: unknown) {
  const url = new URL(`${baseUrl}/${name}`, getOrigin())
  if (input !== undefined) {
    url.searchParams.set("input", JSON.stringify(input))
  }
  const res = await fetch(url.toString())
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new RPCError(json.error ?? "Stream error", res.status)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()!
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        yield JSON.parse(line.slice(6))
      }
    }
  }
}

function getOrigin() {
  if (typeof globalThis.location !== "undefined") return globalThis.location.origin
  return "http://localhost"
}

export class RPCError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = "RPCError"
  }
}
