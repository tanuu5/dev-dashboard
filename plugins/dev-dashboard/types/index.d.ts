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
export type Dashboard = {
  updatedAt: number
  status: ServiceStatus | null
  repos: RepoState[]
  pushes: Push[]
  errors: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'dev-dashboard': { data: Dashboard | null; isLoading: boolean; isOpen: boolean }
  }
}
