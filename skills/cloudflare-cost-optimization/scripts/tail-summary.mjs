#!/usr/bin/env node
// Samples live requests with `wrangler tail` for a fixed time and summarizes where
// the CPU goes: by route, by client, and how many URLs repeat (i.e. could hit a cache).
// Zero dependencies, Node 18+, works on macOS, Linux and Windows.
//
//   node tail-summary.mjs <worker-name> [--seconds 300] [--env production] [--top 15]
//   node tail-summary.mjs --file saved-tail.json          # summarize an earlier capture
//   add --save capture.json to keep the raw events (they contain IPs and headers: keep private)
//
// Run it from the project directory so `npx wrangler` uses the project's wrangler.
// The summary never prints IPs, cookies or query strings.

import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const file = flag('file')
const worker = args[0] && !args[0].startsWith('--') ? args[0] : null
const seconds = Number(flag('seconds', 300))
const top = Number(flag('top', 15))
if (!file && !worker) {
  console.error('Usage: node tail-summary.mjs <worker-name> [--seconds 300] [--env production] [--save file]\n       node tail-summary.mjs --file capture.json')
  process.exit(1)
}

// wrangler tail prints pretty-printed JSON objects back to back; split them by brace depth.
function jsonObjects(text) {
  const out = []
  let depth = 0, start = -1, inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue }
    if (c === '"') inString = true
    else if (c === '{') { if (depth++ === 0) start = i }
    else if (c === '}' && depth > 0 && --depth === 0) { try { out.push(JSON.parse(text.slice(start, i + 1))) } catch { /* partial line */ } }
  }
  return out
}

function capture() {
  return new Promise((resolve) => {
    const tailArgs = ['wrangler', 'tail', worker, '--format', 'json']
    const env = flag('env'); if (env) tailArgs.push('--env', env)
    const win = process.platform === 'win32'
    const child = spawn(win ? 'npx.cmd' : 'npx', tailArgs, { shell: win, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] })
    let raw = '', errText = ''
    child.stdout.on('data', (d) => { raw += d })
    child.stderr.on('data', (d) => { errText += d })
    console.error(`Sampling ${worker} for ${seconds}s ...`)
    const stop = () => {
      try {
        if (win) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' })
        else process.kill(-child.pid, 'SIGTERM') // whole group: npx + wrangler
      } catch { /* already gone */ }
    }
    const timer = setTimeout(stop, seconds * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      if (!raw.trim() && errText.trim()) console.error(errText.trim().split('\n').slice(-5).join('\n'))
      resolve(raw)
    })
  })
}

const raw = file ? readFileSync(file, 'utf8') : await capture()
if (flag('save')) writeFileSync(flag('save'), raw)
const events = jsonObjects(raw).filter((e) => e.event?.request?.url)
if (!events.length) { console.log('No request events captured. Check the worker name, login, and that it receives traffic.'); process.exit(0) }

// ---------- classify ----------
// Group by the first N path segments (default 1): /articles/x-1 and /articles/x-2 -> /articles/*.
// Use --depth 2 to split e.g. /api/auth/* from /api/visitors/*.
const depth = Math.max(1, Number(flag('depth', 1)))
function route(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean)
  if (!parts.length) return '/'
  const kept = parts.slice(0, depth)
  return '/' + kept.join('/') + (parts.length > depth ? '/*' : '')
}
function client(e) {
  const h = e.event.request.headers || {}
  const cf = e.event.request.cf || {}
  const ua = h['user-agent'] || ''
  const bot = cf.verifiedBotCategory || cf.botManagement?.verifiedBot && 'verified bot'
  const named = ua.match(/([A-Za-z][\w.-]*(?:bot|crawler|spider|preview|fetcher)[\w.-]*)/i)?.[1] || h['signature-agent']?.replace(/["']|https?:\/\//g, '')
  if (bot) return `verified: ${named || bot}`
  if (named) return `self-declared: ${named}`
  if (/Mozilla|Chrome|Safari|Firefox/.test(ua)) return 'browser-like UA'
  return ua ? `other: ${ua.slice(0, 30)}` : 'no UA'
}
const network = (e) => { const cf = e.event.request.cf || {}; return `${cf.country || '?'} ${String(cf.asOrganization || cf.asn || '?').slice(0, 30)}` }

function group(keyOf) {
  const g = new Map()
  for (const e of events) {
    const k = keyOf(e)
    const v = g.get(k) || { n: 0, cpu: 0, urls: new Set() }
    v.n++; v.cpu += e.cpuTime || 0; v.urls.add(new URL(e.event.request.url).pathname)
    g.set(k, v)
  }
  return [...g.entries()].sort((a, b) => b[1].cpu - a[1].cpu)
}
const totalCpu = events.reduce((s, e) => s + (e.cpuTime || 0), 0)
const span = (Math.max(...events.map((e) => e.eventTimestamp)) - Math.min(...events.map((e) => e.eventTimestamp))) / 1000
function print(title, rows, showUnique) {
  console.log(`\n${title}`)
  const head = ['key', 'requests', 'cpuMs', 'share', 'avgMs'].concat(showUnique ? ['uniquePaths'] : [])
  const lines = rows.slice(0, top).map(([k, v]) => [k, v.n, v.cpu, `${Math.round((v.cpu / Math.max(1, totalCpu)) * 100)}%`, (v.cpu / v.n).toFixed(1)].concat(showUnique ? [`${v.urls.size}/${v.n}`] : []))
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)))
  console.log('  ' + head.map((h, i) => h.padEnd(widths[i])).join('  '))
  for (const l of lines) console.log('  ' + l.map((c, i) => (i ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  '))
}

const outcomes = {}
for (const e of events) outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1
console.log(`${events.length} requests over ${span.toFixed(0)}s, ${totalCpu} CPU ms in total. Outcomes: ${JSON.stringify(outcomes)}`)
console.log('Small samples only show proportions; do not extrapolate exact monthly numbers from them.')
print('By route (uniquePaths close to requests = little repetition, so a page cache helps little)', group((e) => route(e.event.request.url)), true)
print('By client (user agents can be faked; only "verified" comes from Cloudflare)', group(client), false)
print('By network (country + AS organization; many residential networks on one route can mean a distributed scraper)', group(network), false)
console.log('\nMost expensive single requests (path only)')
for (const e of [...events].sort((a, b) => (b.cpuTime || 0) - (a.cpuTime || 0)).slice(0, Math.min(top, 10))) {
  console.log(`  ${String(e.cpuTime).padStart(5)} ms  ${new URL(e.event.request.url).pathname}  [${client(e)}]`)
}
