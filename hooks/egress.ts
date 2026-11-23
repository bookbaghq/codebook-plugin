// A proof run's list of allowed hosts (C27). The sandboxes this plugin uses cannot filter by host name: Seatbelt's
// network rules take only "localhost" or "*" as a host, and bubblewrap has a network namespace or none. So a run with a
// list keeps the sandbox exactly as a run with no network ("loopback": the computer itself), and the plugin starts a
// small filtering proxy OUTSIDE the box, the only way out:
//
//   - macOS: the proxy listens on 127.0.0.1 (a port the system picks). The box already lets a command reach the
//     computer itself, so it reaches the proxy, and nothing else beyond the computer.
//   - Linux: the box has a network namespace of its own (`--unshare-net`), so the proxy listens on a Unix socket in the
//     proof cache folder, which is bound into the box, and a forwarder inside the box listens on its own 127.0.0.1:3128
//     and passes each connection to that socket. The forwarder then starts the command.
//
// The command is told the proxy in HTTP_PROXY / HTTPS_PROXY (and the spellings npm, yarn, pip and Node read). The proxy
// answers CONNECT (https, git over https) and plain http for a host and port on the list, resolves the name ITSELF and
// connects to that address, and refuses everything else with 403. A program that ignores the proxy variables reaches
// nothing beyond the computer: the box refuses it. A name that resolves to a private, loopback or link-local address
// is refused unless its entry is written `private:<name>` (a git host on the person's own network).
//
// This file imports nothing, so a harness can load it with Node (type stripping) and run the proxy it describes.

/** One entry of the list, validated. `port` null: 443 and 80. `suffix`: any name under `host`, not `host` itself. */
export type HostRule = { host: string; port: number | null; suffix: boolean; isPrivate: boolean }
export type HostList = { rules: HostRule[]; refused: { entry: string; reason: string }[] }

/** At most this many entries: a list is for the few hosts a repository's checks need. */
export const MAX_HOSTS = 64
/** The port the forwarder inside a Linux box listens on (the box has a network of its own, so it is always free). */
export const FORWARD_PORT = 3128

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Whether `text` is an IPv4 address (each part 0–255). */
function isIpv4(text: string): boolean {
  const parts = IPV4.exec(text)
  return parts !== null && parts.slice(1).every(part => Number(part) <= 255)
}

/** Whether `text` is an IPv6 address, loosely (hex groups and colons, at most one "::"). */
function isIpv6(text: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(':')) return false
  if ((text.match(/::/g) ?? []).length > 1) return false
  const groups = text.split(':')
  return groups.length >= 3 && groups.length <= 8 && groups.every(group => group === '' || /^[0-9a-f]{1,4}$/.test(group) || isIpv4(group))
}

/** The computer itself: always reachable in the box, so never an entry. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0' || host === '::'
}

/** A private, loopback, link-local or unspecified address (the proxy refuses these unless the entry says `private:`). */
export function isPrivateAddress(ip: string): boolean {
  const address = ip.toLowerCase().replace(/^::ffff:/, '')
  return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address)
    || address === '::1' || address === '::' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address)
}

