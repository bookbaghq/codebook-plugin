// The Factory pane's session values. Plain data only: they outlive a reload of the hooks module.

/** Where a story's agent stations run: this checkout with the person's Claude, or CodeBook's cloud. */
export type CodebookMode = 'here' | 'cloud'

/** The story the pane follows. */
export type CodebookActive = {
  story: string
  factory: string
  factoryName: string
  workflow: string | null
  reference: string
  title: string
  url: string | null
}

/** One station as the pane draws it: factory_board's station joined with story_status's latest run there. */
export type CodebookStation = {
  station: string
  name: string
  workerType: string
  workerName: string
  isYou: boolean
  state: string
  run: number | null
  summary: string | null
  /** Where this station's runs go for this story: here, cloud, person, outside, gate, factory or none. */
  runs: string | null
  isCurrent: boolean
}

/** What the pane knows of the followed story, from the last story_status. */
export type CodebookStory = {
  stations: CodebookStation[]
  finished: string | null
  inBacklog: boolean
  runHere: boolean | null
  canMove: boolean
  waitingOn: 'person' | 'outside_agent' | 'runner' | 'review' | null
  waitingRun: number | null
  waitingOnYou: boolean
  waitingClaimed: boolean
  waitingClaimedByYou: boolean
  waitingFence: number | null
  leaseExpired: boolean
  pullRequests: { pull_request_id: number; head_sha: string; number: number | null; html_url: string | null }[]
  /** What approving does to the pull requests, in CodeBook's words (`waiting.on_approve.sentence`), when it says. */
  onApprove: string | null
  /** At Done: what CodeBook says a person still has to merge (story_status.done.sentence), when someone must. */
  leftForPerson?: string | null
  /** A question waiting on this person (a request_person wait's, or the story's from ask_person or an escalation). */
  question: string | null
  /** What waits on this person, as one key: the session is woken once per key. */
  waitKey: string | null
  lastEvent: number | null
  checkedAt: number
}

/** One line of the pane's log, from story_status events. */
export type CodebookEvent = {
  id: number
  kind: string
  station: string | null
  text: string
  at: string
}

/** A factory the person may see, for the picker. */
export type CodebookFactory = {
  factory: string
  name: string
  workspace: string
  organization: string | null
  mayStart: boolean
  url: string | null
}

/** What the card holds, for the pane (G5b story_trail). */
export type CodebookTrail = {
  pullRequests: { label: string; url: string | null; state: string | null }[]
  comments: { id: number; author: string; text: string }[]
  artifacts: number
}

/** Another story this session follows (from the same confirm_stories): polled only for what waits on this person. */
export type CodebookWatch = {
  story: string
  reference: string
  title: string
  url: string | null
  waitKey: string | null
  question: string | null
}

/** A CodeBook run this session holds, and the repositories its brief lets it change (`owner/name`). */
export type CodebookClaim = { run: number; repos: string[] }

/** The connector as the pane last found it. */
export type CodebookLink =
  | { state: 'idle' }
  | { state: 'ok' }
  | { state: 'signin'; message: string }
  | { state: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    codebook: {
      mode: CodebookMode
      active: Shaped<CodebookActive | null>
      story: Shaped<CodebookStory | null>
      events: Shaped<CodebookEvent[]>
      factories: Shaped<CodebookFactory[] | null>
      picked: Shaped<CodebookFactory | null>
      link: Shaped<CodebookLink>
      busy: string | null
      sendingBack: boolean
      notice: string | null
      claims: Shaped<CodebookClaim[]>
      trail: Shaped<CodebookTrail | null>
      watched: Shaped<CodebookWatch[]>
    }
  }
}
