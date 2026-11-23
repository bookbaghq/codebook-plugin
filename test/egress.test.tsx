import { expect, test } from 'claude-code/testing'
import { allows, forwarderSource, isPrivateAddress, parseHost, parseHosts, proxyEnvironment, proxySource, ruleText } from '../hooks/egress'

const reason = (entry: string) => {
  const read = parseHost(entry)
  return 'reason' in read ? read.reason : null
}

test('a list is read entry by entry: names, a port, a wildcard under a domain, an address, private:', () => {
  const { rules, refused } = parseHosts('registry.npmjs.org, *.githubusercontent.com\nexample.com:8443  93.184.215.14  [2606:4700::6810:84e5]:443 private:git.lan private:10.0.0.5:3000')
  expect(refused).toEqual([])
  expect(rules.map(ruleText)).toEqual(['registry.npmjs.org', '*.githubusercontent.com', 'example.com:8443', '93.184.215.14', '[2606:4700::6810:84e5]:443', 'private:git.lan', 'private:10.0.0.5:3000'])
  expect(rules[1]).toEqual({ host: 'githubusercontent.com', port: null, suffix: true, isPrivate: false })
  expect(rules[2]).toEqual({ host: 'example.com', port: 8443, suffix: false, isPrivate: false })
  // Upper case, a trailing dot and repeats come to one entry.
  expect(parseHosts(['Example.COM.', 'example.com']).rules.map(ruleText)).toEqual(['example.com'])
  expect(parseHosts(null)).toEqual({ rules: [], refused: [] })
  expect(parseHosts('')).toEqual({ rules: [], refused: [] })
})

test('what cannot be enforced, or would be the whole network, is refused with its reason', () => {
  expect(reason('*')).toContain('every host')
  expect(reason('*.*')).toContain('every host')
  expect(reason('*.com')).toContain('whole top-level domain')
  expect(reason('api.*.example.com')).toContain('first label')
  expect(reason('10.0.0.0/8')).toContain('address range')
  expect(reason('https://example.com')).toContain('without the scheme')
  expect(reason('example.com:0')).toContain('between 1 and 65535')
  expect(reason('example.com:99999')).toContain('between 1 and 65535')
  expect(reason('example.com:http')).toContain('not a number')
  expect(reason('exa_mple.com')).toContain('not a host name')
  expect(reason('-bad.example.com')).toContain('not a host name')
  expect(reason('999.1.1.1')).toContain('not a host name')
  expect(reason('*.93.184.215.14')).toContain('cannot stand before an address')
  // The computer itself is reachable already, as it is today: never an entry.
  expect(reason('localhost')).toContain('always reachable')
  expect(reason('127.0.0.1:5432')).toContain('always reachable')
  expect(reason('[::1]:80')).toContain('always reachable')
  expect(reason('app.localhost')).toContain('always reachable')
  // A private address or a name with no dot is the person's own network: only when written so.
  expect(reason('192.168.1.10')).toContain('private:')
  expect(reason('gitbox')).toContain('private:')
  expect(reason('private:gitbox')).toBeNull()
  const many = parseHosts(Array.from({ length: 70 }, (_, i) => `h${i}.example.com`))
  expect([many.rules.length, many.refused.length]).toEqual([64, 6])
  expect(many.refused[0]?.reason).toContain('at most 64')
})

test('a request passes only by its own entry: the name, and the port (443 and 80 when none is written)', () => {
  const { rules } = parseHosts('registry.npmjs.org, *.example.com, git.example.org:8443')
  expect(allows(rules, 'registry.npmjs.org', 443) !== null).toBe(true)
  expect(allows(rules, 'REGISTRY.npmjs.org.', 80) !== null).toBe(true)
  expect(allows(rules, 'registry.npmjs.org', 22)).toBeNull()
  expect(allows(rules, 'api.example.com', 443) !== null).toBe(true)
  expect(allows(rules, 'a.b.example.com', 443) !== null).toBe(true)
  // `*.example.com` is the names under it, not the domain itself, and not a name that merely ends the same way.
  expect(allows(rules, 'example.com', 443)).toBeNull()
  expect(allows(rules, 'badexample.com', 443)).toBeNull()
  expect(allows(rules, 'git.example.org', 8443) !== null).toBe(true)
  expect(allows(rules, 'git.example.org', 443)).toBeNull()
  expect(allows(rules, 'example.org', 443)).toBeNull()
  expect(allows(rules, 'npmjs.org', 443)).toBeNull()
  expect(allows([], 'registry.npmjs.org', 443)).toBeNull()
})

test('private, loopback and link-local addresses are known, mapped IPv6 too', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '192.168.0.1', '172.16.0.1', '172.31.255.255', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
  for (const ip of ['93.184.215.14', '172.32.0.1', '8.8.8.8', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
})

test('the command is told the proxy in the spellings its tools read; the computer itself stays direct', () => {
  const env = proxyEnvironment(18601)
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_https_proxy', 'YARN_HTTPS_PROXY']) expect(env).toContain(`${name}=http://127.0.0.1:18601`)
  expect(env).toContain('NO_PROXY=localhost,127.0.0.1,::1,.localhost')
  expect(env).toContain('NODE_USE_ENV_PROXY=1')
})

test('the proxy and the forwarder are self-contained sources: they decide as allows() does and refuse with 403', () => {
  const proxy = proxySource()
  expect(proxy).toContain("r.suffix ? n.endsWith('.' + r.host) : n === r.host")
  expect(proxy).toContain('r.port === null ? port === 443 || port === 80 : port === r.port')
  expect(proxy).toContain('HTTP/1.1 403 Forbidden')
  expect(proxy).toContain("rule.isPrivate || !isPrivate(a.address)")
  expect(proxy).not.toContain('require(\'./')
  // The forwarder goes inside the Linux box as one argument: no single quote, and it listens where the variables say.
  const forwarder = forwarderSource()
  expect(forwarder.includes("'")).toBe(false)
  expect(forwarder).toContain('server.listen(3128, "127.0.0.1", start)')
})
