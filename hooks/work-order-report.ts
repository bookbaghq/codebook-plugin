// Read-only handoff, rendered from the same work_orders response used by chat.
type Step = { status: string; title: string; detail?: string; commit_sha?: string | null; run_id?: number | null }
type Milestone = { milestone: number; label: string; check: { needs_person?: boolean; latest?: { reason?: string; steps?: Step[] } | null } | null }
type ExecutionLimits = { max_usd: string | null; deadline: string | null; deadline_reached: boolean; last_refusal?: string }
type SpendBalance = { available_usd: string; reserved_usd: string; spent_usd: string }
type ProductionIncident = {
  id: number; title: string; severity: string | null; pull_number: number; commit: string | null
  deployed_service: string | null; incident_url: string | null; deploy_url: string | null
  rollback_decision?: 'rolled_back' | 'kept_deployment' | null; decision_note?: string | null
  resumed_at: number | null; resumed_by: string | null
}
type ProductionWatch = {
  enabled: boolean; owner_name: string | null; filter: string; can_decide: boolean; hold_id: number | null
  incidents: ProductionIncident[]
}

export type WorkOrderReport = {
  work_order: { reference: string; title: string; status: string; paused: boolean; execution_limits?: ExecutionLimits | null }
  spend_balance?: SpendBalance | null
  production_watch?: ProductionWatch | null
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
  const watch = report.production_watch
  if (watch?.enabled) lines.push('Production watch: ' + (watch.owner_name || 'Assigned owner') + (watch.filter ? ' watches alerts containing ' + JSON.stringify(watch.filter) : ' watches all qualifying alerts') + '.')
  if (watch?.hold_id) {
    lines.push('Production hold #' + watch.hold_id + '. ' + (watch.can_decide ? 'You can review this hold.' : 'Review is with the watch owner or work-order creator.') + ' Assess customer impact and decide whether to roll back in the deployment system before resuming the order.')
  }
  for (const incident of watch?.incidents ?? []) {
    if (!watch?.hold_id && !incident.resumed_at) continue
    const evidence = [incident.severity, incident.deployed_service, incident.pull_number ? 'PR #' + incident.pull_number : '', incident.commit ? 'commit ' + incident.commit : ''].filter(Boolean).join(', ')
    lines.push('  ' + incident.title + (evidence ? ' (' + evidence + ')' : '') + (incident.resumed_at ? ' — resumed by ' + (incident.resumed_by || 'a person') + '.' : ''))
    if (incident.resumed_at) {
      const choice = incident.rollback_decision === 'rolled_back' ? 'Rolled back' : incident.rollback_decision === 'kept_deployment' ? 'Kept deployment' : 'Decision not recorded'
      lines.push('  ' + choice + (incident.decision_note ? ' — ' + incident.decision_note : ''))
    }
    if (incident.incident_url) lines.push('  Alert: ' + incident.incident_url)
    if (incident.deploy_url) lines.push('  Deployment: ' + incident.deploy_url)
  }
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
