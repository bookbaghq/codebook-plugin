// Read-only handoff, rendered from the same work_orders response used by chat.
import { currentRoute } from './milestone'
import type { Check } from './milestone'
type Step = { status: string; title: string; detail?: string; commit_sha?: string | null; run_id?: number | null }
type Milestone = { milestone: number; label: string; state?: string; check: (Check & { latest?: { steps?: Step[] } | null }) | null }
type ExecutionLimits = { max_usd: string | null; deadline: string | null; deadline_reached: boolean; last_refusal?: string }
type SpendBalance = { available_usd: string; reserved_usd: string; spent_usd: string }
export type WorkOrderReport = {
  order?: string
  work_order: { reference: string; title: string; status: string; paused: boolean; execution_limits?: ExecutionLimits | null }
  spend_balance?: SpendBalance | null
  factory_paused: boolean
  milestones: Milestone[]
  questions: { question: string }[]
  money: { total_usd: number | null; complete: boolean; tokens: number; sandbox?: { seconds: number; usd: number | null } | null } | null
}

export function orderReport(report: WorkOrderReport): string {
  const w = report.work_order
  const lines = [`${w.reference}: ${w.title} — ${w.status}${w.paused ? ' (paused)' : ''}${report.factory_paused ? ' (factory paused)' : ''}`]
  const limits = w.execution_limits
  if (limits?.max_usd != null) lines.push('Work-order spend limit at configured rates: $' + limits.max_usd + '.')
  const balance = report.spend_balance
  if (balance) lines.push('Work-order balance: $' + balance.available_usd + ' available, $' + balance.reserved_usd + ' reserved, $' + balance.spent_usd + ' recorded.')
  if (limits?.deadline) lines.push('Deadline: ' + limits.deadline + (limits.deadline_reached ? ' (reached). New work is held.' : '.'))
  if (limits?.last_refusal) lines.push('Last operation held: ' + limits.last_refusal)
  for (const m of report.milestones) {
    lines.push(`Milestone ${m.milestone}: ${m.label}`)
    const attempt = m.check?.latest
    if (attempt?.reason) lines.push(`  ${attempt.reason}`)
    const route = m.check?.route && report.order ? currentRoute(m.check, m.check.route.factory, report.order) : null
    if (route) {
      const label = {wait: 'Waiting for proof', repair: 'Repairs in progress', hold: 'Held', review: 'Owner review',
        retry: 'Manager retry available', settled: m.state === 'ruled' ? 'Factory rule applied' : m.state === 'waived' ? 'Passed by the owner' : 'Check settled'}[route.action]
      lines.push(`  ${label} (check #${route.check}). ${route.reason}`)
    } else if (m.check?.route == null && m.check?.needs_person) lines.push('  A person needs to decide according to the recorded check status. See current requests in CodeBook.')
    const steps = attempt?.steps ?? []
    // Surface failures first and identify omitted evidence explicitly on very large plans.
    const ordered = [...steps.filter(s => ['failed', 'cannot_run'].includes(s.status)), ...steps.filter(s => !['failed', 'cannot_run'].includes(s.status))]
    for (const s of ordered.slice(0, 6)) {
      const where = [s.commit_sha ? `commit ${s.commit_sha}` : '', s.run_id ? `run #${s.run_id}` : ''].filter(Boolean).join(', ')
      lines.push(`  ${s.status}: ${s.title}${where ? ' (' + where + ')' : ''}${s.detail && ['failed', 'cannot_run'].includes(s.status) ? ' — ' + s.detail : ''}`)
    }
    if (ordered.length > 6) lines.push(`  ${ordered.length - 6} more checks in the work order.`)
  }
  if (!report.milestones.length) lines.push('No numbered milestones.')
  for (const q of report.questions) lines.push(`Planner question: ${q.question}`)
  const money = report.money
  if (!money || money.total_usd == null) lines.push('Recorded cost: no dollar total available.')
  else lines.push(`Recorded cost: $${money.total_usd.toFixed(4)}${money.complete ? '' : ' (partial)'}.`)
  if (money?.sandbox && money.sandbox.usd == null) lines.push(`Unpriced sandbox time: ${money.sandbox.seconds}s.`)
  return lines.join('\n')
}
