// The factory's code on this computer (phase 2): each repository's checkout folder, as CodeBook answers it in
// `manager_brief.you.local_code`, `set_local_checkout` and a Run here claim's `run_here…local`. /factory status shows
// each one and checks it here (the folder is a git checkout whose origin is that repository); the manager's step 0 and
// the factory-worker do the full check (git connected, fetch) before any work.

import type { EngineInterface } from 'claude-code'

import type { CodebookCheckout } from '../types'
import { repoOf } from './guard'

type WireLocal = { path?: string | null; mode?: string | null; checkout_path?: string | null } | null
type WireRepository = {
  repository?: string | number
  name?: string
  full_name?: string
  clone_url?: string
  html_url?: string
  url?: string
  path?: string | null
  mode?: string | null
  checkout_path?: string | null
  local?: WireLocal
}

function one(repo: WireRepository, local: WireLocal | undefined): CodebookCheckout | null {
  const name = repoOf(repo.html_url ?? '') ?? repoOf(repo.clone_url ?? '') ?? repoOf(repo.full_name ?? repo.name ?? '') ?? repoOf(repo.url ?? '')
  if (name === null) return null
  const where = local === undefined ? repo : (local ?? {})
  const mode = where.mode === 'existing' || where.mode === 'clone_into' ? where.mode : null
  return { repository: name, checkoutPath: where.checkout_path ?? null, mode }
}

/**
 * The checkouts a connector answer names: `manager_brief` (`you.local_code`), `set_local_checkout` (the same
 * `local_code`, bare or under `local_code`/`you`), or a claim's brief (`run_here.repository.local`, or each of
 * `run_here.repositories[].local`). `null` when the answer names none (an older CodeBook, or another tool).
 */
export function checkoutsOf(tool: string, data: unknown): CodebookCheckout[] | null {
  const d = data as {
    you?: { local_code?: unknown }
    local_code?: unknown
    repositories?: unknown
    brief?: { run_here?: { repository?: WireRepository | null; repositories?: WireRepository[] } }
  } | null
  const code = (d?.you?.local_code ?? d?.local_code ?? (tool === 'set_local_checkout' ? d : null)) as {
    repositories?: WireRepository[]
  } | null
  if (code && Array.isArray(code.repositories)) {
    return code.repositories.map(repo => one(repo, undefined)).filter((c): c is CodebookCheckout => c !== null)
  }
  const here = d?.brief?.run_here
  const listed = here?.repository ? [here.repository] : Array.isArray(here?.repositories) ? here.repositories : []
  const found = listed.filter(repo => repo && 'local' in repo).map(repo => one(repo, repo.local))
  return found.length > 0 ? found.filter((c): c is CodebookCheckout => c !== null) : null
}

/** Merges newer checkouts into the list, one per repository. */
export function mergeCheckouts(list: CodebookCheckout[], newer: CodebookCheckout[]): CodebookCheckout[] {
  return [...list.filter(old => !newer.some(n => n.repository === old.repository)), ...newer]
}

/** One line per checkout, checked here now: is the folder a git checkout of that repository? */
export async function checkoutLines($: EngineInterface, list: CodebookCheckout[]): Promise<string[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const lines: string[] = []
  for (const c of list) {
    if (c.checkoutPath === null) {
      lines.push(`  ${c.repository}: no folder on this computer yet (Factory settings → Your computer, or ask the manager)`)
      continue
    }
    const dir = c.checkoutPath.replace(/^~(?=\/|$)/, home)
    const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
    if (top.exitCode !== 0) {
      lines.push(`  ${c.repository}: ${c.checkoutPath} — checked now: no git checkout there${c.mode === 'clone_into' ? ' yet (the manager offers to clone it)' : ''}`)
      continue
    }
    const origin = await $.process.run(['git', '-C', dir, 'remote', 'get-url', 'origin'])
    const reached = origin.exitCode === 0 ? repoOf(origin.stdout) : null
    lines.push(
      reached === c.repository
        ? `  ${c.repository}: ${c.checkoutPath} — checked now: the code is there, origin matches`
        : `  ${c.repository}: ${c.checkoutPath} — checked now: origin is ${reached ?? 'not set'}, not ${c.repository}`,
    )
  }
  return lines
}
