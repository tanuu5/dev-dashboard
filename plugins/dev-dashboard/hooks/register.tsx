import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dashboard, MemoryFile, Push, RepoInfo, RepoState, ServiceStatus } from '../types'

// Claude Code のホーム画面には描けないので、セッションの横にダッシュボードのパネルを出す。
// 中身：Claude の稼働状況（status.claude.com）、GitHub への最近のプッシュ（コミットメッセージ付き）、
// ローカルのプッシュ待ち・未コミット（あるときだけ）。

const PANE = 'dev-dashboard'
const TITLE = 'ダッシュボード'
const REFRESH_MS = 5 * 60 * 1000
const SHOW_COMPONENTS = ['claude.ai', 'Claude API', 'Claude Code']
const PUSH_COUNT = 10
const MESSAGES_PER_PUSH = 3

const data = atom({ plugin: 'dev-dashboard', key: 'data' } as const, null)
const isLoading = atom({ plugin: 'dev-dashboard', key: 'isLoading' } as const, false)
const isOpen = atom({ plugin: 'dev-dashboard', key: 'isOpen' } as const, false)
// 畳んでいるセクションの id。$.store にも置き、次のセッションでも同じ畳み方にする
const collapsed = atom({ plugin: 'dev-dashboard', key: 'collapsed' } as const, [])
const COLLAPSED_KEY = 'collapsed'

type Api = EngineInterface


async function run($: Api, argv: string[], opts: { cwd?: string; anyExit?: boolean } = {}) {
  try {
    const r = await $.process.run(argv, { cwd: opts.cwd, timeoutMs: 15000 })
    return r.exitCode === 0 || opts.anyExit ? (r.stdout as string) : null
  } catch {
    return null
  }
}

// デスクトップのプロセスは PATH に Homebrew が無いことがあるので、順に試す
let ghBin: string | null = null
async function gh($: Api, args: string[]) {
  for (const bin of ghBin ? [ghBin] : ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    const out = await run($, [bin, ...args])
    if (out !== null) {
      ghBin = bin
      return out
    }
  }
  return null
}

async function fetchJson($: Api, url: string) {
  const r = await $.http.fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return JSON.parse(r.text)
}

async function collectStatus($: Api): Promise<ServiceStatus> {
  const s = await fetchJson($, 'https://status.claude.com/api/v2/summary.json')
  return {
    indicator: s.status.indicator,
    description: s.status.description,
    components: (s.components as any[])
      .filter(c => !c.group && SHOW_COMPONENTS.some(n => c.name.startsWith(n)))
      .map(c => ({ name: c.name.replace(/ \(.*\)$/, ''), status: c.status })),
    incidents: [
      ...(s.incidents as any[]),
      ...((s.scheduled_maintenances as any[]) ?? []).filter(m => m.status === 'in_progress'),
    ].map(i => ({
      name: i.name,
      status: i.status,
      url: i.shortlink ?? `https://status.claude.com/incidents/${i.id}`,
      updatedAt: i.updated_at,
    })),
  }
}

