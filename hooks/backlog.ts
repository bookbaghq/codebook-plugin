import type { EngineInterface } from 'claude-code'
import type { CodebookBacklogPage } from '../types'
import { call } from './connector'

export const backlogUsage = '/factory backlog <factory> [--workflow "<name or ID>"] [--offset <number>]'

type Story = {
  story: string
  reference: string
  title: string
  proposal?: { reference: string; item: number; waiting_for_proceed: boolean } | null
}

type Board = {
  factory: string
  name: string
  workflow: { workflow: string; name: string }
  backlog_count: number
  backlog?: { offset: number; next_offset: number | null; stories: Story[] }
}

export async function backlogText($: EngineInterface, words: string[]): Promise<string> {
  const factoryWords: string[] = []
  let workflow: string | undefined, offset: number | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (!word.startsWith('--') && workflow === undefined && offset === undefined) {
      factoryWords.push(word)
      continue
    }
    const value = words[++i]
    if (word === '--workflow' && workflow === undefined && value && !value.startsWith('--')) workflow = value
    else if (word === '--offset' && offset === undefined && /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value))) offset = Number(value)
    else return 'Usage: ' + backlogUsage
  }
  const factory = factoryWords.join(' ').trim()
  if (!factory) return 'Usage: ' + backlogUsage
  const page = await readBacklog($, factory, workflow, offset)
  return page.lines.join('\n')
}

export async function readBacklog($: EngineInterface, factory: string, workflow?: string, offset = 0): Promise<CodebookBacklogPage> {
  const got = await call<Board>($, 'factory_board', { factory, ...(workflow ? { workflow } : {}), backlog_offset: offset })
  if (!got.ok) return { factory, lines: [got.message] }
  const board = got.data
  const page = board?.backlog
  if (!page) return { factory, lines: ['This CodeBook server did not return backlog pages. Open the Backlog drawer in CodeBook to see its stories.'] }
  const command = `/factory backlog ${board.factory} --workflow ${board.workflow.workflow}`
  const lines = [`${board.name} · ${board.workflow.name} backlog`]
  if (!page.stories.length) {
    lines.push(board.backlog_count ? `No stories at offset ${page.offset}. Start again: ${command}` : 'No stories in this backlog.')
  } else {
    lines.push(`Showing ${page.offset + 1}–${page.offset + page.stories.length} of ${board.backlog_count}.`)
    for (const story of page.stories) {
      const p = story.proposal
      const proposal = p ? ` · ${p.reference} item ${p.item}${p.waiting_for_proceed ? ' (waiting for proceed)' : ''}` : ''
      lines.push(`${story.reference} ${story.title}${proposal} · /factory follow ${story.story}`)
    }
    if (page.next_offset !== null) lines.push(`Next page: ${command} --offset ${page.next_offset}`)
  }
  return {
    factory: board.factory,
    lines,
    next: page.next_offset === null ? undefined : { factory: board.factory, workflow: board.workflow.workflow, offset: page.next_offset },
  }
}
