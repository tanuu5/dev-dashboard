import { describe, expect, test } from 'claude-code/testing'

import { readmeTitle, sections, unreportedCommits } from '../hooks/register'

const commit = (sha: string, date: string) => ({ sha, date, message: `msg ${sha}` })

describe('イベントにまだ載っていないプッシュを補う', () => {
  test('イベントに載っている先頭のコミットの手前までを拾う', async () => {
    const commits = [commit('c3', '2026-10-03T03:16:00Z'), commit('c2', '2026-10-03T02:43:00Z'), commit('c1', '2026-10-02T16:56:00Z')]
    expect(unreportedCommits(commits, 'c1', Date.parse('2026-10-03T03:16:33Z')).map(c => c.sha)).toEqual(['c3', 'c2'])
  })

  test('イベントが一つも無いリポジトリは、遅れの幅（6 時間）より古いコミットまでは遡らない', async () => {
    const commits = [commit('n2', '2026-10-03T04:08:00Z'), commit('n1', '2026-10-03T03:00:00Z'), commit('old', '2026-09-30T00:00:00Z')]
    expect(unreportedCommits(commits, undefined, Date.parse('2026-10-03T04:08:50Z')).map(c => c.sha)).toEqual(['n2', 'n1'])
  })

  test('先頭がもう載っていれば何も足さない', async () => {
    expect(unreportedCommits([commit('c1', '2026-10-03T03:16:00Z')], 'c1', Date.parse('2026-10-03T03:16:33Z'))).toEqual([])
  })
})

describe('README の見出しを名前に添える', () => {
  test('日本語名が入った見出しを拾う', async () => {
    expect(readmeTitle('# しっぽ急便 — TAIL EXPRESS\n\n本文', 'shippo-express')).toBe('しっぽ急便 — TAIL EXPRESS')
    expect(readmeTitle('<div align="center">\n<h1>怪獣ドカン！</h1>\n</div>', 'kaiju-dokan')).toBe('怪獣ドカン！')
    expect(readmeTitle('[![badge](https://x)](https://y)\n# [ぶんべつビート](https://z) — Bunbetsu Beat', 'bunbetsu-beat')).toBe('ぶんべつビート — Bunbetsu Beat')
  })

  test('リポジトリ名と同じ見出しや、見出しが無い README は添えない', async () => {
    expect(readmeTitle('# clawd-dance', 'clawd-dance')).toBeNull()
    expect(readmeTitle('# TANUKI RUSH 🍃', 'tanuki-rush')).toBeNull()
    expect(readmeTitle('本文だけ', 'x')).toBeNull()
  })
})

describe('畳めるセクション', () => {
  const dashboard = {
    updatedAt: 0,
    status: { indicator: 'none', description: 'All Systems Operational', components: [], incidents: [] },
    repos: [],
    pushes: [],
    repoList: [
      { fullName: 'tanuu5/shippo-express', url: 'https://github.com/tanuu5/shippo-express', pushedAt: 0, isPrivate: false, isArchived: false, title: 'しっぽ急便 — TAIL EXPRESS' },
      { fullName: 'tanuu5/reel', url: 'https://github.com/tanuu5/reel', pushedAt: 0, isPrivate: true, isArchived: false, title: null },
    ],
    memoryFiles: [
      { path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 1_840 },
      { path: '/home/me/.claude/projects/x/memory/MEMORY.md', type: 'AutoMem', tokens: 310 },
    ],
    home: '/home/me',
    errors: [],
  }

  test('稼働状況・最近のプッシュ・リポジトリ・メモリの順に並び、プッシュ待ちが無ければ出さない', async () => {
    const list = sections(dashboard)
    expect(list.map(s => s.id)).toEqual(['status', 'pushes', 'repos', 'memory'])
    expect(list[0]!.title).toBe('Claude の稼働状況　🟢')
    expect(list[2]!.title).toBe('リポジトリ（2）')
  })

  test('リポジトリは GitHub へのリンクと日本語名、非公開の印を出す', async () => {
    const md = sections(dashboard)[2]!.markdown
    expect(md).toContain('[**shippo-express**](https://github.com/tanuu5/shippo-express)　しっぽ急便 — TAIL EXPRESS')
    expect(md).toContain('[**reel**](https://github.com/tanuu5/reel)　🔒')
  })
})

describe('読み込んでいるメモリ', () => {
  test('どこのものか、~ で縮めたパス（ファイルへのリンク）、トークン数を出す', async () => {
    const d = {
      updatedAt: 0, status: null, repos: [], pushes: [], repoList: [], errors: [], home: '/home/me',
      memoryFiles: [
        { path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 1_840 },
        { path: '/home/me/.claude/projects/x/memory/MEMORY.md', type: 'AutoMem', tokens: 310 },
      ],
    }
    const memory = sections(d).find(s => s.id === 'memory')!
    expect(memory.title).toBe('読み込んでいるメモリ・CLAUDE.md（2・2.2k トークン）')
    expect(memory.markdown).toContain('- ユーザー全体　[~/.claude/CLAUDE.md](file:///home/me/.claude/CLAUDE.md)　1.8k トークン')
    expect(memory.markdown).toContain('- 自動メモリ　[~/.claude/projects/x/memory/MEMORY.md]')
  })
})
