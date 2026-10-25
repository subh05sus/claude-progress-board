export type StepStatus = 'pending' | 'working' | 'done' | 'skipped'

export type Step = {
  title: string
  weight: number
  status: StepStatus
  startedAt?: number
  doneAt?: number
}

export type Plan = {
  title: string
  project: string
  steps: Step[]
  startedAt: number
  updatedAt: number
  finishedAt?: number
}

export type ActivityKind = 'Edit' | 'Write' | 'Bash' | 'Note' | 'Step'

export type ActivityItem = {
  at: number
  kind: ActivityKind
  text: string
  isOk?: boolean
}

export type Activity = {
  files: string[]
  commands: number
  recent: ActivityItem[]
}

// One open session as Mission control lists it, shared across sessions in $.store.
export type MissionEntry = {
  id: string
  project: string
  updatedAt: number
  isWorking: boolean
  title?: string
  pct?: number
  done?: number
  total?: number
  step?: number
  startedAt?: number
  finishedAt?: number
}

export type SessionSelf = { id: string; project: string }

declare module 'claude-code' {
  interface PluginState {
    'progress-board': {
      plan: Shaped<Plan | null>
      activity: Shaped<Activity>
      tick: number
      isBandHidden: boolean
      sessions: Shaped<MissionEntry[]>
      self: Shaped<SessionSelf | null>
      isWorking: boolean
    }
  }
}
