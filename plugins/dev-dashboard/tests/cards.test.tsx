import { describe, expect, test } from 'claude-code/testing'

import { pendingSummary } from '../hooks/register'

const dashboard = {
  updatedAt: Date.now() - 3 * 60_000,
  status: {
    indicator: 'minor',
    description: 'Minor Service Outage',
    components: [
      { name: 'claude.ai', status: 'operational' },
      { name: 'Claude API', status: 'operational' },
      { name: 'Claude Code', status: 'degraded_performance' },
    ],
    incidents: [{ name: 'Elevated errors loading usage data', status: 'investigating', url: 'https://stspg.io/x', updatedAt: new Date().toISOString() }],
  },
  repos: [
    { name: 'a', branch: 'main', ahead: 2, behind: 0, dirty: 0, hasUpstream: true, hasRemote: true },
    { name: 'b', branch: 'main', ahead: 0, behind: 0, dirty: 3, hasUpstream: true, hasRemote: true },
    { name: 'c', branch: 'main', ahead: 0, behind: 0, dirty: 0, hasUpstream: true, hasRemote: true },
  ],
  pushes: [{ id: '1', repo: 'tanuu5/clawd-dance', time: Date.now(), branch: 'main', count: 1, messages: ['Speak up when a permission dialog is waiting'] }],
  repoList: [
    { fullName: 'tanuu5/shippo-express', url: 'https://github.com/tanuu5/shippo-express', pushedAt: 0, isPrivate: false, isArchived: false, language: 'TypeScript', title: 'しっぽ急便 — TAIL EXPRESS' },
    { fullName: 'tanuu5/reel', url: 'https://github.com/tanuu5/reel', pushedAt: 0, isPrivate: true, isArchived: false, language: null, title: null },
  ],
  memoryFiles: [{ path: '/home/me/.claude/CLAUDE.md', type: 'User', tokens: 1_840 }],
  home: '/home/me',
  errors: [],
}

const paneProps = (bodyColumns: number) =>
  ({ title: 'ダッシュボード', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40, totalRows: 0 }, view: {} }) as never

describe('カード型の表示', () => {
  test('プッシュ待ちと未コミットを数える', async () => {
    const p = pendingSummary(dashboard.repos)
    expect([p.total, p.unpushed, p.uncommitted]).toEqual([2, 1, 1])
  })

  for (const surface of ['desktop', 'terminal'] as const) {
    test(`${surface}：各カードを描く`, async ($, on) => {
      on('ui.render', ($, e) => {
        const { Box } = $.ui.resolve(e)
        return <Box key="engine" />
      })
      on('state.get', (_$, e) => ({ value: { value: (e as { key: string }).key === 'data' ? dashboard : undefined, version: 1 } }) as never)
      const ui = await $.ui.mount({ plugin: 'dev-dashboard', surface, component: 'Pane', requestId: 'dev-dashboard', props: paneProps(100) })
      expect(await ui.find({ type: 'Text', text: /Minor Service Outage/ })).toBeDefined()
      const links = await ui.findAll({ type: 'Link' })
      expect(links.some(l => l.props.href === 'https://github.com/tanuu5/shippo-express')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /プッシュ待ち/ })).toBeDefined()
      // リポジトリは日本語名を添え、非公開には鍵。メモリの見出しには件数とトークン数
      expect(await ui.find({ type: 'Text', text: 'しっぽ急便 — TAIL EXPRESS' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '🔒' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: '▼ 読み込んでいるメモリ・CLAUDE.md（1・1.8k トークン）' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('稼働状況を畳んでも、見出しの横に状態と障害の件数を出す', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box key="engine" />
    })
    on('state.get', (_$, e) => {
      const key = (e as { key: string }).key
      return { value: { value: key === 'data' ? dashboard : key === 'collapsed' ? ['status'] : undefined, version: 1 } } as never
    })
    const ui = await $.ui.mount({ plugin: 'dev-dashboard', surface: 'desktop', component: 'Pane', requestId: 'dev-dashboard', props: paneProps(100) })
    expect(await ui.find({ type: 'Text', text: '⚠ Minor Service Outage（1 件）' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude Code/ })).toBeUndefined()
    await ui.unmount()
  })
})
