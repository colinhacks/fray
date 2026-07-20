// Shared presentation/persistence boundary for credential syntax embedded in commands, URLs, errors,
// and provider metadata. Keep patterns bounded and syntax-led: ordinary prose containing words such as
// "token" or common short flags such as `-p` must remain readable.

export type CredentialReplacement = string | ((secretToken: string) => string)

export interface CredentialRedactionOptions {
  replacement?: CredentialReplacement
}

const DEFAULT_REPLACEMENT = "[redacted]"
const FLAG_NAME = String.raw`(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password|passwd|credential|private[-_]?key)`
const BOUNDARY = String.raw`(^|[\s;&|([{"'])`
const FLAG_TOKEN = String.raw`(?:(?:"|')?--?${FLAG_NAME}(?:"|')?)`
const FLAG_SEPARATOR = String.raw`(?:[ \t]*(?:=|:)[ \t]*|[ \t]*\\\r?\n[ \t]*|[ \t]+)`
const ESCAPED_SHELL_CHARACTER = String.raw`\\(?:\r?\n|[^\r\n])`
const QUOTED_OR_BARE_VALUE = String.raw`(?:"(?:${ESCAPED_SHELL_CHARACTER}|[^"\\]){0,4096}"|'[^']{0,4096}'|(?:${ESCAPED_SHELL_CHARACTER}|[^\\\s;&|"']){1,4096})`

const LONG_FLAG_RE = new RegExp(`${BOUNDARY}(${FLAG_TOKEN})(${FLAG_SEPARATOR})(${QUOTED_OR_BARE_VALUE})`, "gimu")
const USER_FLAG_RE = new RegExp(
  `${BOUNDARY}((?:(?:"|')?(?:-u|--user)(?:"|')?))(${FLAG_SEPARATOR})(${QUOTED_OR_BARE_VALUE})`,
  "gimu",
)
const ATTACHED_USER_FLAG_RE = new RegExp(`${BOUNDARY}(-u)(${QUOTED_OR_BARE_VALUE})`, "gimu")

// Literal and percent-encoded `:` delimiters are separate bounded expressions. Keeping username and
// password runs explicit avoids an unbounded `.*@` scan and does not mistake ordinary `repo@revision`
// text for URL credentials.
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@"':]{1,512})(:)([^\s/?#@"']{0,4096})@/giu
const URL_ENCODED_USERINFO_RE = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@"']{1,512}?)(%3a)([^\s/?#@"']{0,4096})@/giu

const EXACT_CREDENTIAL_NAME = /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password|passwd|credential|private[-_]?key|cookie)$/iu
const SUFFIX_CREDENTIAL_NAME = /(?:^|[._-])(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret|password|passwd|credential|private[-_]?key)$/iu
const ARGV_FIELD_NAME = /^(?:argv|args|arguments|command|cmd)$/iu
const EXACT_LONG_FLAG_RE = new RegExp(`^--?${FLAG_NAME}$`, "iu")
const CURL_EXECUTABLE_RE = /(?:^|[\\/])curl(?:\.exe)?$/iu

function replacement(options: CredentialRedactionOptions, secretToken: string): string {
  const configured = options.replacement ?? DEFAULT_REPLACEMENT
  return typeof configured === "function" ? configured(secretToken) : configured
}

function unquote(raw: string): string {
  return raw.length >= 2 && (raw[0] === "\"" || raw[0] === "'") && raw.at(-1) === raw[0]
    ? raw.slice(1, -1)
    : raw
}

function userInfoParts(raw: string): { username: string; delimiter: string; password: string } | null {
  const value = unquote(raw)
  const literal = value.indexOf(":")
  const encodedMatch = /%3a/iu.exec(value)
  const encoded = encodedMatch?.index ?? -1
  const index = literal === -1 ? encoded : encoded === -1 ? literal : Math.min(literal, encoded)
  if (index <= 0) return null
  const delimiter = value.slice(index, index + (index === encoded ? 3 : 1))
  return { username: value.slice(0, index), delimiter, password: value.slice(index + delimiter.length) }
}

function redactUserInfoToken(raw: string, options: CredentialRedactionOptions): string | null {
  const parts = userInfoParts(raw)
  if (!parts) return null
  return `${parts.username}${parts.delimiter}${replacement(options, parts.password)}`
}

function hasCurlCommandContext(source: string, offset: number): boolean {
  const bounded = source.slice(Math.max(0, offset - 1_024), offset)
  const separator = Math.max(
    bounded.lastIndexOf("\n"),
    bounded.lastIndexOf("\r"),
    bounded.lastIndexOf(";"),
    bounded.lastIndexOf("&"),
    bounded.lastIndexOf("|"),
  )
  const segment = bounded.slice(separator + 1)
  return segment.split(/[ \t]+/u).some((token) => CURL_EXECUTABLE_RE.test(unquote(token)))
}

