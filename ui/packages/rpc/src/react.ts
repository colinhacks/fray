import {
  useQuery,
  useMutation,
  type UseQueryResult,
  type UseMutationResult,
  type UseQueryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query"
import type { Router, AnyProcedure, QueryDef, MutationDef } from "./server.ts"
import type { ClientFromRouter, ProcedureMap } from "./client.ts"
import type { z } from "zod"

// ---- Type-level: infer hook shape from router ----

type InferInput<P> = P extends { input: infer I }
  ? I extends z.ZodType ? z.infer<I> : void
  : void

type InferOutput<P> = P extends QueryDef<any, infer O>
  ? z.infer<O>
  : P extends MutationDef<any, infer O>
    ? O extends z.ZodType ? z.infer<O> : void
    : never

type Cap<S extends string> = S extends `${infer F}${infer R}` ? `${Uppercase<F>}${R}` : S

// Use a permissive hook type for now — accepts any input, returns typed output
type AnyQueryHook = (input?: any, opts?: any) => UseQueryResult<any>
type AnyMutationHook = (opts?: any) => UseMutationResult<any, Error, any>

type HooksFromRouter<R extends Router> = {
  [K in keyof R as `use${Cap<K & string>}`]: R[K] extends QueryDef<any, any>
    ? AnyQueryHook
    : R[K] extends MutationDef<any, any>
      ? AnyMutationHook
      : never
}

// ---- Runtime ----

export function createHooks<R extends Router>(
  client: ClientFromRouter<R>,
  procedureMap: ProcedureMap,
): HooksFromRouter<R> {
  return new Proxy({} as HooksFromRouter<R>, {
    get(_target, hookName: string) {
      if (!hookName.startsWith("use")) return undefined
      const procName = hookName[3]!.toLowerCase() + hookName.slice(4)
      const procType = procedureMap[procName]
      const clientFn = (client as any)[procName]
      if (!clientFn || !procType) return undefined

      if (procType === "mutation") {
        return (opts?: any) =>
          // eslint-disable-next-line react-hooks/rules-of-hooks
          useMutation({
            mutationFn: (input: unknown) => clientFn(input),
            ...opts,
          })
      }

      if (procType === "query") {
        // Always treat first arg as input, second as opts
        return (input?: unknown, opts?: any) => {
          // eslint-disable-next-line react-hooks/rules-of-hooks
          return useQuery({
            queryKey: input !== undefined ? [procName, input] : [procName],
            queryFn: () => clientFn(input),
            ...opts,
          })
        }
      }

      // Streams are not exposed as hooks (consumed via Valtio)
      return undefined
    },
  })
}
