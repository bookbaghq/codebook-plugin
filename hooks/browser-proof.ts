import type { EngineInterface } from 'claude-code'
import type { ProofWork, ProofStep } from './proof'

interface BrowserSpec { start?: string; adapter: string; path: string; actions: Record<string, string>[]; recipe_revision: number; spec_sha256: string }
export type NativeBrowserWork = ProofWork & { repository?: { html_url?: string }; steps?: Array<ProofStep & { local_browser?: BrowserSpec }> }

// Only the calling hook holds the private report token. The plugin-owned driver takes an
// immutable adapter descriptor and independently checks the checkout before and after capture.
export async function captureForMilestone($: EngineInterface, work: NativeBrowserWork, dir: string, head: string, dirty: boolean, dynamicSandbox?: string): Promise<Record<string, unknown>> {
  const step = work.steps![0]!
  const base = { run: step.run, commit: head, dirty }
  if (!dirty && head === work.expected_commit && work.repository?.html_url) {
    try {
      const job = { dir, commit: head, repository: work.repository.html_url, script: step.local_browser, ...(dynamicSandbox ? { dynamicSandbox } : {}) }
      const capture = await $.process.run(['env', '-i', 'PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', 'node', `${$.plugin.root}/scripts/milestone-browser.mjs`, JSON.stringify(job)], { cwd: $.plugin.root, timeoutMs: 60000 })
      if (capture.exitCode === 0 && !capture.isStdoutTruncated) return { ...base, browser: JSON.parse(capture.stdout) }
    } catch { /* Report infrastructure failure without retaining app-controlled output. */ }
  }
  return { ...base, error: 'Native browser capture unavailable.' }
}
