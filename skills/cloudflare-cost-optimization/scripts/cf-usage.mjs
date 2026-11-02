#!/usr/bin/env node
// Read-only usage pull from the Cloudflare GraphQL Analytics API.
// Zero dependencies, Node 18+, works on macOS, Linux and Windows.
//
//   node cf-usage.mjs usage  [--since 2026-01-13] [--until 2026-02-12] [--account <id>] [--json]
//   node cf-usage.mjs worker <script-name> [--since ...] [--hours 48] [--json]
//
// Token: CLOUDFLARE_API_TOKEN (needs Account Analytics Read), otherwise the OAuth
// token that `wrangler login` stored on this machine. Nothing is written anywhere.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const API = 'https://api.cloudflare.com/client/v4'
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(`--${name}`)
const command = args[0]
const fail = (message) => { console.error(message); process.exit(1) }

if (!['usage', 'worker'].includes(command)) {
  fail('Usage:\n  node cf-usage.mjs usage  [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--account ID] [--json]\n  node cf-usage.mjs worker <script> [--since YYYY-MM-DD] [--hours 48] [--json]')
}

// ---------- network: honour HTTPS_PROXY where Node's fetch does not ----------
async function useProxyIfSet() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!proxy || process.env.NODE_USE_ENV_PROXY === '1') return
  // undici ships with wrangler, so it is usually present in a Cloudflare project.
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    const { ProxyAgent, setGlobalDispatcher } = require('undici')
    setGlobalDispatcher(new ProxyAgent(proxy))
  } catch {
    console.error(`[warn] HTTPS_PROXY is set but undici was not found from ${process.cwd()}.\n` +
      '       Run this from a project that has wrangler installed, or use Node 24+ with NODE_USE_ENV_PROXY=1.')
  }
}

// ---------- token ----------
function wranglerConfigCandidates() {
  const home = homedir()
  const list = [join(home, '.wrangler', 'config', 'default.toml')] // legacy location, still used when it exists
  if (process.platform === 'darwin') list.push(join(home, 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'))
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    list.push(join(appData, 'xdg.config', '.wrangler', 'config', 'default.toml'), join(appData, '.wrangler', 'config', 'default.toml'))
  }
  list.push(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), '.wrangler', 'config', 'default.toml'))
  return list
}

function resolveToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, source: 'CLOUDFLARE_API_TOKEN' }
  for (const file of wranglerConfigCandidates()) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const token = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1]
    const expires = text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1]
    if (!token) continue
    if (expires && Date.parse(expires) < Date.now() + 60_000) {
      fail(`The wrangler login token in ${file} has expired.\nRun \`npx wrangler whoami\` once (it refreshes the token), then try again.`)
    }
    return { token, source: 'wrangler login' }
  }
  fail('No token found. Set CLOUDFLARE_API_TOKEN (Account Analytics Read) or run `npx wrangler login`.')
}

const { token, source } = resolveToken()
await useProxyIfSet()

async function api(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !body.data) fail(`HTTP ${res.status} ${path}: ${JSON.stringify(body.errors || body).slice(0, 400)}`)
  return body
}

async function graphql(query) {
  const body = await api('/graphql', { method: 'POST', body: JSON.stringify({ query }) })
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join('; ')
    if (/budget|rate limit/i.test(msg)) fail(`GraphQL rate limit hit: ${msg}\nWait about 5 minutes; combine queries instead of sending many small ones.`)
    fail(`GraphQL error: ${msg}`)
  }
  return body.data.viewer.accounts[0] || {}
}

async function resolveAccount() {
  const id = flag('account', process.env.CLOUDFLARE_ACCOUNT_ID)
  if (id) return id
  const { result = [] } = await api('/accounts?per_page=50')
  if (result.length === 1) return result[0].id
  fail(`This login can see ${result.length} accounts; pass --account <id>:\n` + result.map((a) => `  ${a.id}  ${a.name}`).join('\n'))
}