/** One entry as the person or the recipe wrote it, read and judged. → the rule, or why it is refused. */
export function parseHost(written: string): HostRule | { reason: string } {
  let text = written.trim().toLowerCase()
  if (text === '') return { reason: 'it is empty' }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) return { reason: 'write the host alone, without the scheme (example.com, not https://example.com)' }
  if (text.includes('/')) return { reason: 'an address range or a path cannot be enforced; list each host' }
  const isPrivate = text.startsWith('private:')
  if (isPrivate) text = text.slice('private:'.length)
  let host = text
  let port: number | null = null
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  if (bracketed) {
    host = bracketed[1] ?? ''
    port = bracketed[2] === undefined ? null : Number(bracketed[2])
    if (!isIpv6(host)) return { reason: 'the address in brackets is not an IPv6 address' }
  } else if ((text.match(/:/g) ?? []).length === 1) {
    const [name, digits] = text.split(':')
    if (!/^\d{1,5}$/.test(digits ?? '')) return { reason: 'the port is not a number' }
    host = name ?? ''
    port = Number(digits)
  } else if (text.includes(':')) {
    if (!isIpv6(text)) return { reason: 'it is not a host name or an address' }
  }
  if (port !== null && (port < 1 || port > 65535)) return { reason: 'the port is not between 1 and 65535' }
  if (host === '*' || host === '*.*' || /^\*\.?$/.test(host)) return { reason: 'a wildcard that matches every host would be the whole network' }
  const suffix = host.startsWith('*.')
  if (suffix) host = host.slice(2)
  if (host.includes('*')) return { reason: 'a wildcard is allowed only as the first label (*.example.com)' }
  host = host.replace(/\.$/, '')
  if (isLoopback(host)) return { reason: 'the computer itself is always reachable and needs no entry' }
  const isAddress = isIpv4(host) || isIpv6(host)
  if (isAddress) {
    if (suffix) return { reason: 'a wildcard cannot stand before an address' }
    if (isPrivateAddress(host) && !isPrivate) return { reason: 'a private address needs the entry written private:<address>' }
    return { host, port, suffix: false, isPrivate }
  }
  const labels = host.split('.')
  if (host.length > 253 || !labels.every(label => LABEL.test(label))) return { reason: 'it is not a host name' }
  if (/^\d+$/.test(labels.at(-1) ?? '')) return { reason: 'it is not a host name or an address' }
  if (suffix && labels.length < 2) return { reason: `*.${host} would match a whole top-level domain; name the domain (*.example.com)` }
  if (!suffix && labels.length < 2 && !isPrivate) return { reason: 'a name with no dot is a name on your own network; write it private:<name>' }
  return { host, port, suffix, isPrivate }
}

/** The list as text: entries separated by commas, spaces or new lines; a list of strings is read entry by entry. */
export function parseHosts(input: string | readonly unknown[] | null | undefined): HostList {
  const entries = (typeof input === 'string' ? input.split(/[\s,]+/) : Array.isArray(input) ? input.map(one => (typeof one === 'string' ? one : '')).flatMap(one => one.split(/[\s,]+/)) : []).filter(one => one.trim() !== '')
  const rules: HostRule[] = []
  const refused: { entry: string; reason: string }[] = []
  for (const entry of entries) {
    const read = parseHost(entry)
    if ('reason' in read) refused.push({ entry, reason: read.reason })
    else if (rules.length >= MAX_HOSTS) refused.push({ entry, reason: `a list holds at most ${MAX_HOSTS} hosts` })
    else if (!rules.some(one => ruleText(one) === ruleText(read))) rules.push(read)
  }
  return { rules, refused }
}

/** An entry as it is shown and reported: `private:*.example.com:8443`. */
export function ruleText(rule: HostRule): string {
  const host = rule.host.includes(':') ? `[${rule.host}]` : rule.host
  return `${rule.isPrivate ? 'private:' : ''}${rule.suffix ? '*.' : ''}${host}${rule.port === null ? '' : `:${rule.port}`}`
}

/**
 * The rule a request to `host:port` passes by, or null. The proxy's own source (below) decides the same way: a name
 * matches its entry exactly or, for `*.example.com`, any name under it; an entry with no port allows 443 and 80.
 */
export function allows(rules: readonly HostRule[], host: string, port: number): HostRule | null {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return rules.find(rule => (rule.suffix ? name.endsWith(`.${rule.host}`) : name === rule.host) && (rule.port === null ? port === 443 || port === 80 : port === rule.port)) ?? null
}

/** The variables a boxed command is given so that HTTP clients go through the proxy (the computer itself stays direct). */
export function proxyEnvironment(port: number): string[] {
  const url = `http://127.0.0.1:${port}`
  const direct = 'localhost,127.0.0.1,::1,.localhost'
  return [
    `HTTP_PROXY=${url}`, `HTTPS_PROXY=${url}`, `http_proxy=${url}`, `https_proxy=${url}`, `ALL_PROXY=${url}`,
    `NO_PROXY=${direct}`, `no_proxy=${direct}`,
    `npm_config_proxy=${url}`, `npm_config_https_proxy=${url}`, `YARN_HTTP_PROXY=${url}`, `YARN_HTTPS_PROXY=${url}`,
    'NODE_USE_ENV_PROXY=1',
  ]
}

/**
 * The proxy, as the source `node -e` runs (CommonJS, no dependencies). Its arguments after `--`: the rules as JSON, where
 * to listen ("tcp" for 127.0.0.1 on a port the system picks, else a Unix socket's path), a file it notes each refusal
 * in, and how long it may live in milliseconds. It prints `ready <port or socket> <pid>` once it listens.
 */
