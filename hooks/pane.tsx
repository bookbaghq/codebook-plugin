// The Factory pane, drawn like the approved prototype (Main.dc.html): a hero card for the story, the two
// "Run here / Run in CodeBook" picture choices, illustrated station cards with Approve / Send back, and
// the latest events. MadeBook's style in CodeBook's teal. Pictures are Svg on the desktop; the terminal
// draws the same pane in words.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { CodebookLink, CodebookMode, CodebookStation, CodebookStory } from '../types'
import { ART } from './art'
import type { ArtName } from './art'
import {
  approve,
  loadFactories,
  refresh,
  sendBack,
  setMode,
  startStory,
  unfollow,
} from './factory'

// The pane's values, declared again here: the engine reads state only through atoms written in the same file.
// Keep each tag as factory.ts has it.
const mode = atom({ plugin: 'codebook', key: 'mode' } as const, 'here' as CodebookMode)
const active = atom({ plugin: 'codebook', key: 'active' } as const, null, { shape: 'active-1' })
const story = atom({ plugin: 'codebook', key: 'story' } as const, null, { shape: 'story-2' })
const events = atom({ plugin: 'codebook', key: 'events' } as const, [], { shape: 'events-1' })
const factories = atom({ plugin: 'codebook', key: 'factories' } as const, null, { shape: 'factories-1' })
const picked = atom({ plugin: 'codebook', key: 'picked' } as const, null, { shape: 'factories-1' })
const link = atom({ plugin: 'codebook', key: 'link' } as const, { state: 'idle' } as CodebookLink, {
  shape: 'link-1',
})
const busy = atom({ plugin: 'codebook', key: 'busy' } as const, null as string | null)
const sendingBack = atom({ plugin: 'codebook', key: 'sendingBack' } as const, false)
const notice = atom({ plugin: 'codebook', key: 'notice' } as const, null as string | null)

export const PANE = 'codebook-factory'

// CodeBook's teal and the status tints. Text takes the surface's own theme colours (dark or light); a colour
// is written only where its background is written beside it (the pills), so every pairing reads in both themes.
const TEAL = '#2F6E60'
const TEAL_BRIGHT = '#3E8F7D'
const LINE = '#7F8C88'

type Tone = 'done' | 'running' | 'person' | 'you' | 'waiting' | 'bad'

const TONES: Record<Tone, { pill: string; ink: string; tint: string; border: string }> = {
  done: { pill: '#DDF1E9', ink: '#14583E', tint: '#DDF1E9', border: TEAL_BRIGHT },
  running: { pill: '#E3EEF9', ink: '#204A82', tint: '#E3EEF9', border: '#6F9FD3' },
  person: { pill: '#FFE8DA', ink: '#8A4313', tint: '#FFE8DA', border: '#E59A63' },
  you: { pill: '#FFE8DA', ink: '#8A4313', tint: '#FFE8DA', border: '#E59A63' },
  waiting: { pill: '#E6ECEA', ink: '#3A4542', tint: '#E6ECEA', border: LINE },
  bad: { pill: '#FBE1DE', ink: '#8E2A1F', tint: '#FBE1DE', border: '#D9786B' },
}

/** A rounded tile holding one illustration: an Svg with the picture embedded (the desktop draws an Svg as an image). */
function tile(name: ArtName, size: number, tint: string): string {
  const pad = Math.round(size * 0.07)
  const inner = size - pad * 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.28)}" fill="${tint}"/>` +
    `<image x="${pad}" y="${pad}" width="${inner}" height="${inner}" href="${ART[name]}"/>` +
    `</svg>`
  )
}

/** The CodeBook mark: a teal rounded square with a white C, vector only. */
const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
  `<rect width="28" height="28" rx="8" fill="${TEAL}"/>` +
  '<path d="M18.2 10.1a6 6 0 1 0 0 7.8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' +
  '</svg>'