// ---------- helpers ----------
const day = (d) => d.toISOString().slice(0, 10)
const now = new Date()
const since = flag('since', day(new Date(now.getTime() - 29 * 86400_000)))
const until = flag('until', day(now))
const sinceTime = `${since}T00:00:00Z`
const untilTime = new Date(Math.min(Date.parse(`${until}T23:59:59Z`), now.getTime())).toISOString()
const n = (v) => Math.round(v).toLocaleString('en-US')
const table = (rows, columns) => {
  if (!rows.length) return console.log('  (none)')
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  console.log('  ' + columns.map((c, i) => c.padEnd(widths[i])).join('  '))
  for (const r of rows) console.log('  ' + columns.map((c, i) => (i ? String(r[c] ?? '').padStart(widths[i]) : String(r[c] ?? '').padEnd(widths[i]))).join('  '))
}

// R2 operation classes (check the R2 pricing page if a new action shows up as "other").
const R2_CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'UploadPart', 'UploadPartCopy', 'ListMultipartUploads', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration', 'LifecycleStorageTierTransition'])
const R2_CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration'])
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'])
const r2Class = (action) => R2_CLASS_A.has(action) ? 'A' : R2_CLASS_B.has(action) ? 'B' : R2_FREE.has(action) ? 'free' : 'other'

