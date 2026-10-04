export type Incident = { name: string; status: string; url: string; updatedAt: string }
export type ServiceStatus = {
  indicator: string
  description: string
  components: { name: string; status: string }[]
  incidents: Incident[]
}
export type RepoState = {
  name: string
  branch: string
  ahead: number
  behind: number
  dirty: number
  hasUpstream: boolean
  hasRemote: boolean
}
export type Push = { id: string; repo: string; time: number; branch: string; count: number; messages: string[] }
// GitHub のリポジトリ一覧の 1 行。title は README の最初の見出し（日本語名が入っていることが多い）
export type RepoInfo = { fullName: string; url: string; pushedAt: number; isPrivate: boolean; isArchived: boolean; title: string | null }
export type Dashboard = {
  updatedAt: number
  status: ServiceStatus | null
  repos: RepoState[]
  pushes: Push[]
  repoList: RepoInfo[]
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'dev-dashboard': { data: Dashboard | null; isLoading: boolean; isOpen: boolean; collapsed: string[] }
  }
}
