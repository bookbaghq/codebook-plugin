// Both clients interpret the current proposal response. This selector only returns instructions.
const wait = 'The factory is paused. Its manager can confirm this proposal after it resumes. Name the workflow manager from the current brief when reporting the hold. Leave it pending and re-read this proposal’s current approval route and readiness after resume.'
const confirm = 'Show the eligible stories and their recorded criteria, then call confirm_stories with decided_by: "manager". Tell the person which stories you confirmed.'
const ask = 'Show each proposed story and its recorded acceptance criteria. Ask “Proceed?” and wait for the person’s yes before calling confirm_stories on their behalf.'

function personGuidance(route) {
  return route.factory_paused ? ask + ' Keep their answer and wait for the factory to resume before placing the approved stories.' : ask
}

export function proposalGuidance(tool, reply) {
  if (tool === 'confirm_stories') {
    const error = reply?.error
    if (error?.code === 'CONFLICT' && error.goes_alone?.next_action === 'wait_for_resume') return wait
    if (error?.code === 'FORBIDDEN' && error.goes_alone?.next_action === 'ask_person') return personGuidance(error.goes_alone)
    return null
  }
  if (tool !== 'propose_stories' || !reply?.proposal || !reply.stories?.length || reply.error) return null

  const route = reply.goes_alone
  switch (route?.next_action) {
    case 'wait_for_resume': return wait
    case 'ask_person': return personGuidance(route)
    case 'confirm': return confirm
    case undefined: return route?.may_confirm_yourself === true ? confirm : ask
    default: return 'Leave this proposal pending and read its current approval route. The server returned an unrecognized next action.'
  }
}
