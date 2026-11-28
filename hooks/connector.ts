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

/** The three calls the pane makes on its own; auto mode needs an allow rule for each. */
export const PANE_READS = ['list_factories', 'story_status', 'story_trail'] as const

const AUTO_MODE = `Auto mode refused the pane's own read: it was not made from a message of yours. Allow the pane's three read-only calls in ~/.claude/settings.json under permissions.allow (${PANE_READS.map(tool => `mcp__plugin_codebook_codebook__${tool}`).join(', ')}), then press Refresh. Changes still go through your prompt box.`

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

/** An answer the plugin could not read as JSON: said as such, never taken for an answer with nothing in it (#293). */
class Unreadable {
  /** `saved`: the file the engine put the whole answer in, when its note named one that could not be read either. */
  constructor(readonly text: string, readonly saved: string | null) {}
}

/**
 * Where the engine saved an answer too large to hand over (#293, found with Claude Code 2.1.332). An answer with
 * structuredContent reaches a plugin as one text block of JSON; over 50,000 characters the engine saves that JSON in
 * the session's `tool-results` folder and hands over this note with a short preview instead:
 *
 *   <persisted-output>
 *   Output too large (63.7KB). Full output saved to: /…/tool-results/toolu_plugin_….txt
 *
 * Only a file in a `tool-results` folder is read, whatever the note says: the note is text, and a connector could send
 * text that looks like it.
 */
export function savedAnswer(text: string): string | null {
  if (!text.startsWith('<persisted-output>')) return null
  const path = /saved to: *([^\r\n]+)/.exec(text)?.[1]?.trim()
  if (!path) return null
  const parts = path.replace(/\\/g, '/').split('/')
  return parts.length > 2 && parts.at(-2) === 'tool-results' && parts.at(-1) && !parts.includes('..') ? path : null
}

async function payload($: EngineInterface, result: McpToolResult): Promise<unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    // Not JSON: a saved answer, a cut one, or plain words.
  }
  const saved = savedAnswer(text)
  if (saved !== null) {
    try {
      return JSON.parse(await $.fs.read(saved))
    } catch {
      // The file is gone, too large to read or not JSON: say so below.
    }
  }
  return new Unreadable(text, saved)
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
    if (!isSignIn && /auto mode classifier/i.test(raw)) return { ok: false, code: 'AUTO_MODE', message: AUTO_MODE, isSignIn }
    return { ok: false, code: isSignIn ? 'SIGN_IN' : 'UNREACHABLE', message: isSignIn ? SIGN_IN : message, isSignIn }
  }
  const read = await payload($, result)
  const data = read as { error?: { code?: string; message?: string }; message?: string } | null
  if (result.isError) {
    const text = result.content.find(block => block.type === 'text')?.text
    return {
      ok: false,
      code: data?.error?.code ?? 'FAILED',
      message: data?.error?.message ?? text ?? 'CodeBook refused the call.',
      isSignIn: false,
    }
  }
  if (read instanceof Unreadable) {
    return {
      ok: false,
      code: 'UNREADABLE',
      message: read.saved !== null
        ? `CodeBook's answer to ${tool} could not be read: it was too large for Claude Code to hand to the plugin, and the file Claude Code saved it in (${read.saved}) could not be read as JSON.`
        : `CodeBook's answer to ${tool} could not be read: ${read.text.length.toLocaleString('en-US')} characters that are not JSON, starting "${read.text.slice(0, 80).replace(/\s+/g, ' ')}".`,
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
