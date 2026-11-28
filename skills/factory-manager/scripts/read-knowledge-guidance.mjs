// Read the next knowledge step for a state on stdin, or print the contract as a skill file.
// Do not start a model session or contact CodeBook.
//   node read-knowledge-guidance.mjs step < state.json
//   node read-knowledge-guidance.mjs gap < state.json
//   node read-knowledge-guidance.mjs project claude_code|codex [--path]
import { readFileSync } from 'node:fs'
import { gapStep, knowledgeStep, projectedSkill } from './knowledge-contract.mjs'

const [mode, target, flag] = process.argv.slice(2)
if (mode === 'project') {
  const contract = readFileSync(new URL('../references/knowledge-contract.md', import.meta.url), 'utf8')
  const file = projectedSkill(target, contract)
  process.stdout.write(flag === '--path' ? file.path + '\n' : file.content)
} else if (mode === 'step' || mode === 'gap') {
  const state = JSON.parse(readFileSync(0, 'utf8'))
  console.log(JSON.stringify(mode === 'gap' ? gapStep(state) : knowledgeStep(state)))
} else {
  console.error('Usage: read-knowledge-guidance.mjs step|gap < state.json, or project claude_code|codex [--path]')
  process.exitCode = 2
}