async function collectRepo($: Api, dir: string): Promise<RepoState | null> {
  const [st, remotes] = await Promise.all([
    run($, ['git', '-C', dir, 'status', '--porcelain=v1', '-b']),
    run($, ['git', '-C', dir, 'remote']),
  ])
  if (st === null) return null
  const lines = st.split('\n').filter(Boolean)
  const head = lines[0] ?? ''
  return {
    name: dir.split('/').pop() ?? dir,
    branch: head.replace(/^## /, '').replace(/^No commits yet on /, '').split(/\.\.\.| /)[0] ?? '',
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
    dirty: lines.length - 1,
    hasUpstream: head.includes('...'),
    hasRemote: (remotes ?? '').trim().length > 0,
  }
}

async function collectRepos($: Api) {
  const home = (await $.env.get('HOME')) as string
  // find は読めないフォルダが一つでもあると終了コード 1 を返すので、出力はそのまま使う
  const found = await run($, ['find', home, '-maxdepth', '2', '-name', '.git', '-not', '-path', `${home}/Library/*`], {
    anyExit: true,
  })
  const dirs = (found ?? '').split('\n').filter(Boolean).map(p => p.replace(/\/\.git$/, ''))
  if (dirs.length === 0) throw new Error('git リポジトリが見つからない')
  return (await Promise.all(dirs.map(d => collectRepo($, d)))).filter(r => r !== null)
}

type PushDetail = { count: number; messages: string[] }

// プッシュの中身はあとから変わらないので、push_id ごとに覚えておく（再読み込みで消えてよい）
const pushDetails = new Map<string, PushDetail>()

async function pushDetail($: Api, repo: string, before: string, head: string): Promise<PushDetail> {
  // 新しいブランチ（before が 0 だけ）は比較できないので、先頭のコミットだけ見る
  if (/^0+$/.test(before)) {
    const msg = await gh($, ['api', `repos/${repo}/commits/${head}`, '--jq', '.commit.message'])
    return { count: 1, messages: msg ? [msg.split('\n')[0] ?? ''] : [] }
  }
  const out = await gh($, [
    'api',
    `repos/${repo}/compare/${before}...${head}`,
    '--jq',
    '{n: .total_commits, m: [.commits[].commit.message | split("\n")[0]]}',
  ])
  if (out === null) return { count: 0, messages: [] }
  const { n, m } = JSON.parse(out)
  return { count: n, messages: (m as string[]).reverse() }
}

// ---- イベント API の遅れを補う ----
// users/<login>/events は反映が数十秒〜数時間遅れることがあり、直前のプッシュが出てこない。
// リポジトリの pushed_at はすぐ変わるので、それが最新のイベントより新しいリポジトリは、
// 既定のブランチのコミットを新しい順に読み、イベントに載っている先頭（payload.head）の手前までを 1 回のプッシュとして足す。
const LAG_REPOS = 10
// イベントの遅れはこれ以内。これより古いプッシュはイベントに載っているはず
const LAG_WINDOW_MS = 6 * 60 * 60 * 1000
// pushed_at とイベントの時刻のずれの許し
const LAG_SLACK_MS = 30 * 1000

// GitHub の自分のリポジトリ（最後にプッシュした順）。プッシュの補いとリポジトリの欄の両方で使う
type RepoPushed = { name: string; pushedAt: string; branch: string; url: string; isPrivate: boolean; isArchived: boolean; language: string | null }

async function fetchOwnRepos($: Api): Promise<RepoPushed[]> {
  const out = await gh($, [
    'api',
    'user/repos?affiliation=owner&sort=pushed&per_page=100',
    '--jq',
    '[.[] | {name: .full_name, pushedAt: .pushed_at, branch: .default_branch, url: .html_url, isPrivate: .private, isArchived: .archived, language: .language}]',
  ])
  if (out === null) throw new Error('リポジトリの一覧を取得できず')
  return JSON.parse(out) as RepoPushed[]
}
type CommitLine = { sha: string; date: string; message: string }

// イベントにまだ載っていないコミット（新しい順）。イベントに載っている先頭まで来たら止める
export function unreportedCommits(commits: readonly CommitLine[], reportedHead: string | undefined, pushedAt: number): CommitLine[] {
  const fresh: CommitLine[] = []
  for (const c of commits) {
    if (c.sha === reportedHead) break
    // そのリポジトリのイベントが一つも無いときは、遅れの幅より古いコミットまでは遡らない
    if (reportedHead === undefined && Date.parse(c.date) < pushedAt - LAG_WINDOW_MS) break
    fresh.push(c)
  }
  return fresh
}

async function collectLaggingPushes($: Api, pushEvents: readonly any[], now: number, ownRepos: readonly RepoPushed[]): Promise<Push[]> {
  const latest = new Map<string, any>()
  for (const ev of pushEvents) {
    const cur = latest.get(ev.repo.name)
    if (!cur || Date.parse(ev.created_at) > Date.parse(cur.created_at)) latest.set(ev.repo.name, ev)
  }
  const pushes = await Promise.all(
    ownRepos.slice(0, LAG_REPOS).map(async (repo): Promise<Push | null> => {
      const pushedAt = Date.parse(repo.pushedAt)
      const ev = latest.get(repo.name)
      if (now - pushedAt > LAG_WINDOW_MS) return null
      if (ev && Date.parse(ev.created_at) >= pushedAt - LAG_SLACK_MS) return null
      const commitsOut = await gh($, [
        'api',
        `repos/${repo.name}/commits?sha=${encodeURIComponent(repo.branch)}&per_page=10`,
        '--jq',
        '[.[] | {sha, date: .commit.committer.date, message: (.commit.message | split("\n")[0])}]',
      ])
      if (commitsOut === null) return null
      const fresh = unreportedCommits(JSON.parse(commitsOut) as CommitLine[], ev?.payload?.head, pushedAt)
      if (fresh.length === 0) return null
      return {
        id: `${repo.name}@${repo.pushedAt}`,
        repo: repo.name,
        time: pushedAt,
        branch: repo.branch,
        count: fresh.length,
        messages: fresh.map(c => c.message),
      }
    }),
  )
  return pushes.filter(p => p !== null)
}

async function collectPushes($: Api, ownRepos: readonly RepoPushed[]): Promise<Push[]> {
  const login = (await gh($, ['api', 'user', '--jq', '.login']))?.trim()
  if (!login) throw new Error('gh にログインしていないか、gh が見つからない')
  const out = await gh($, ['api', `users/${login}/events?per_page=100`])
  if (out === null) throw new Error('GitHub のイベントを取得できず')
  const pushEvents = (JSON.parse(out) as any[]).filter(ev => ev.type === 'PushEvent')
  const lagging = await collectLaggingPushes($, pushEvents, Date.now(), ownRepos).catch(() => [] as Push[])
  const events = [...pushEvents]
    // イベントの並びは時刻順とは限らない（ID 順で、反映が遅れたものが前後する）ので並べ直す
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, PUSH_COUNT)
  const fromEvents = await Promise.all(
    events.map(async (ev): Promise<Push> => {
      const id = String(ev.payload.push_id ?? ev.id)
      let detail = pushDetails.get(id)
      if (!detail) {
        const fresh: PushDetail = await pushDetail($, ev.repo.name, ev.payload.before, ev.payload.head).catch(() => ({
          count: 0,
          messages: [],
        }))
        if (fresh.messages.length > 0) pushDetails.set(id, fresh)
        detail = fresh
      }
      return {
        id,
        repo: ev.repo.name,
        time: Date.parse(ev.created_at),
        branch: String(ev.payload.ref ?? '').replace('refs/heads/', ''),
        ...detail,
      }
    }),
  )
  return [...lagging, ...fromEvents].sort((a, b) => b.time - a.time).slice(0, PUSH_COUNT)
}

