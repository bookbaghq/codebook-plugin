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
export type CodebookClaim = {
  run: number
  repos: string[]
  /** The agent loop that claimed it (the call's `agentId`): only that loop holds the run's lease. Absent: the main conversation. */
  agentId?: string
  /** The story's key (`card_reference.key`, e.g. `VF-29`): the pull request's branch contains it. */
  key?: string
  /** The branch the run works on: what declare_work said, else the brief's `card_reference.branch`. */
  branch?: string
  /** The folder the run works in, as declare_work said (`~/…` or absolute). */
  worktree?: string
  /**
   * When the run's lease runs out (ms since the epoch), from the claim_work answer's `lease.expires_at`, renewed by a
   * later one in a heartbeat_work, run_note or run_artifact answer. Past it the claim blocks nothing and is dropped.
   * Absent: the answer carried no lease, and only complete_work ends the claim.
   */
  expiresAt?: number
  /**
   * Whether the run may change code (`run_here.may_change_code`, #173). False: a read-only station's run (requirements,
   * design), which never holds a repository against another loop's push. Absent (an older CodeBook): it may.
   */
  writesCode?: boolean
  /**
   * The repositories this run holds against other loops' pushes (#173): its story's own `run_here.repository`, not the
   * factory's whole list (`repos`, which is what the run's own worker may reach). Absent (a claim stored by an older
   * plugin, or a brief without `repository`): `repos`.
   */
  owns?: string[]
  /** Each listed repository's default branch (`default_branch`), which no worker pushes (#173). */
  defaults?: Record<string, string>
}

/** A repository's checkout on this computer, as CodeBook last answered it (`you.local_code`, a claim's `local`). */
export type CodebookCheckout = {
  /** `owner/name`. */
  repository: string
  /** The folder the code is in (`~/…` or absolute), or null when the person has not set one. */
  checkoutPath: string | null
  mode: 'existing' | 'clone_into' | null
}

/** The connector as the pane last found it. */
export type CodebookLink =
  | { state: 'idle' }
  | { state: 'ok' }
  | { state: 'signin'; message: string }
  | { state: 'error'; message: string }

export type CodebookBacklogPage = { factory: string; lines: string[]; next?: { factory: string; workflow: string; offset: number } }

/** Compact continuation observations belong to this session, independently of the pane selection. */
export type CodebookWorkflowWatch = {
  registerHarness?: boolean
  harnessReadyAt?: number
  factory: string
  workflow: string
  name: string
  cursor: number
  readError?: string
  scannedAt: number
  offset: number
  ready: string[]
  seen: string[]
}

export type MilestoneMemberSource = { member_item: number; member_story: string; repository: string; commit: string }
export type Recovery = MilestoneMemberSource & ({kind: 'proof'; proof: number; executor: 'here' | 'runner'} | {kind: 'repair'; item: number; story: string})
export type RetryRecord = { requested: number; state: 'pending' | 'confirmed'; check?: number; actor?: string;
  at?: string | number; reason?: string; decidedBy?: number | null }
export type RecoveryRecord = { check: number; target: Recovery; state: 'pending' | 'completed' | 'failed'; current?: boolean; note: string; run?: number
  native?: { phase: 'preparing' | 'submitted'; attempt: number; nextReadAt: number } }
export type MilestoneJournal = { recovery?: Record<string, RecoveryRecord>; prerequisites?: Record<string, string>; seen: string[]; questions: Record<string, string>; retries: Record<string, RetryRecord> }

export type CodebookContinuation = {
  manager?: CodebookWorkflowWatch
  retryAt?: number
  deliveryFailures?: number
  generation: number
  stories: Record<string, { factory: string; reference: string; order: string | null; state: string | null; event: number; waitingRun?: number }>
  orders: Record<string, { factory: string; reference: string; passes: string[] | null; milestones?: MilestoneJournal }>
  feeds: Record<string, number>
  pending: Record<string, string>
  nextFactory: number
  nextOrder: number
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    codebook: {
      mode: CodebookMode
      active: Shaped<CodebookActive | null>
      story: Shaped<CodebookStory | null>
      events: Shaped<CodebookEvent[]>
      factories: Shaped<CodebookFactory[] | null>
      picked: Shaped<CodebookFactory | null>
      backlogPage: Shaped<CodebookBacklogPage | null>
      link: Shaped<CodebookLink>
      busy: string | null
      sendingBack: boolean
      notice: string | null
      claims: Shaped<CodebookClaim[]>
      /** The plugin version this session's skills and agents were loaded from (read at session start). */
      startVersion: string | null
      /** The running version the session was last told about, so the notice is given once per change. */
      noticedVersion: string | null
      checkouts: Shaped<CodebookCheckout[]>
      trail: Shaped<CodebookTrail | null>
      watched: Shaped<CodebookWatch[]>
      continuation: Shaped<CodebookContinuation>
    }
  }
}
