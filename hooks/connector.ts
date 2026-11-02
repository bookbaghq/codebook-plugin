// Calls to the CodeBook connector (https://app.codebook.work/mcp) through the session's own MCP connection.
// The engine holds the OAuth sign-in; this module never sees a token.

import type { EngineInterface, McpToolResult } from 'claude-code'

/** The server's key in .mcp.json. */
export const SERVER_KEY = 'codebook'

export type Called<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; isSignIn: boolean }

const SIGN_IN =
  'Sign in to CodeBook first: open /mcp (in the desktop app, the connectors menu), pick "codebook" and choose Authenticate. You sign in with your Bookbag account. If /mcp is not there, run `claude mcp login plugin:codebook:codebook` in a terminal.'

let serverName: string | null = null

/** Connects the plugin's server (once) and answers the name `$.mcp.call` takes. */
async function server($: EngineInterface): Promise<Called<string>> {
  if (serverName !== null) return { ok: true, data: serverName }
  const connected = await $.mcp.connect(SERVER_KEY)
  if (connected.isConnected) {
    serverName = connected.server
    return { ok: true, data: serverName }
  }
  const isSignIn = connected.reason === 'auth'
  return {
    ok: false,
    code: isSignIn ? 'SIGN_IN' : connected.reason.toUpperCase(),
    message: isSignIn ? SIGN_IN : connected.message,
    isSignIn,
  }
}

function payload(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

/** Calls one connector tool. A refusal (NOT_FOUND, CONFLICT, ...) is a result, never a throw. */
export async function call<T>($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Called<T>> {
  const named = await server($)
  if (!named.ok) return named
  let result: McpToolResult
  try {
    result = await $.mcp.call(named.data, tool, args)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    // The engine's refusal names the call and the permission check; say it in the pane's words.
    const message = /classifier|permission|refused/i.test(raw)
      ? `Claude Code's permission check refused the call to CodeBook (${tool}). ${raw.replace(/^.*refused:\s*/, '').slice(0, 200)}`
      : raw
    const isSignIn = /\b401\b|unauthori[sz]ed|needs auth/i.test(raw)
    if (isSignIn) serverName = null
    return { ok: false, code: isSignIn ? 'SIGN_IN' : 'UNREACHABLE', message: isSignIn ? SIGN_IN : message, isSignIn }
  }
  const data = payload(result) as { error?: { code?: string; message?: string }; message?: string } | null
  if (result.isError) {
    const text = result.content.find(block => block.type === 'text')?.text
    return {
      ok: false,
      code: data?.error?.code ?? 'FAILED',
      message: data?.error?.message ?? text ?? 'CodeBook refused the call.',
      isSignIn: false,
    }
  }
  return { ok: true, data: data as T }
}

/** Splits `run Payments "Let customers refund"` into words, keeping quoted runs whole. */
export function words(text: string): string[] {
  const out: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|“([^”]*)”|(\S+)/g
  for (const match of text.matchAll(pattern)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '')
  }
  return out
}