// ---- リポジトリの欄 ----
// 名前のほかに、README の最初の見出しを添える（「しっぽ急便 — TAIL EXPRESS」のように日本語名が入っていることが多い）。
// README はプッシュしないと変わらないので、pushed_at ごとに $.store に覚え、変わったリポジトリだけ読み直す。
const TITLES_KEY = 'readmeTitles'
const TITLE_FETCH_PARALLEL = 6
type TitleCache = Record<string, { pushedAt: string; title: string | null }>

// 文字と数字だけを残して比べる（日本語は残す。絵文字・記号・空白・大小は無視）
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

// README の最初の見出し（# か <h1>）。リポジトリ名と同じ（記号・大小を除いて）なら添えない
export function readmeTitle(readme: string, repoName: string): string | null {
  let raw: string | undefined
  for (const line of readme.split('\n').slice(0, 40)) {
    raw = /^#\s+(.+)$/.exec(line.trim())?.[1] ?? /<h1[^>]*>(.*?)<\/h1>/i.exec(line)?.[1]
    if (raw !== undefined) break
  }
  if (raw === undefined) return null
  const title = raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]/g, '')
    .trim()
  if (title === '' || normalize(title) === normalize(repoName)) return null
  return title
}

async function collectRepoList($: Api, ownRepos: readonly RepoPushed[]): Promise<RepoInfo[]> {
  const cache = ((await $.store.get(TITLES_KEY)) ?? {}) as TitleCache
  const stale = ownRepos.filter(r => cache[r.name]?.pushedAt !== r.pushedAt)
  for (let i = 0; i < stale.length; i += TITLE_FETCH_PARALLEL) {
    await Promise.all(
      stale.slice(i, i + TITLE_FETCH_PARALLEL).map(async repo => {
        const readme = await gh($, ['api', `repos/${repo.name}/readme`, '-H', 'Accept: application/vnd.github.raw'])
        cache[repo.name] = { pushedAt: repo.pushedAt, title: readme === null ? null : readmeTitle(readme, repo.name.split('/').pop() ?? repo.name) }
      }),
    )
  }
  if (stale.length > 0) {
    const kept: TitleCache = {}
    for (const r of ownRepos) if (cache[r.name]) kept[r.name] = cache[r.name]!
    await $.store.set(TITLES_KEY, kept)
  }
  return ownRepos.map(r => ({
    fullName: r.name,
    url: r.url,
    pushedAt: Date.parse(r.pushedAt),
    isPrivate: r.isPrivate,
    isArchived: r.isArchived,
    language: r.language ?? null,
    title: cache[r.name]?.title ?? null,
  }))
}

