// Milestone decisions are scoped to one order and one attempt. The settings editor has separate authority.
export type Route = { factory: string; order: string; check: number; owner: string; action: string; reason: string }
type Attempt = { id?: number; attempt?: number; status?: string; decision?: string; decided_at?: string | number;
  decided_by_user_id?: number | null; retry_note?: string; reason?: string }
export type Check = { needs_person?: boolean; latest?: Attempt | null; route?: Route | null; history?: Attempt[]; check_cannot_run?: string }
export type OrderView = { order?: string; work_order?: { reference?: string; status?: string; paused?: boolean;
  execution_limits?: { deadline_reached?: boolean; last_refusal?: string } | null }; factory_paused?: boolean;
  milestones?: { milestone: number; state?: string; check?: Check | null; fixes?: { check_id?: number; card?: {public_id?: string} | null }[] }[] }
type Attention = { kind?: string; route?: Route; factory?: string | {factory?: string}; order?: string;
  check?: number; check_id?: number; why?: string; on_you?: boolean }
export type Needs = { for_manager?: Attention[]; for_person?: Attention[] }
export type RetryRecord = { requested: number; state: 'pending' | 'confirmed'; check?: number; actor?: string;
  at?: string | number; reason?: string; decidedBy?: number | null }
export type MilestoneJournal = { seen: string[]; questions: Record<string, string>; retries: Record<string, RetryRecord> }

const owners: Record<string, string> = { wait: 'none', repair: 'manager', hold: 'none', settled: 'none', review: 'person', retry: 'manager' }
const keyOf = (r: Route) => [r.factory, r.order, r.check, r.action].join(':')
export const blankJournal = (): MilestoneJournal => ({ seen: [], questions: {}, retries: {} })
export function currentRoute(check: Check, factory: string, order: string): Route | null {
  const r = check.route
  if (!r || r.factory !== factory || r.order !== order || !/^wo[1-9]\d*$/.test(order) || !Number.isSafeInteger(r.check)
    || r.check <= 0 || r.check !== check.latest?.id || owners[r.action] !== r.owner || typeof r.reason !== 'string' || !r.reason.trim()) return null
  if (typeof check.needs_person === 'boolean' && check.needs_person !== (r.action === 'review')) return null
  return r
}

export function decisions(view: OrderView, needs: Needs, factory: string, order: string) {
  const out = new Map<string, { route: Route; policy?: string }>()
  if (view.order !== order || !Array.isArray(needs?.for_manager) || !Array.isArray(needs.for_person)
      || !view.work_order || ['cancelled', 'done'].includes(view.work_order.status ?? '')) return out
  const attention = [...needs.for_person.map(row => ({row, owner: 'person'})), ...needs.for_manager.map(row => ({row, owner: 'manager'}))]
  for (const {check} of view.milestones ?? []) {
    const id = check?.latest?.id
    if (!check || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue
    const rows = attention.filter(({row}) => row?.kind === 'milestone_check'
      && (row.route ? row.route.check === id && row.route.order === order && row.route.factory === factory
        : (row.check_id ?? row.check) === id && row.order === order && (typeof row.factory === 'string' ? row.factory : row.factory?.factory) === factory))
    if (rows.length !== 1) continue
    const {row, owner} = rows[0]!
    if (check.check_cannot_run !== undefined && !['ask', 'hold', 'pass_on_story_tests'].includes(check.check_cannot_run)) continue
    let route = currentRoute(check, factory, order)
    if (!route && check.route == null && !row.route && check.needs_person === true && owner === 'person' && row.on_you === true && typeof row.why === 'string' && row.why.trim()) {
      route = {factory, order, check: id, owner, action: 'review', reason: row.why}
    } else if (!route || row.route?.owner !== route.owner || row.route.action !== route.action || row.route.reason !== route.reason) continue
    if (route.owner !== owner || (route.action === 'review' && row.on_you !== true)) continue
    if (route.owner === 'manager' && (view.factory_paused || view.work_order.paused || view.work_order.execution_limits?.deadline_reached)) continue
    if (['retry', 'repair', 'review'].includes(route.action)) out.set(keyOf(route), { route, policy: check.check_cannot_run })
  }
  return out
}

export function recoverRetries(view: OrderView, journal: MilestoneJournal): void {
  for (const {check} of view.milestones ?? []) {
    if (!Array.isArray(check?.history)) continue
    const attempts = [...check.history, ...(check.latest ? [check.latest] : [])]
    for (const record of Object.values(journal.retries)) {
      const old = check.history.find(a => a.id === record.requested && a.status === 'fixed' && a.decision === 'manager_retry' && a.decided_at)
      const successor = old?.attempt && attempts.find(a => a.attempt === old.attempt! + 1)
      if (old && successor && successor.id) Object.assign(record, {state: 'confirmed', check: successor.id,
        actor: 'manager', at: old.decided_at, decidedBy: old.decided_by_user_id, reason: old.retry_note})
    }
  }
}

export function confirmedRetry(reply: {factory?: string; order?: string; requested_check?: number; decision?: string;
    authority?: string; check?: Attempt; started?: {check_id?: number} | null}, r: Route): boolean {
  return reply?.factory === r.factory && reply.order === r.order && reply.requested_check === r.check && reply.decision === 'retry'
    && reply.authority === 'manager' && Number.isSafeInteger(reply.check?.id) && reply.check!.id! > 0
    && reply.check!.id !== r.check && reply.started?.check_id === reply.check!.id
}