/** Redact credential-bearing CLI flags and URL userinfo without rewriting benign command structure. */
export function redactCredentialSyntax(raw: string, options: CredentialRedactionOptions = {}): string {
  let value = raw
  value = value.replace(
    URL_USERINFO_RE,
    (_whole, scheme: string, username: string, delimiter: string, password: string) =>
      `${scheme}${username}${delimiter}${replacement(options, password)}@`,
  )
  value = value.replace(
    URL_ENCODED_USERINFO_RE,
    (_whole, scheme: string, username: string, delimiter: string, password: string) =>
      `${scheme}${username}${delimiter}${replacement(options, password)}@`,
  )
  value = value.replace(
    USER_FLAG_RE,
    (whole, boundary: string, flag: string, separator: string, userInfo: string, offset: number, source: string) => {
      if (unquote(flag).toLowerCase() === "-u" && !hasCurlCommandContext(source, offset)) return whole
      const safe = redactUserInfoToken(userInfo, options)
      return safe === null ? whole : `${boundary}${flag}${separator}${safe}`
    },
  )
  value = value.replace(
    ATTACHED_USER_FLAG_RE,
    (whole, boundary: string, flag: string, userInfo: string, offset: number, source: string) => {
      if (!hasCurlCommandContext(source, offset)) return whole
      const safe = redactUserInfoToken(userInfo, options)
      return safe === null ? whole : `${boundary}${flag}${safe}`
    },
  )
  value = value.replace(
    LONG_FLAG_RE,
    (_whole, boundary: string, flag: string, separator: string, secret: string) =>
      `${boundary}${flag}${separator}${replacement(options, secret)}`,
  )
  return value
}

export function isCredentialFieldName(name: string): boolean {
  // Normalize common JSON camelCase spellings (`apiKey`, `clientSecret`, `dbPassword`) before
  // applying the same delimiter-aware rules used for headers and environment-style names.
  const normalized = name.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1-$2")
  return EXACT_CREDENTIAL_NAME.test(normalized) || SUFFIX_CREDENTIAL_NAME.test(normalized)
}

function exactLongFlag(raw: string): boolean {
  return EXACT_LONG_FLAG_RE.test(unquote(raw))
}

function redactArgv(argv: readonly string[], options: CredentialRedactionOptions): string[] {
  const out = argv.map((part) => redactCredentialSyntax(part, options))
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (exactLongFlag(flag) && index + 1 < argv.length) {
      out[index + 1] = replacement(options, argv[index + 1]!)
      index++
      continue
    }
    const userFlag = unquote(flag).toLowerCase()
    const curlContext = argv.slice(0, index).some((part) => CURL_EXECUTABLE_RE.test(unquote(part)))
    if ((userFlag === "--user" || (userFlag === "-u" && curlContext)) && index + 1 < argv.length) {
      const safe = redactUserInfoToken(argv[index + 1]!, options)
      if (safe !== null) out[index + 1] = safe
      index++
    }
  }
  return out
}

/**
 * Copy a JSON-like tool payload while redacting strings at every depth. Sensitive object keys are
 * handled before serialization, and argv-like arrays retain their shape while pairing separated
 * flags with the following value. Cycles remain cycles so the caller's existing JSON failure path is
 * preserved instead of silently dropping data.
 */
export function redactCredentialStructure<T>(input: T, options: CredentialRedactionOptions = {}): T {
  const seen = new WeakMap<object, unknown>()
  const visit = (value: unknown, fieldName?: string, credentialContext = false): unknown => {
    const sensitive = credentialContext || (fieldName !== undefined && isCredentialFieldName(fieldName))
    if (typeof value === "string") {
      if (sensitive) return replacement(options, value)
      return redactCredentialSyntax(value, options)
    }
    if (!value || typeof value !== "object") return value
    const prior = seen.get(value)
    if (prior) return prior
    if (Array.isArray(value)) {
      const allStrings = value.every((entry) => typeof entry === "string")
      const target: unknown[] = []
      seen.set(value, target)
      const source = allStrings && (fieldName === undefined || ARGV_FIELD_NAME.test(fieldName))
        ? redactArgv(value as string[], options)
        : value
      for (const entry of source) target.push(visit(entry, undefined, sensitive))
      return target
    }
    const target: Record<string, unknown> = {}
    seen.set(value, target)
    for (const [key, entry] of Object.entries(value)) target[key] = visit(entry, key, sensitive)
    return target
  }
  return visit(input) as T
}