// ---- 読み込んでいるメモリ ----
// /context の「Memory files」と同じ一覧（パス・どこのものか・トークン数）。計算は手元の見積もりで、通信はしない
async function collectMemory($: Api): Promise<MemoryFile[]> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  return (context.breakdown?.memoryFiles ?? []).map(f => ({ path: f.path, type: f.type, tokens: f.tokens }))
}

async function toggleSection($: Api, id: string) {
  const next = await update($, collapsed, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
  await $.store.set(COLLAPSED_KEY, next)
}

async function openPane($: Api) {
  await update($, isOpen, () => true)
  await $.ui.open({ id: PANE, title: TITLE })
  void refresh($)
}

async function refresh($: Api) {
  if (await read($, isLoading)) return
  await update($, isLoading, () => true)
  try {
    await collectAll($)
  } finally {
    await update($, isLoading, () => false)
  }
}

async function collectAll($: Api) {
  const errors: string[] = []
  const ownRepos = await fetchOwnRepos($).catch(err => (errors.push(`GitHub：${err.message ?? err}`), [] as RepoPushed[]))
  const [status, repos, pushes, repoList] = await Promise.all([
    collectStatus($).catch(err => (errors.push(`稼働状況：${err.message ?? err}`), null)),
    collectRepos($).catch(err => (errors.push(`ローカル：${err.message ?? err}`), [] as RepoState[])),
    collectPushes($, ownRepos).catch(err => (errors.push(`GitHub：${err.message ?? err}`), [] as Push[])),
    collectRepoList($, ownRepos).catch(err => (errors.push(`README：${err.message ?? err}`), [] as RepoInfo[])),
  ])
  const memoryFiles = await collectMemory($).catch(err => (errors.push(`メモリ：${err.message ?? err}`), [] as MemoryFile[]))
  const home = ((await $.env.get('HOME')) as string | undefined) ?? ''
  const next: Dashboard = { updatedAt: Date.now(), status, repos, pushes, repoList, memoryFiles, home, errors }
  await update($, data, () => next)
}

function ago(t: number) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (m < 1) return 'たった今'
  if (m < 60) return `${m}分前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}時間前`
  return `${Math.round(h / 24)}日前`
}