// ---------- commands ----------
async function usage(account) {
  const recentDay = day(new Date(now.getTime() - 86400_000))
  const data = await graphql(`{ viewer { accounts(filter:{accountTag:"${account}"}) {
    workers: workersInvocationsAdaptive(limit:1000, filter:{datetime_geq:"${sinceTime}", datetime_leq:"${untilTime}"}) {
      sum { requests errors subrequests cpuTimeUs } dimensions { scriptName } }
    d1: d1AnalyticsAdaptiveGroups(limit:1000, filter:{date_geq:"${since}", date_leq:"${until}"}) {
      sum { rowsRead rowsWritten readQueries writeQueries } dimensions { databaseId } }
    d1Storage: d1StorageAdaptiveGroups(limit:1000, filter:{date_geq:"${recentDay}", date_leq:"${until}"}) {
      max { databaseSizeBytes } dimensions { databaseId } }
    r2Ops: r2OperationsAdaptiveGroups(limit:5000, filter:{datetime_geq:"${sinceTime}", datetime_leq:"${untilTime}"}) {
      sum { requests } dimensions { actionType bucketName } }
    r2Storage: r2StorageAdaptiveGroups(limit:1000, filter:{datetime_geq:"${recentDay}T00:00:00Z", datetime_leq:"${untilTime}"}) {
      max { payloadSize metadataSize objectCount } dimensions { bucketName } }
    kv: kvOperationsAdaptiveGroups(limit:1000, filter:{date_geq:"${since}", date_leq:"${until}"}) {
      sum { requests } dimensions { actionType } }
  } } }`)

  const names = {}
  try { for (const db of (await api(`/accounts/${account}/d1/database?per_page=100`)).result || []) names[db.uuid] = db.name } catch { /* names are optional */ }

  const workers = (data.workers || []).map((r) => ({ script: r.dimensions.scriptName, requests: r.sum.requests, errors: r.sum.errors, cpuMs: r.sum.cpuTimeUs / 1000 }))
    .sort((a, b) => b.cpuMs - a.cpuMs)
  const d1 = (data.d1 || []).map((r) => ({ database: names[r.dimensions.databaseId] || r.dimensions.databaseId, ...r.sum })).sort((a, b) => b.rowsRead - a.rowsRead)
  const d1Size = {}
  for (const r of data.d1Storage || []) d1Size[r.dimensions.databaseId] = Math.max(d1Size[r.dimensions.databaseId] || 0, r.max.databaseSizeBytes)
  const r2 = {}
  for (const r of data.r2Ops || []) {
    const b = (r2[r.dimensions.bucketName || '(account)'] ??= { A: 0, B: 0, free: 0, other: 0 })
    b[r2Class(r.dimensions.actionType)] += r.sum.requests
  }
  const r2Storage = (data.r2Storage || []).map((r) => ({ bucket: r.dimensions.bucketName, bytes: r.max.payloadSize + r.max.metadataSize, objects: r.max.objectCount }))
  const kv = Object.fromEntries((data.kv || []).map((r) => [r.dimensions.actionType, r.sum.requests]))
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0)
  const totals = {
    workerRequests: sum(workers, 'requests'), workerCpuMs: sum(workers, 'cpuMs'),
    d1RowsRead: sum(d1, 'rowsRead'), d1RowsWritten: sum(d1, 'rowsWritten'), d1StorageBytes: Object.values(d1Size).reduce((s, v) => s + v, 0),
    r2ClassA: Object.values(r2).reduce((s, b) => s + b.A, 0), r2ClassB: Object.values(r2).reduce((s, b) => s + b.B, 0),
    r2StorageBytes: sum(r2Storage, 'bytes'), kv,
  }
  if (has('json')) return console.log(JSON.stringify({ since, until: untilTime, tokenSource: source, totals, workers, d1, r2, r2Storage }, null, 2))

  console.log(`Range ${since} → ${untilTime} (token: ${source}). Compare totals with the included amounts on the current pricing pages.\n`)
  console.log('Totals'); table([
    { item: 'Workers requests', used: n(totals.workerRequests) }, { item: 'Workers CPU ms', used: n(totals.workerCpuMs) },
    { item: 'D1 rows read', used: n(totals.d1RowsRead) }, { item: 'D1 rows written', used: n(totals.d1RowsWritten) },
    { item: 'D1 storage MB (latest)', used: (totals.d1StorageBytes / 1e6).toFixed(1) },
    { item: 'R2 Class A ops', used: n(totals.r2ClassA) }, { item: 'R2 Class B ops', used: n(totals.r2ClassB) },
    { item: 'R2 storage GB (latest)', used: (totals.r2StorageBytes / 1e9).toFixed(2) },
    ...Object.entries(kv).map(([k, v]) => ({ item: `KV ${k}`, used: n(v) })),
  ], ['item', 'used'])
  console.log('\nWorkers by CPU'); table(workers.map((w) => ({ script: w.script, requests: n(w.requests), errors: n(w.errors), cpuMs: n(w.cpuMs), 'ms/req': (w.cpuMs / Math.max(1, w.requests)).toFixed(1), share: `${((w.cpuMs / Math.max(1, totals.workerCpuMs)) * 100).toFixed(0)}%` })), ['script', 'requests', 'errors', 'cpuMs', 'ms/req', 'share'])
  console.log('\nD1 by rows read'); table(d1.map((r) => ({ database: r.database, rowsRead: n(r.rowsRead), rowsWritten: n(r.rowsWritten), readQueries: n(r.readQueries), writeQueries: n(r.writeQueries) })), ['database', 'rowsRead', 'rowsWritten', 'readQueries', 'writeQueries'])
  console.log('\nR2 operations by bucket'); table(Object.entries(r2).map(([bucket, b]) => ({ bucket, classA: n(b.A), classB: n(b.B), free: n(b.free), other: n(b.other) })), ['bucket', 'classA', 'classB', 'free', 'other'])
  console.log('\nR2 storage'); table(r2Storage.sort((a, b) => b.bytes - a.bytes).map((r) => ({ bucket: r.bucket, GB: (r.bytes / 1e9).toFixed(3), objects: n(r.objects) })), ['bucket', 'GB', 'objects'])
}

