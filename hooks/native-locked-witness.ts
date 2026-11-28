import type { EngineInterface } from 'claude-code'
import { lockedWitnessDriver, lockedWitnessFixture } from './locked-witness-fixture'

type Capability = { version: 1; platform: 'darwin' | 'linux'; sandbox: 'seatbelt' | 'bubblewrap' }
export type LockedSelection = {
  fixture: 'locked-dependencies'; version: 1; producer: 'codebook-native-locked-dependencies'; producer_version: 1;
  platform: string; sandbox: string; proof: number; run: number; repository_id: number; commit: string;
  definition: number; revision: number; selection: string
}
export function capabilityOf(kind: string): Capability | null {
  if (kind === 'seatbelt') return {version:1, platform:'darwin', sandbox:'seatbelt'}
  if (kind === 'bubblewrap') return {version:1, platform:'linux', sandbox:'bubblewrap'}
  return null
}
export function lockedSelection(value: unknown, capability: Capability, proof: number, repository: number, commit: string): value is LockedSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const s = value as LockedSelection
  return Object.keys(s).length === 13 && s.fixture === 'locked-dependencies' && s.version === 1
    && s.producer === 'codebook-native-locked-dependencies' && s.producer_version === 1
    && s.platform === capability.platform && s.sandbox === capability.sandbox && s.proof === proof && s.run === proof
    && Number.isSafeInteger(repository) && repository > 0 && s.repository_id === repository
    && s.commit === commit && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)
    && Number.isSafeInteger(s.definition) && s.definition > 0 && Number.isSafeInteger(s.revision) && s.revision > 0
    && typeof s.selection === 'string' && /^[0-9a-f]{64}$/.test(s.selection)
}
export async function canObserveLockedWitness($: EngineInterface, capability: Capability) {
  try {
    const probe=await $.process.run(['/usr/bin/python3','-I','-S','-c',lockedWitnessFixture,'/','0'.repeat(40),
      capability.platform,'10','probe'],{cwd:'/',timeoutMs:10000})
    return probe.exitCode === 0 && probe.stdout.trim() === 'ready'
  } catch { return false }
}
export async function observeLockedWitness($: EngineInterface, directory: string, selection: LockedSelection, seconds: number) {
  // No proof token, transport address, credential, command, host path or expectation is supplied by a child.
  const result = await $.process.run(['/usr/bin/python3','-I','-S','-c',lockedWitnessFixture,directory,selection.commit,
    selection.platform,String(seconds),lockedWitnessDriver],{cwd:'/',timeoutMs:Math.min(seconds,120)*1000})
  if (result.exitCode !== 0 || result.isStdoutTruncated || result.isStderrTruncated) return null
  try {
    const seen = JSON.parse(result.stdout)
    const ids = ['verified_offline_dependency','parked_dependency_proof']
    if (!seen || Object.keys(seen).length !== ids.length || !ids.every(id=>seen[id]==='passed')) return null
    return ids.map(id=>({id,status:'passed'}))
  } catch { return null }
}
