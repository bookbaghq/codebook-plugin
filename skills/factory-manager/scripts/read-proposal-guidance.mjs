// Read an MCP tool's JSON payload from stdin. Do not start a model session or contact CodeBook.
import { readFileSync } from 'node:fs'
import { proposalGuidance } from './proposal-guidance.mjs'

const message = proposalGuidance(process.argv[2], JSON.parse(readFileSync(0, 'utf8')))
if (message) console.log(message)
