// Both clients interpret the current proposal response. This selector only returns instructions.
const wait = 'The factory is paused. Its manager can confirm this proposal after it resumes. Name the workflow manager from the current brief when reporting the hold. Leave it pending and re-read this proposal’s current approval route and readiness after resume.'
const confirm = 'Show the eligible stories and their recorded criteria, then call confirm_stories with decided_by: "manager". Tell the person which stories you confirmed.'
const ask = 'Show each proposed story and its recorded acceptance criteria. Ask “Proceed?” and wait for the person’s yes before calling confirm_stories on their behalf.'

function personGuidance(route) {
  return route.factory_paused ? ask + ' Keep their answer and wait for the factory to resume before placing the approved stories.' : ask
}

const refreshMixed = 'Leave these items pending and refresh the item-level approval route before asking for approval or placing any stories.'

function hasItemRouting(route) {
  return route?.next_action === 'split' || route?.decision_owner === 'mixed' ||
    route?.manager_items !== undefined || route?.person_items !== undefined
}

function mixedGuidance(route, stories) {
  const { manager_items: manager, person_items: person } = route
  if (route.next_action !== 'split' || route.decision_owner !== 'mixed' || typeof route.factory_paused !== 'boolean' ||
      !Array.isArray(manager) || !manager.length || !Array.isArray(person) || !person.length) return refreshMixed

  const items = [...manager, ...person]
  const ids = new Set(items)
  if (items.some(id => !Number.isSafeInteger(id) || id < 1) || ids.size !== items.length) return refreshMixed
  // A fresh proposal includes its lines. A confirmation refusal supplies just the routed IDs.
  if (stories) {
    const proposedIds = new Set(stories.map(story => story?.item))
    if (stories.length !== ids.size || !items.every(id => proposedIds.has(id))) return refreshMixed
  }

  const managerIds = '[' + manager.join(', ') + ']', personIds = '[' + person.join(', ') + ']'
  const managerStep = route.factory_paused
    ? `Manager items ${managerIds} are waiting for the factory to resume. Name their workflow manager from the brief. Leave them pending and re-read their current route and readiness after resume.`
    : `Use confirm_stories for this proposal with stories: ${managerIds}, decided_by: "manager". These manager items can proceed independently of the person’s answer.`
  const when = route.factory_paused ? 'After their yes and factory resume, recheck the route.' : 'Wait for their yes.'
  return managerStep + ` Show the titles and recorded criteria for person items ${personIds} and ask for approval only for those IDs. ${when} For approval of all those items, use confirm_stories with stories: ${personIds}, decided_by: "person". For partial approval, pass only the IDs they approved.`
}

export function proposalGuidance(tool, reply) {
  if (tool === 'confirm_stories') {
    const error = reply?.error
    if (hasItemRouting(error?.goes_alone)) {
      if (error.code !== 'FORBIDDEN' && error.code !== 'CONFLICT') return refreshMixed
      return 'The refused confirmation applied no items. ' + mixedGuidance(error.goes_alone)
    }
    if (error?.code === 'CONFLICT' && error.goes_alone?.next_action === 'wait_for_resume') return wait
    if (error?.code === 'FORBIDDEN' && error.goes_alone?.next_action === 'ask_person') return personGuidance(error.goes_alone)
    return null
  }
  if (tool !== 'propose_stories' || !reply?.proposal || reply.error) return null

  const route = reply.goes_alone
  if (hasItemRouting(route)) return Array.isArray(reply.stories) ? mixedGuidance(route, reply.stories) : refreshMixed
  if (!reply.stories?.length) return null
  switch (route?.next_action) {
    case 'wait_for_resume': return wait
    case 'ask_person': return personGuidance(route)
    case 'confirm': return confirm
    case undefined: return route?.may_confirm_yourself === true ? confirm : ask
    default: return 'Leave this proposal pending and read its current approval route. The server returned an unrecognized next action.'
  }
}
