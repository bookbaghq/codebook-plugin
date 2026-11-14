// Read-only handoff, rendered from the same work_orders response used by chat.
type Step = { status: string; title: string; detail?: string; commit_sha?: string | null; run_id?: number | null }
type Milestone = { milestone: number; label: string; check: { needs_person?: boolean; latest?: { reason?: string; steps?: Step[] } | null } | null }
export type WorkOrderReport = {
  work_order: { reference: string; title: string; status: string; paused: boolean }
  factory_paused: boolean
  milestones: Milestone[]
  questions: { question: string }[]
  money: { total_usd: number | null; complete: boolean; tokens: number; sandbox?: { seconds: number; usd: number | null } | null } | null
}

export function orderReport(report: WorkOrderReport): string {
  const w = report.work_order
  const lines = [`${w.reference}: ${w.title} — ${w.status}${w.paused ? ' (paused)' : ''}${report.factory_paused ? ' (factory paused)' : ''}`]
  for (const m of report.milestones) {
    lines.push(`Milestone ${m.milestone}: ${m.label}`)
    const attempt = m.check?.latest
    if (attempt?.reason) lines.push(`  ${attempt.reason}`)
    if (m.check?.needs_person) lines.push('  A person needs to decide this check in CodeBook.')
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