async function worker(account, script) {
  if (!script) fail('Usage: node cf-usage.mjs worker <script-name>')
  const hours = Number(flag('hours', 48))
  const hourSince = new Date(now.getTime() - hours * 3600_000).toISOString()
  const filter = (from, to) => `{scriptName:"${script}", datetime_geq:"${from}", datetime_leq:"${to}"}`
  const data = await graphql(`{ viewer { accounts(filter:{accountTag:"${account}"}) {
    daily: workersInvocationsAdaptive(limit:1000, orderBy:[date_ASC], filter:${filter(sinceTime, untilTime)}) {
      sum { requests errors subrequests cpuTimeUs } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { date } }
    versions: workersInvocationsAdaptive(limit:2000, filter:${filter(sinceTime, untilTime)}) {
      sum { requests cpuTimeUs } dimensions { scriptVersion date } }
    status: workersInvocationsAdaptive(limit:50, filter:${filter(sinceTime, untilTime)}) {
      sum { requests cpuTimeUs } dimensions { status } }
    hourly: workersInvocationsAdaptive(limit:1000, orderBy:[datetimeHour_ASC], filter:${filter(hourSince, untilTime)}) {
      sum { requests cpuTimeUs } dimensions { datetimeHour } }
  } } }`)

  const daily = (data.daily || []).map((r) => ({ date: r.dimensions.date, requests: r.sum.requests, errors: r.sum.errors, cpuMs: r.sum.cpuTimeUs / 1000, p50Ms: r.quantiles.cpuTimeP50 / 1000, p99Ms: r.quantiles.cpuTimeP99 / 1000 }))
  const versions = {}
  for (const r of data.versions || []) {
    const v = (versions[r.dimensions.scriptVersion] ??= { first: r.dimensions.date, last: r.dimensions.date, requests: 0, cpuMs: 0 })
    v.first = r.dimensions.date < v.first ? r.dimensions.date : v.first
    v.last = r.dimensions.date > v.last ? r.dimensions.date : v.last
    v.requests += r.sum.requests; v.cpuMs += r.sum.cpuTimeUs / 1000
  }
  const status = (data.status || []).map((r) => ({ status: r.dimensions.status, requests: r.sum.requests, cpuMs: r.sum.cpuTimeUs / 1000 }))
  const hourly = (data.hourly || []).map((r) => ({ hour: r.dimensions.datetimeHour, requests: r.sum.requests, cpuMs: r.sum.cpuTimeUs / 1000 }))
  if (has('json')) return console.log(JSON.stringify({ script, since, until: untilTime, daily, versions, status, hourly }, null, 2))

  console.log(`${script}: ${since} → ${untilTime} (token: ${source}). Dates and hours are UTC.\n`)
  console.log('By day'); table(daily.map((d) => ({ date: d.date, requests: n(d.requests), errors: n(d.errors), cpuMs: n(d.cpuMs), 'ms/req': (d.cpuMs / Math.max(1, d.requests)).toFixed(1), p50Ms: d.p50Ms.toFixed(1), p99Ms: d.p99Ms.toFixed(0) })), ['date', 'requests', 'errors', 'cpuMs', 'ms/req', 'p50Ms', 'p99Ms'])
  console.log('\nBy deployed version (a jump in ms/req after a deploy points at that release)')
  table(Object.entries(versions).sort((a, b) => a[1].first.localeCompare(b[1].first)).filter(([, v]) => v.requests >= 100).map(([id, v]) => ({ version: id.slice(0, 8), from: v.first, to: v.last, requests: n(v.requests), 'ms/req': (v.cpuMs / Math.max(1, v.requests)).toFixed(1) })), ['version', 'from', 'to', 'requests', 'ms/req'])
  console.log('\nBy outcome'); table(status.map((s) => ({ status: s.status, requests: n(s.requests), cpuMs: n(s.cpuMs) })), ['status', 'requests', 'cpuMs'])
  console.log(`\nLast ${hours} hours (flat CPU with changing requests = a steady background load, e.g. crawlers on uncached pages)`)
  table(hourly.map((h) => ({ hour: h.hour.slice(5, 13), requests: n(h.requests), cpuMs: n(h.cpuMs) })), ['hour', 'requests', 'cpuMs'])
}

const account = await resolveAccount()
if (command === 'usage') await usage(account)
else await worker(account, args[1])
