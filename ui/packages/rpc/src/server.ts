import type { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

// ---- Procedure definition helpers ----

export type QueryDef<TInput extends z.ZodType | undefined, TOutput extends z.ZodType> = {
  _tag: "query"
  input?: TInput
  output: TOutput
  handler: (
    args: TInput extends z.ZodType ? { input: z.infer<TInput> } : {}
  ) => Promise<z.infer<TOutput>>
}

export type MutationDef<TInput extends z.ZodType, TOutput extends z.ZodType | undefined> = {
  _tag: "mutation"
  input: TInput
  output?: TOutput
  handler: (args: {
    input: z.infer<TInput>
  }) => Promise<TOutput extends z.ZodType ? z.infer<TOutput> : void>
}

export type StreamDef<TInput extends z.ZodType | undefined, TEvent extends z.ZodType> = {
  _tag: "stream"
  input?: TInput
  event: TEvent
  handler: (
    args: TInput extends z.ZodType ? { input: z.infer<TInput> } : {}
  ) => AsyncGenerator<z.infer<TEvent>>
}

export function query<
  TInput extends z.ZodType | undefined,
  TOutput extends z.ZodType,
>(
  def: Omit<QueryDef<TInput, TOutput>, "_tag">
): QueryDef<TInput, TOutput> {
  return { ...def, _tag: "query" }
}

export function mutation<
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined = undefined,
>(
  def: Omit<MutationDef<TInput, TOutput>, "_tag">
): MutationDef<TInput, TOutput> {
  return { ...def, _tag: "mutation" }
}

export function stream<
  TInput extends z.ZodType | undefined,
  TEvent extends z.ZodType,
>(
  def: Omit<StreamDef<TInput, TEvent>, "_tag">
): StreamDef<TInput, TEvent> {
  return { ...def, _tag: "stream" }
}

// ---- Router type ----

export type AnyProcedure = QueryDef<any, any> | MutationDef<any, any> | StreamDef<any, any>
export type Router = Record<string, AnyProcedure>

// ---- Extract procedure map (shared with client) ----

export function extractProcedureMap(router: Router): Record<string, "query" | "mutation" | "stream"> {
  const map: Record<string, "query" | "mutation" | "stream"> = {}
  for (const [name, proc] of Object.entries(router)) {
    map[name] = proc._tag
  }
  return map
}

// ---- Mount router onto Hono ----

export function mountRouter(app: Hono, prefix: string, router: Router) {
  // Serve the procedure map so the client can self-configure
  const procMap = extractProcedureMap(router)
  app.get(`${prefix}/__procedures`, (c) => c.json(procMap))

  for (const [name, proc] of Object.entries(router)) {
    const path = `${prefix}/${name}`

    if (proc._tag === "query") {
      app.get(path, async (c) => {
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = JSON.parse(decodeURIComponent(rawInput))
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: parsed.error.format() }, 400)
          }
          input = parsed.data
        }
        try {
          const result = await proc.handler(input !== undefined ? { input } : {} as any)
          return c.json({ result })
        } catch (err: any) {
          return c.json({ error: err.message ?? "Internal server error" }, 500)
        }
      })
    } else if (proc._tag === "mutation") {
      app.post(path, async (c) => {
        let input: unknown
        const contentType = c.req.header("content-type")
        if (contentType?.includes("application/json")) {
          input = await c.req.json()
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: parsed.error.format() }, 400)
          }
          input = parsed.data
        }
        try {
          const result = await proc.handler({ input } as any)
          return c.json({ result: result ?? null })
        } catch (err: any) {
          return c.json({ error: err.message ?? "Internal server error" }, 500)
        }
      })
    } else if (proc._tag === "stream") {
      app.get(path, async (c) => {
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = JSON.parse(decodeURIComponent(rawInput))
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: parsed.error.format() }, 400)
          }
          input = parsed.data
        }
        return streamSSE(c, async (sseStream) => {
          let id = 0
          const gen = proc.handler(input !== undefined ? { input } : {} as any)
          for await (const event of gen) {
            await sseStream.writeSSE({
              data: JSON.stringify(event),
              id: String(id++),
            })
          }
        })
      })
    }
  }
}