export function proxySource(): string {
  return String.raw`
const http = require('http'), net = require('net'), dns = require('dns').promises, fs = require('fs');
const [rulesJson, listen, logFile, lifeMs] = process.argv.slice(1);
const rules = JSON.parse(rulesJson || '[]');
const isPrivate = (ip) => { const a = String(ip).toLowerCase().replace(/^::ffff:/, ''); return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || a === '::1' || a === '::' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a); };
const match = (host, port) => { const n = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); return rules.find((r) => (r.suffix ? n.endsWith('.' + r.host) : n === r.host) && (r.port === null ? port === 443 || port === 80 : port === r.port)) || null; };
const refused = new Set();
const note = (host, port, why) => { const line = host + ':' + port + ' ' + why; if (refused.has(line) || refused.size >= 200) return; refused.add(line); try { fs.appendFileSync(logFile, line + '\n'); } catch {} };
async function target(host, port) {
  const rule = match(host, port);
  if (!rule) return { refuse: 'not on this run\'s list of allowed hosts' };
  const bare = String(host).replace(/^\[|\]$/g, '');
  const found = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true }).catch(() => []);
  const usable = found.filter((a) => rule.isPrivate || !isPrivate(a.address));
  return usable.length ? { address: usable[0].address } : { refuse: found.length ? 'it resolves to a private address' : 'it does not resolve' };
}
const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url); } catch { res.writeHead(400); return res.end('This is a proxy.\n'); }
  if (url.protocol !== 'http:') { res.writeHead(400); return res.end('Only http:// goes through as a plain request; https uses CONNECT.\n'); }
  const port = Number(url.port || 80);
  const to = await target(url.hostname, port);
  if (to.refuse) { note(url.hostname, port, to.refuse); res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('CodeBook proof run: ' + url.hostname + ':' + port + ' is not reachable: ' + to.refuse + '.\n'); }
  const headers = { ...req.headers }; delete headers['proxy-connection']; delete headers['proxy-authorization'];
  const out = http.request({ host: to.address, port, method: req.method, path: url.pathname + url.search, headers: { ...headers, host: url.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  out.on('error', () => { try { res.writeHead(502); } catch {} res.end(); });
  req.pipe(out);
});
server.on('connect', async (req, socket, head) => {
  socket.on('error', () => {});
  const at = String(req.url || ''), colon = at.lastIndexOf(':');
  const host = colon > 0 ? at.slice(0, colon) : at, port = Number(colon > 0 ? at.slice(colon + 1) : 443);
  const to = await target(host, port);
  if (to.refuse) { note(host, port, to.refuse); socket.write('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nCodeBook proof run: ' + host + ':' + port + ' is not reachable: ' + to.refuse + '.\n'); return socket.destroy(); }
  const up = net.connect(port, to.address, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(socket); socket.pipe(up); });
  up.on('error', () => socket.destroy()); socket.on('close', () => up.destroy());
});
server.on('clientError', (err, socket) => socket.destroy());
setTimeout(() => process.exit(0), Math.max(1000, Number(lifeMs) || 3600000));
const ready = () => { const where = listen === 'tcp' ? server.address().port : listen; process.stdout.write('ready ' + where + ' ' + process.pid + '\n'); };
if (listen === 'tcp') server.listen(0, '127.0.0.1', ready);
else { try { fs.rmSync(listen, { force: true }); } catch {} server.listen(listen, ready); }
`
}

/**
 * The forwarder a Linux box runs (inside its own network namespace): it listens on 127.0.0.1:3128, passes each
 * connection to the proxy's Unix socket, and once it listens starts the command (its arguments after the socket) and
 * exits with the command's code. Contains no single quote.
 */
export function forwarderSource(): string {
  return String.raw`
const net = require("net"), cp = require("child_process");
const [socketPath, ...command] = process.argv.slice(1);
const start = () => { const child = cp.spawn(command[0], command.slice(1), { stdio: "inherit" }); child.on("exit", (code, signal) => process.exit(code === null ? 1 : code)); child.on("error", () => process.exit(127)); };
const server = net.createServer((c) => { const up = net.connect(socketPath); c.pipe(up); up.pipe(c); up.on("error", () => c.destroy()); c.on("error", () => up.destroy()); });
server.on("error", start);
server.listen(${FORWARD_PORT}, "127.0.0.1", start);
`
}
