import { describe, expect, test } from 'claude-code/testing'

import { unreportedCommits } from '../hooks/register'

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
