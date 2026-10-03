import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dashboard, Push, RepoState, ServiceStatus } from '../types'

// Claude Code のホーム画面には描けないので、セッションの横にダッシュボードのパネルを出す。
// 中身：Claude の稼働状況（status.claude.com）、GitHub への最近のプッシュ（コミットメッセージ付き）、
// ローカルのプッシュ待ち・未コミット（あるときだけ）。

const PANE = 'dev-dashboard'
const TITLE = 'ダッシュボード'
const REFRESH_MS = 5 * 60 * 1000
const SHOW_COMPONENTS = ['claude.ai', 'Claude API', 'Claude Code']
const PUSH_COUNT = 15
const MESSAGES_PER_PUSH = 3

const data = atom({ plugin: 'dev-dashboard', key: 'data' } as const, null)
const isLoading = atom({ plugin: 'dev-dashboard', key: 'isLoading' } as const, false)
const isOpen = atom({ plugin: 'dev-dashboard', key: 'isOpen' } as const, false)

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

type RepoPushed = { name: string; pushedAt: string; branch: string }
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

async function collectLaggingPushes($: Api, pushEvents: readonly any[], now: number): Promise<Push[]> {
  const out = await gh($, [
    'api',
    `user/repos?sort=pushed&per_page=${LAG_REPOS}`,
    '--jq',
    '[.[] | {name: .full_name, pushedAt: .pushed_at, branch: .default_branch}]',
  ])
  if (out === null) return []
  const latest = new Map<string, any>()
  for (const ev of pushEvents) {
    const cur = latest.get(ev.repo.name)
    if (!cur || Date.parse(ev.created_at) > Date.parse(cur.created_at)) latest.set(ev.repo.name, ev)
  }
  const pushes = await Promise.all(
    (JSON.parse(out) as RepoPushed[]).map(async (repo): Promise<Push | null> => {
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

async function collectPushes($: Api): Promise<Push[]> {
  const login = (await gh($, ['api', 'user', '--jq', '.login']))?.trim()
  if (!login) throw new Error('gh にログインしていないか、gh が見つからない')
  const out = await gh($, ['api', `users/${login}/events?per_page=100`])
  if (out === null) throw new Error('GitHub のイベントを取得できず')
  const pushEvents = (JSON.parse(out) as any[]).filter(ev => ev.type === 'PushEvent')
  const lagging = await collectLaggingPushes($, pushEvents, Date.now()).catch(() => [] as Push[])
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
  const [status, repos, pushes] = await Promise.all([
    collectStatus($).catch(err => (errors.push(`稼働状況：${err.message ?? err}`), null)),
    collectRepos($).catch(err => (errors.push(`ローカル：${err.message ?? err}`), [] as RepoState[])),
    collectPushes($).catch(err => (errors.push(`GitHub：${err.message ?? err}`), [] as Push[])),
  ])
  const next: Dashboard = { updatedAt: Date.now(), status, repos, pushes, errors }
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

const MARK: Record<string, string> = {
  operational: '🟢',
  degraded_performance: '🟡',
  partial_outage: '🟠',
  major_outage: '🔴',
  under_maintenance: '🔧',
}
const INDICATOR: Record<string, string> = { none: '🟢', minor: '🟡', major: '🟠', critical: '🔴', maintenance: '🔧' }

function esc(s: string) {
  return s.replace(/([\\`*_[\]|<>])/g, '\\$1')
}

function toMarkdown(d: Dashboard) {
  const out: string[] = []

  out.push('### Claude の稼働状況')
  if (d.status) {
    const s = d.status
    out.push(`${INDICATOR[s.indicator] ?? '⚪'} **${esc(s.description)}**`)
    out.push('')
    out.push(s.components.map(c => `${MARK[c.status] ?? '⚪'} ${esc(c.name)}`).join('　'))
    if (s.incidents.length > 0) {
      out.push('')
      for (const i of s.incidents.slice(0, 5)) {
        out.push(`- [${esc(i.name)}](${i.url})（${i.status}・${ago(Date.parse(i.updatedAt))}）`)
      }
    }
  } else {
    out.push('取得できませんでした')
  }

  // 個人開発ではコミットとプッシュがほぼセットなので、プッシュ待ちはあるときだけ出す
  const pending = d.repos
    .filter(r => r.ahead > 0 || r.dirty > 0 || (r.hasRemote && !r.hasUpstream))
    .sort((a, b) => b.ahead - a.ahead || b.dirty - a.dirty)
  if (pending.length > 0) {
    out.push('', '### プッシュ待ち・未コミット')
    for (const r of pending.slice(0, 8)) {
      const tags = [
        r.ahead > 0 ? `⬆ ${r.ahead} 件未プッシュ` : '',
        r.behind > 0 ? `⬇ ${r.behind}` : '',
        r.dirty > 0 ? `✎ ${r.dirty} ファイル未コミット` : '',
        r.hasRemote && !r.hasUpstream ? '上流ブランチなし' : '',
      ].filter(Boolean)
      out.push(`- **${esc(r.name)}** \`${esc(r.branch)}\`　${tags.join('・')}`)
    }
  }

  out.push('', '### 最近のプッシュ')
  if (d.pushes.length === 0) out.push('なし')
  for (const p of d.pushes) {
    const repo = p.repo.split('/').pop() ?? p.repo
    const branch = p.branch === 'main' || p.branch === 'master' ? '' : `　\`${esc(p.branch)}\``
    const count = p.count > 1 ? `　（${p.count} コミット）` : ''
    out.push(`- ${ago(p.time)}　[**${esc(repo)}**](https://github.com/${p.repo})${branch}${count}`)
    for (const m of p.messages.slice(0, MESSAGES_PER_PUSH)) out.push(`  - ${esc(m)}`)
    if (p.messages.length > MESSAGES_PER_PUSH) out.push(`  - ほか ${p.messages.length - MESSAGES_PER_PUSH} 件`)
  }

  if (d.errors.length > 0) out.push('', ...d.errors.map(e => `> ⚠ ${esc(e)}`))
  return out.join('\n').slice(0, 9800)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dash', description: 'ダッシュボード（Claude の稼働状況・最近のプッシュ）を開く' })
    // 読み込み直しで更新の途中が切れても止まらないよう、旗を下ろしてから始める
    await update($, isLoading, () => false)
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
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const d = await read($, data)
    const loading = await read($, isLoading)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{loading ? '更新中…' : d ? `${ago(d.updatedAt)}に更新` : ''}</Text>
          <Button label="更新" hotkey="r" onPress={() => void refresh($)} />
        </Box>
        {d ? <Markdown text={toMarkdown(d)} /> : <Text dimColor>読み込み中…</Text>}
      </Box>
    )
  })
}