function esc(s: string) {
  return s.replace(/([\\`*_[\]|<>])/g, '\\$1')
}

const limit = (text: string) => text.slice(0, 9800)

const MEMORY_TYPE: Record<string, string> = {
  Managed: '組織',
  User: 'ユーザー全体',
  Project: 'プロジェクト',
  Local: 'ローカル',
  AutoMem: '自動メモリ',
}

function tokenText(n: number) {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`
}

// このセッションが読み込んでいる CLAUDE.md・ルール・自動メモリ。パスを押すとファイルが開く。
// ファイルへのリンク（file://）は Link では描けないので、この欄だけ Markdown で書く
export function memoryMarkdown(d: Dashboard): string {
  const out = d.memoryFiles.map(f => {
    const shown = d.home !== '' && f.path.startsWith(d.home) ? `~${f.path.slice(d.home.length)}` : f.path
    return `- ${MEMORY_TYPE[f.type] ?? esc(f.type)}　[${esc(shown)}](file://${encodeURI(f.path)})　${tokenText(f.tokens)} トークン`
  })
  if (out.length === 0) out.push('なし')
  return limit(out.join('\n'))
}

// ---- カード型の表示 ----
// 枠（角丸）と色で区切ったカードを縦に並べる。色はテーマの名前（success・warning など）で書き、ライトとダークの両方に合わせる。
// 大きさの単位は文字のマス。

type UI = { Box: any; Text: any; Button: any; Link: any; Markdown: any }

const TONE: Record<string, string> = { none: 'success', minor: 'warning', major: 'error', critical: 'error', maintenance: 'suggestion' }
const COMPONENT_TONE: Record<string, string> = {
  operational: 'success',
  degraded_performance: 'warning',
  partial_outage: 'warning',
  major_outage: 'error',
  under_maintenance: 'suggestion',
}
const COMPONENT_TEXT: Record<string, string> = {
  operational: '稼働中',
  degraded_performance: '性能低下',
  partial_outage: '一部停止',
  major_outage: '停止',
  under_maintenance: 'メンテナンス中',
}
const INCIDENT_TEXT: Record<string, string> = {
  investigating: '調査中',
  identified: '原因特定',
  monitoring: '経過観察',
  resolved: '解決',
  in_progress: '実施中',
  scheduled: '予定',
}
// GitHub の言語の色（linguist）。無い言語は灰色
const LANGUAGE_COLOR: Record<string, string> = {
  TypeScript: '#3178C6',
  JavaScript: '#F1E05A',
  HTML: '#E34C26',
  CSS: '#663399',
  Python: '#3572A5',
  Swift: '#F05138',
  Shell: '#89E051',
  GDScript: '#355570',
  Rust: '#DEA584',
  Go: '#00ADD8',
}
// リポジトリを 2 列に並べる幅（マス）
const TWO_COLUMNS_FROM = 90

export type PendingSummary = { total: number; unpushed: number; uncommitted: number; repos: RepoState[] }

export function pendingSummary(repos: readonly RepoState[]): PendingSummary {
  const list = repos
    .filter(r => r.ahead > 0 || r.dirty > 0 || (r.hasRemote && !r.hasUpstream))
    .sort((a, b) => b.ahead - a.ahead || b.dirty - a.dirty)
  return {
    total: list.length,
    unpushed: list.filter(r => r.ahead > 0 || (r.hasRemote && !r.hasUpstream)).length,
    uncommitted: list.filter(r => r.dirty > 0).length,
    repos: list,
  }
}

// summary は畳んでいるときだけ見出しの横に出す（畳んでいても様子が分かるように）
function card(ui: UI, id: string, title: string, folded: boolean, onToggle: () => void, body: unknown, opts: { tone?: string; right?: unknown; summary?: unknown } = {}) {
  const { Box, Button } = ui
  return (
    <Box key={id} flexDirection="column" borderStyle="round" borderColor={opts.tone ?? 'inactive'} paddingX={1} marginTop={1}>
      <Box key="head" flexDirection="row" justifyContent="space-between">
        <Box key="title" flexDirection="row" columnGap={1} flexShrink={1}>
          <Button key={`toggle-${id}`} label={`${folded ? '▶' : '▼'} ${title}`} plain onPress={onToggle} />
          {folded ? (opts.summary ?? null) : null}
        </Box>
        {opts.right ?? null}
      </Box>
      {folded ? null : body}
    </Box>
  )
}

function statusBody(ui: UI, s: ServiceStatus | null) {
  const { Box, Text, Link } = ui
  if (!s) return <Text dimColor>取得できませんでした</Text>
  const tone = TONE[s.indicator] ?? 'inactive'
  return (
    <Box flexDirection="column">
      <Text key="desc" color={tone} bold>
        {s.indicator === 'none' ? '✓ ' : '⚠ '}
        {s.description}
      </Text>
      <Box key="chips" flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
        {s.components.map(c => (
          <Box key={`c-${c.name}`} borderStyle="round" borderColor="inactive" paddingX={1} flexDirection="row">
            <Text color={COMPONENT_TONE[c.status] ?? 'inactive'}>● </Text>
            <Text bold>{c.name} </Text>
            <Text color={COMPONENT_TONE[c.status] ?? 'inactive'}>{COMPONENT_TEXT[c.status] ?? c.status}</Text>
          </Box>
        ))}
      </Box>
      {s.incidents.slice(0, 5).map(i => (
        <Box key={`i-${i.url}`} borderStyle="round" borderColor="suggestion" paddingX={1} flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box key="name" flexDirection="row" flexShrink={1}>
            <Text color="suggestion">ⓘ </Text>
            <Link href={i.url} label={i.name} />
          </Box>
          <Text key="when" dimColor>
            {INCIDENT_TEXT[i.status] ?? i.status}・{ago(Date.parse(i.updatedAt))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// 畳んだ見出しの横の一言：全体の状態と、障害の件数
function statusSummary(ui: UI, s: ServiceStatus | null) {
  const { Text } = ui
  if (!s) return <Text dimColor>取得できず</Text>
  const tone = TONE[s.indicator] ?? 'inactive'
  const count = s.incidents.length > 0 ? `（${s.incidents.length} 件）` : ''
  return (
    <Text color={tone} bold>
      {s.indicator === 'none' ? '✓ 正常' : `⚠ ${s.description}${count}`}
    </Text>
  )
}

function pendingBody(ui: UI, p: PendingSummary) {
  const { Box, Text } = ui
  if (p.total === 0) return <Text color="success">✓ すべてコミット・プッシュ済み</Text>
  return (
    <Box flexDirection="column">
      <Box key="counts" flexDirection="row" columnGap={1} flexWrap="wrap">
        <Box key="unpushed" borderStyle="round" borderColor="inactive" paddingX={1} flexDirection="row">
          <Text>⬆ プッシュ待ち </Text>
          <Text bold color={p.unpushed > 0 ? 'warning' : undefined}>{p.unpushed}</Text>
        </Box>
        <Box key="uncommitted" borderStyle="round" borderColor="inactive" paddingX={1} flexDirection="row">
          <Text>✎ 未コミット </Text>
          <Text bold color={p.uncommitted > 0 ? 'warning' : undefined}>{p.uncommitted}</Text>
        </Box>
      </Box>
      {p.repos.slice(0, 8).map(r => (
        <Box key={`r-${r.name}`} flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text bold>{r.name}</Text>
          <Text dimColor>{r.branch}</Text>
          {r.ahead > 0 ? <Text color="warning">⬆{r.ahead}</Text> : null}
          {r.behind > 0 ? <Text dimColor>⬇{r.behind}</Text> : null}
          {r.dirty > 0 ? <Text color="warning">✎{r.dirty}</Text> : null}
          {r.hasRemote && !r.hasUpstream ? <Text dimColor>上流なし</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

function pushesBody(ui: UI, pushes: readonly Push[]) {
  const { Box, Text, Link } = ui
  if (pushes.length === 0) return <Text dimColor>なし</Text>
  return (
    <Box flexDirection="column">
      {pushes.map((p, n) => {
        const repo = p.repo.split('/').pop() ?? p.repo
        const extra = [p.branch === 'main' || p.branch === 'master' ? '' : p.branch, p.count > 1 ? `${p.count} コミット` : ''].filter(Boolean).join('・')
        return (
          <Box key={`p-${p.id}`} flexDirection="row" columnGap={1} marginTop={n === 0 ? 0 : 1}>
            <Box key="when" width={8} flexShrink={0}>
              <Text dimColor>{ago(p.time)}</Text>
            </Box>
            <Box key="what" flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box key="repo" flexDirection="row" columnGap={1}>
                <Link href={`https://github.com/${p.repo}`} label={repo} />
                {extra ? <Text dimColor>{extra}</Text> : null}
              </Box>
              {p.messages.slice(0, MESSAGES_PER_PUSH).map((m, k) => (
                <Text key={`m-${k}`}>{m}</Text>
              ))}
              {p.messages.length > MESSAGES_PER_PUSH ? <Text dimColor>ほか {p.messages.length - MESSAGES_PER_PUSH} 件</Text> : null}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function reposBody(ui: UI, repos: readonly RepoInfo[], columns: number) {
  const { Box, Text, Link } = ui
  if (repos.length === 0) return <Text dimColor>なし</Text>
  const width = columns >= TWO_COLUMNS_FROM ? '50%' : '100%'
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {repos.map(r => {
        const name = r.fullName.split('/').pop() ?? r.fullName
        return (
          <Box key={`g-${r.fullName}`} width={width} paddingRight={1}>
            <Box key="tile" flexGrow={1} borderStyle="round" borderColor="inactive" paddingX={1} flexDirection="row" columnGap={1}>
              <Text key="dot" color={(r.language && LANGUAGE_COLOR[r.language]) ?? 'inactive'}>●</Text>
              <Box key="text" flexDirection="column" flexGrow={1} flexShrink={1}>
                <Box key="name" flexDirection="row" columnGap={1}>
                  <Link href={r.url} label={name} />
                  {r.isPrivate ? <Text>🔒</Text> : null}
                  {r.isArchived ? <Text>📦</Text> : null}
                </Box>
                <Text key="title" dimColor wrap="truncate-end">
                  {r.title ?? r.language ?? '·'}
                </Text>
              </Box>
              <Text key="ago" dimColor>{ago(r.pushedAt)}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function memoryBody(ui: UI, d: Dashboard) {
  const { Markdown } = ui
  return <Markdown text={memoryMarkdown(d)} />
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dash', description: 'ダッシュボード（Claude の稼働状況・最近のプッシュ）を開く' })
    // 読み込み直しで更新の途中が切れても止まらないよう、旗を下ろしてから始める
    await update($, isLoading, () => false)
    const stored = await $.store.get(COLLAPSED_KEY)
    await update($, collapsed, () => (Array.isArray(stored) ? (stored as string[]) : []))
    void openPane($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    await openPane($)
    return { text: 'ダッシュボードを開きました。' }
  })

  // 閉じたら、入力欄の下の右端（モード表示の並び）に「ダッシュボード」のボタンを出して、押せば開き直す
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, isOpen, () => false)
    return closed
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (await read($, isOpen)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const modes = await next(e)
    return (
      <Box flexDirection="row">
        {modes}
        <Text> </Text>
        <Button label="📊 ダッシュボード" plain dimColor onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as unknown as UI
    const { Box, Text, Button, Link, Markdown } = ui
    const d = await read($, data)
    const loading = await read($, isLoading)
    const folded = await read($, collapsed)
    const toggle = (id: string) => () => void toggleSection($, id)
    const pending = d === null ? null : pendingSummary(d.repos)
    return (
      <Box flexDirection="column">
        <Box key="top" flexDirection="row" justifyContent="space-between">
          <Text dimColor>{loading ? '更新中…' : d ? `最終更新：${ago(d.updatedAt)}` : ''}</Text>
          <Button label="更新" hotkey="r" onPress={() => void refresh($)} />
        </Box>
        {d === null ? <Text dimColor>読み込み中…</Text> : null}
        {d === null || pending === null
          ? null
          : [
              card(ui, 'status', 'Claude の稼働状況', folded.includes('status'), toggle('status'), statusBody(ui, d.status), {
                tone: d.status ? TONE[d.status.indicator] : undefined,
                right: <Link href="https://status.claude.com" label="ステータスページ ↗" />,
                summary: statusSummary(ui, d.status),
              }),
              card(ui, 'pending', `プッシュ待ち・未コミット（${pending.total}）`, folded.includes('pending'), toggle('pending'), pendingBody(ui, pending)),
              card(ui, 'pushes', `最近のプッシュ（${d.pushes.length}）`, folded.includes('pushes'), toggle('pushes'), pushesBody(ui, d.pushes)),
              card(ui, 'repos', `リポジトリ（${d.repoList.length}）`, folded.includes('repos'), toggle('repos'), reposBody(ui, d.repoList, e.props.bodyColumns)),
              card(
                ui,
                'memory',
                `読み込んでいるメモリ・CLAUDE.md（${d.memoryFiles.length}・${tokenText(d.memoryFiles.reduce((sum, f) => sum + f.tokens, 0))} トークン）`,
                folded.includes('memory'),
                toggle('memory'),
                memoryBody(ui, d),
              ),
            ]}
        {d !== null && d.errors.length > 0 ? <Markdown key="errors" text={limit(d.errors.map(e => `> ⚠ ${esc(e)}`).join('\n'))} /> : null}
      </Box>
    )
  })
}
