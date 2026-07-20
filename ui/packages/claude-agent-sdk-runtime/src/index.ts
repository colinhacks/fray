// This package is the dependency-resolution membrane for the Claude Agent SDK. The SDK's Zod 4
// peer stays here while the existing server continues using Zod 3. No schema instance crosses the
// boundary: the server adapter imports only the query function and SDK TypeScript declarations.

export { query } from "@anthropic-ai/claude-agent-sdk"
export type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionResult,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