function bar(done: number, total: number, width: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="8" viewBox="0 0 ${width} 8">` +
    `<rect width="${width}" height="8" rx="4" fill="${LINE}" fill-opacity="0.35"/>` +
    (filled > 0 ? `<rect width="${filled}" height="8" rx="4" fill="${TEAL_BRIGHT}"/>` : '') +
    `</svg>`
  )
}

function artFor(s: CodebookStation): ArtName {
  const name = s.name.toLowerCase()
  if (/plan|spec|design|refine/.test(name)) return 'plan'
  if (/review|approv|sign.?off|check/.test(name)) return 'approve'
  if (/test|qa|verif/.test(name)) return 'test'
  if (/ship|deploy|merge|release|launch/.test(name)) return 'ship'
  if (/build|code|implement|develop|fix/.test(name)) return 'build'
  if (s.workerType === 'person') return 'approve'
  if (s.workerType === 'outside') return 'here'
  return 'build'
}

function who(s: CodebookStation, runsHere: boolean): string {
  // G2: story_status says per station where its runs go for this story.
  if (s.runs === 'here') return 'Agent · your Claude, this checkout'
  if (s.runs === 'cloud') return s.workerType === 'crew' ? "Crew · CodeBook's cloud" : "Agent · CodeBook's cloud"
  if (s.runs === 'outside') return `Outside agent${s.workerName ? ` · ${s.workerName}` : ''}`
  switch (s.workerType) {
    case 'person':
      return s.isYou ? 'You · decide here' : `${s.workerName || 'A person'} · decides`
    case 'outside':
      return `Outside agent${s.workerName ? ` · ${s.workerName}` : ''}`
    case 'agent':
      return runsHere ? 'Agent · your Claude, this checkout' : "Agent · CodeBook's cloud"
    case 'gate':
      return 'Waits for the parallel stations'
    case 'factory':
      return `Hands over to ${s.workerName || 'another factory'}`
    default:
      return 'Nobody works this station yet'
  }
}

function look(s: CodebookStation, st: CodebookStory | null): { tone: Tone; label: string } {
  const runsHere = s.runs === 'here' || (s.runs === null && st?.runHere === true)
  switch (s.state) {
    case 'passed':
      return { tone: 'done', label: '✓ Done' }
    case 'running':
      return { tone: 'running', label: runsHere ? 'Running here' : 'Running in CodeBook' }
    case 'with_outside_agent':
      if (s.isCurrent && st?.leaseExpired) return { tone: 'person', label: 'Claim lapsed' }
      if (s.isCurrent && st?.waitingClaimed) {
        return st.waitingClaimedByYou ? { tone: 'running', label: 'Running here' } : { tone: 'running', label: 'Taken by an agent' }
      }
      return s.runs === 'outside' ? { tone: 'waiting', label: 'Waiting for an agent' } : { tone: 'running', label: 'Ready to run here' }
    case 'testing':
      return { tone: 'running', label: 'Testing' }
    case 'queued':
      return { tone: 'running', label: 'Starting' }
    case 'waiting_for_person':
    case 'waiting_for_approval':
      return s.isCurrent && st?.waitingOnYou
        ? { tone: 'you', label: 'Needs you' }
        : { tone: 'person', label: `Waiting for ${s.workerName || 'a person'}` }
    case 'waiting_for_review':
      return { tone: 'person', label: 'In review' }
    case 'failed':
      return { tone: 'bad', label: 'Failed' }
    case 'blocked':
      return { tone: 'bad', label: 'Blocked' }
    case 'sent_back':
      return { tone: 'bad', label: 'Sent back' }
    case 'idle':
      return { tone: 'waiting', label: 'Waiting' }
    default:
      return { tone: 'waiting', label: s.state.replace(/_/g, ' ') }
  }
}

export async function drawPane($: EngineInterface, e: RenderInput): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Link } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
  const Input = 'Input' in els ? els.Input : null
  const width = Math.max(28, ('bodyColumns' in e.props ? Number(e.props.bodyColumns) : 60) || 60)

  const picture = (name: ArtName, size: number, tint: string) =>
    Svg ? <Svg source={tile(name, size, tint)} alt={`${name} illustration`} width={size} height={size} /> : null

  const pill = (tone: Tone, label: string) => (
    <Text backgroundColor={TONES[tone].pill} color={TONES[tone].ink} weight="bold" size="footnote">
      {` ${label} `}
    </Text>
  )

  const l = await read($, link)
  const a = await read($, active)
  const st = await read($, story)
  const m = await read($, mode)
  const said = await read($, notice)
  const working = await read($, busy)

  const header = (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {Svg ? (
        <Svg source={MARK} alt="CodeBook" width={28} height={28} />
      ) : (
        <Text backgroundColor={TEAL} color="#FFFFFF" weight="bold">
          {' C '}
        </Text>
      )}
      <Text weight="bold" size="heading">
        Factory
      </Text>
      <Box flexGrow={1} />
      {l.state === 'ok' && a !== null && st?.finished == null ? pill('done', '● Live') : null}
      {l.state === 'signin' ? pill('person', 'Sign in') : null}
      {l.state === 'error' ? pill('bad', 'Not reached') : null}
    </Box>
  )

  const choice = (where: 'here' | 'cloud') => {
    const isOn = m === where
    return (
      <Box
        key={`mode-${where}`}
        flexDirection="row"
        alignItems="center"
        gap={1}
        flexGrow={1}
        padding={1}
        borderStyle="round"
        borderColor={isOn ? TEAL_BRIGHT : LINE}
      >
        {picture(where === 'here' ? 'here' : 'cloud', 44, isOn ? TONES.done.tint : TONES.waiting.tint)}
        <Box flexDirection="column" gap={0}>
          <Button key={`run-${where}`} variant={isOn ? 'primary' : 'secondary'} onPress={() => setMode($, where)}>
            {where === 'here' ? 'Run here' : 'Run in CodeBook'}
          </Button>
          <Text size="footnote" dimColor>
            {where === 'here' ? 'Your Claude, this checkout' : "CodeBook's cloud"}
          </Text>
        </Box>
      </Box>
    )
  }

  const modes = (
    <Box flexDirection={width < 44 ? 'column' : 'row'} gap={1}>
      {choice('here')}
      {choice('cloud')}
    </Box>
  )

  const problem =
    l.state === 'error' ? (
      <Text color="error" size="footnote">
        {l.message}
      </Text>
    ) : null

  const footer = (
    <Box flexDirection="column" gap={1}>
      {said ? (
        <Text size="footnote" dimColor>
          {said}
        </Text>
      ) : null}
      <Link href={a?.url ?? 'https://app.codebook.work'} label="Open on app.codebook.work →" />
    </Box>
  )

  if (l.state === 'signin') {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" alignItems="center" gap={2} padding={1} borderStyle="round" borderColor={TEAL_BRIGHT}>
          {picture('factory', 72, TONES.done.tint)}
          <Text>{l.message}</Text>
        </Box>
        <Button key="retry" variant="primary" onPress={() => (a ? refresh($) : loadFactories($))}>
          I've signed in — try again
        </Button>
      </Box>
    )
  }

  if (a === null) return drawPicker()

  // The story the pane follows.
  const stations = st?.stations ?? []
  const done = st?.finished ? stations.length : stations.filter(s => s.state === 'passed').length
  const runsHere = st?.runHere === true || (st?.runHere == null && m === 'here')
  const isSendingBack = await read($, sendingBack)
  const log = (await read($, events)).slice(-4)

  const hero = (
    <Box flexDirection="row" alignItems="center" gap={2} padding={1} borderStyle="round" borderColor={TEAL_BRIGHT}>
      {picture('factory', 84, TONES.done.tint)}
      <Box flexDirection="column" flexGrow={1} gap={0}>
        <Text size="caption" weight="bold" dimColor>
          {`${a.factoryName.toUpperCase()} FACTORY · ${a.reference}`}
        </Text>
        <Text size="heading" weight="bold">
          {a.title}
        </Text>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Svg ? (
            <Svg source={bar(done, stations.length, 200)} alt={`${done} of ${stations.length} stations done`} width={200} height={8} />
          ) : null}
          <Text size="footnote" weight="bold" dimColor>
            {st?.finished === 'done'
              ? 'Done'
              : st?.finished === 'dropped'
                ? 'Dropped'
                : st?.inBacklog
                  ? 'In the backlog'
                  : `${done} of ${stations.length}`}
          </Text>
        </Box>
      </Box>
    </Box>
  )

  const card = (s: CodebookStation) => {
    const { tone, label } = look(s, st)
    const isAsk = s.isCurrent && st?.waitingOn === 'person' && st.waitingOnYou
    const isWorkHere =
      s.isCurrent &&
      !st?.waitingClaimed &&
      ((st?.waitingOn === 'outside_agent' && m === 'cloud') || (st?.waitingOn === 'runner' && st.waitingOnYou))
    return (
      <Box
        key={`station-${s.station}`}
        flexDirection="column"
        gap={1}
        padding={1}
        borderStyle="round"
        borderColor={s.isCurrent || tone === 'done' ? TONES[tone].border : LINE}
      >
        <Box flexDirection="row" alignItems="center" gap={1}>
          {picture(artFor(s), 52, TONES[tone].tint)}
          <Box flexDirection="column" flexGrow={1}>
            <Text weight="bold">{s.name}</Text>
            <Text size="footnote" dimColor>
              {s.summary && tone !== 'waiting' ? s.summary.slice(0, 140) : who(s, runsHere)}
            </Text>
          </Box>
          {pill(tone, label)}
        </Box>
        {isAsk ? (
          <Box flexDirection="column" gap={1}>
            {st.pullRequests.map(pr =>
              pr.html_url ? (
                <Link key={`pr-${pr.pull_request_id}`} href={pr.html_url} label={`Pull request #${pr.number ?? pr.pull_request_id}`} />
              ) : null,
            )}
            <Box flexDirection="row" gap={1}>
              <Button key="approve" variant="primary" onPress={() => approve($)}>
                {working === 'approve' ? 'Approving…' : 'Approve'}
              </Button>
              <Button key="send-back" onPress={() => update($, sendingBack, v => !v)}>
                Send back
              </Button>
            </Box>
            {isSendingBack && Input ? (
              <Input
                key="reason"
                label="What should change?"
                placeholder="Say what to fix; it is written on the story"
                submitLabel={working === 'send_back' ? 'Sending…' : 'Send back'}
                onSubmit={value => sendBack($, value)}
              />
            ) : null}
          </Box>
        ) : null}
        {isWorkHere ? (
          <Button
            key="work-here"
            onPress={() =>
              $.prompt.submit({
                text: `CodeBook: use the codebook:factory-worker agent to claim run ${st?.waitingRun} of story ${a.reference} ("${a.title}", ${a.factoryName}) and work it in this checkout.`,
              })
            }
          >
            Work it here
          </Button>
        ) : null}
      </Box>
    )
  }

  const recent =
    log.length === 0 ? null : (
      <Box flexDirection="column" gap={0}>
        <Text size="caption" weight="bold" dimColor>
          LATEST
        </Text>
        {log.map(ev => (
          <Text key={`ev-${ev.id}`} size="footnote" dimColor>
            {ev.station ? `${ev.station} · ` : ''}
            {ev.text}
          </Text>
        ))}
      </Box>
    )

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {hero}
      {modes}
      {problem}
      {st === null ? (
        l.state === 'error' ? null : <Text dimColor>Asking CodeBook where the story is…</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {stations.map(card)}
        </Box>
      )}
      {recent}
      <Box flexDirection="row" gap={1}>
        <Button key="refresh" onPress={() => refresh($)}>
          Refresh
        </Button>
        <Button key="stop" onPress={() => unfollow($)}>
          Pick another story
        </Button>
      </Box>
      {footer}
    </Box>
  )

  // No story yet: pick a factory, then name a story.
  async function drawPicker(): Promise<RenderElement> {
    const list = await read($, factories)
    const chosen = await read($, picked)
    const body =
      list === null ? (
        <Button
          key="load"
          variant="primary"
          onPress={async () => {
            await update($, busy, () => 'load')
            await loadFactories($)
            await update($, busy, () => null)
          }}
        >
          {working === 'load' ? 'Asking CodeBook…' : 'Show my factories'}
        </Button>
      ) : list.length === 0 ? (
        <Text dimColor>No factories yet. Make one on app.codebook.work, then come back.</Text>
      ) : chosen === null ? (
        <Box flexDirection="column" gap={1}>
          <Text weight="bold">Pick a factory</Text>
          {list.map(f => (
            <Box key={`factory-${f.factory}`} flexDirection="row" alignItems="center" gap={1} padding={1} borderStyle="round" borderColor={LINE}>
              {picture('templates', 36, TONES.waiting.tint)}
              <Box flexDirection="column" flexGrow={1}>
                <Text weight="bold">{f.name}</Text>
                <Text size="footnote" dimColor>
                  {f.workspace ? `Workspace ${f.workspace}` : 'Factory'}
                  {f.mayStart ? '' : ' · watch only'}
                </Text>
              </Box>
              <Button key={`pick-${f.factory}`} onPress={() => update($, picked, () => f)}>
                Choose
              </Button>
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Text weight="bold">{`New story in ${chosen.name}`}</Text>
          {Input && chosen.mayStart ? (
            <Input
              key="title"
              label="What should the factory make?"
              placeholder="Let customers refund a payment from the order page"
              submitLabel={working === 'start' ? 'Starting…' : 'Start'}
              onSubmit={async value => {
                if (value.trim() === '') return
                await update($, busy, () => 'start')
                const started = await startStory($, chosen.factory, value.trim(), m)
                await update($, busy, () => null)
                await update($, notice, () => started.text)
                if (started.ok) await update($, picked, () => null)
              }}
            />
          ) : (
            <Text dimColor>
              {chosen.mayStart
                ? `Type /factory run "${chosen.name}" "<story title>" to start one.`
                : 'You can watch this factory but not start stories in it.'}
            </Text>
          )}
          <Button key="back" onPress={() => update($, picked, () => null)}>
            ← Other factories
          </Button>
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" alignItems="center" gap={2} padding={1} borderStyle="round" borderColor={TEAL_BRIGHT}>
          {picture('factory', 84, TONES.done.tint)}
          <Box flexDirection="column" flexGrow={1} gap={0}>
            <Text size="heading" weight="bold">
              Run a CodeBook factory from here
            </Text>
            <Text dimColor>Start a story and watch its stations move. You approve the person stations here.</Text>
          </Box>
        </Box>
        {modes}
        {problem}
        {body}
        {footer}
      </Box>
    )
  }
}
