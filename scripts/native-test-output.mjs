// Translate the installed CLI's native result lines, without assigning outcomes to unreported tests.
export function nativeResultsToTap(output) {
  const text = String(output).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  const results = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\((pass|fail|skip|todo)\) (.+?)(?: \[\d+(?:\.\d+)?(?:ms|s)\])?\s*$/.exec(line)
    if (match) results.push({ status: match[1], name: match[2].trim() })
  }
  const total = /^Ran (\d+) tests? across \d+ files?\./m.exec(text)
  const passes = /^\s*(\d+) pass\s*$/m.exec(text)
  const failures = /^\s*(\d+) fail\s*$/m.exec(text)
  const count = status => results.filter(result => result.status === status).length
  if (!results.length || !total || !passes || !failures || Number(total[1]) !== results.length
    || Number(passes[1]) !== count('pass') || Number(failures[1]) !== count('fail')) {
    return { error: 'Native test output is incomplete or unrecognized; no named proof results were emitted.' }
  }
  const lines = results.map((result, index) => {
    // TAP treats # as the start of a directive; escape it so test names cannot become SKIP/TODO.
    const name = result.name.replace(/#/g, '\\#')
    const directive = ['skip', 'todo'].includes(result.status) ? ` # ${result.status.toUpperCase()}` : ''
    return `${result.status === 'fail' ? 'not ok' : 'ok'} ${index + 1} - ${name}${directive}`
  })
  return { tap: `TAP version 13\n${lines.join('\n')}\n1..${results.length}\n`, failed: count('fail') }
}
