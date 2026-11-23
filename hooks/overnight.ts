// The command drafts a prompt. Only the work-order proposal on CodeBook can enforce these limits.
export const overnightUsage = '/factory overnight <factory> "<goal>" [--max-usd <amount>] [--deadline <ISO time with zone>]'

type Limits = { max_usd?: number; deadline?: string }


export function overnightArguments(words: string[]): { args: string[]; limits: Limits } | { error: string } {
  const args: string[] = []
  const limits: Limits = {}
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--here') return { error: 'Overnight work runs in CodeBook. Use /factory run --here for work on this computer.' }
    if (word === '--cloud') continue
    if (!word.startsWith('--')) { args.push(word); continue }
    const [flag, inline] = word.split(/=(.*)/s)
    if (flag !== '--max-usd' && flag !== '--deadline') return { error: 'Unknown overnight option ' + flag + '. Usage: ' + overnightUsage }
    const value = inline ?? words[++i]
    if (flag === '--max-usd') {
      if (limits.max_usd !== undefined) return { error: 'Supply --max-usd once.' }
      if (!value || !/^\d{1,6}(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0 || Number(value) > 100000)
        return { error: 'Supply --max-usd as a USD amount from 0.01 through 100000.00.' }
      limits.max_usd = Number(value)
    } else {
      if (limits.deadline !== undefined) return { error: 'Supply --deadline once.' }
      if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !(Date.parse(value) > Date.now()))
        return { error: 'Supply --deadline as a future ISO date and time with Z or a numeric time zone offset.' }
      limits.deadline = value
    }
  }
  return { args, limits }
}

export function overnightRequest(factory: string, title: string, limits: Limits): string {
  const explicit = Object.keys(limits).length ? ' Pass these explicit proposal fields exactly: ' + JSON.stringify(limits) + '.' : ''
  return [
    'Plan an overnight cloud work order for ' + JSON.stringify(factory) + '. The goal is ' + JSON.stringify(title) + '.',
    'Read manager_brief, then use propose_stories with run_location "cloud", numbered milestones and verifiable acceptance criteria.' + explicit,
    'Use max_usd only for an explicitly requested order-wide USD cap and deadline only for a requested stop time, resolved to ISO 8601 with a time zone. Clarify ambiguous or conflicting limits with me first. Omit each unspecified limit; never invent a budget from "overnight" or the manager’s token ceiling.',
    'Verify that proposal.execution_limits records every requested cap and deadline. If the server cannot enforce one, stop and tell me before confirming any stories.',
    'Show me the recorded limits, which later milestones can start under the current factory policy, any human approvals, and the dedicated manager’s token ceiling (manager only), then ask "proceed?" before confirm_stories.',
    'On approval, confirm the stories and use open_sub_manager in fresh mode under the main CodeBook manager conversation, unless this order already has a manager. Brief it on the goal, constraints and evidence. Give me the work order link and its manager reference so I can follow it after closing this session.',
  ].join(' ')
}
