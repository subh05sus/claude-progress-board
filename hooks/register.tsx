import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, ActivityItem, Hud, MissionEntry, Plan, Step, StepStatus } from '../types'
import {
  addDir,
  addTask,
  agentEnded,
  agentStarted,
  contextColor,
  effortSymbol,
  fmtSession,
  fmtTokens,
  fmtUntil,
  fmtUsd,
  quotaColor,
  refreshAddedDirs,
  refreshGit,
  refreshModel,
  refreshTitle,
  refreshUsage,
  setEffort,
  setRequestTokens,
  setTodos,
  shortModel,
  updateTask,
} from './hud'

const PLUGIN = 'progress-board'
const PANE = 'progress'
const MISSION = 'mission'
const STORE_PREFIX = 'session:'
const ALIVE_MS = 60 * 1000
const HEARTBEAT_EVERY = 7 // ticks: ~14s
const REFRESH_EVERY = 3 // ticks: ~6s
const FORGET_MS = 24 * 60 * 60 * 1000
const HUD_USAGE_EVERY = 3 // ticks: ~6s
const HUD_GIT_EVERY = 8 // ticks: ~16s
const HUD_TITLE_EVERY = 30 // ticks: ~60s
const TOOL = 'progress'
const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`
const CHECK_IN_MS = 5 * 60 * 1000
const AUTO_OPEN_MIN_STEPS = 3
const TICK_MS = 2000
const RECENT_MAX = 40

const EMPTY_ACTIVITY: Activity = { files: [], commands: 0, recent: [] }

// Change a shape tag when that value's fields change: it declines what an
// earlier version stored, which outlives a reload.
const planAtom = atom({ plugin: 'progress-board', key: 'plan' } as const, null, { shape: 'plan-1' })
const activityAtom = atom({ plugin: 'progress-board', key: 'activity' } as const, EMPTY_ACTIVITY, {
  shape: 'activity-1',
})
const tickAtom = atom({ plugin: 'progress-board', key: 'tick' } as const, 0)
const sessionsAtom = atom({ plugin: 'progress-board', key: 'sessions' } as const, [], { shape: 'sessions-1' })
const selfAtom = atom({ plugin: 'progress-board', key: 'self' } as const, null, { shape: 'self-1' })
const workingAtom = atom({ plugin: 'progress-board', key: 'isWorking' } as const, false)
const hudAtom = atom({ plugin: 'progress-board', key: 'hud' } as const, { agents: [], todos: [] } as Hud, { shape: 'hud-1' })

type Action = 'plan' | 'start' | 'done' | 'skip' | 'add' | 'note' | 'finish'

type ProgressArgs = {
  action?: Action
  title?: string
  steps?: Array<{ title?: string; weight?: number }>
  step?: number
  note?: string
}

const GUIDE = `# Progress board
The user watches a live progress panel instead of asking you for status. Drive it with the \`${TOOL_FULL}\` tool:
- Before starting any task with 3 or more distinct steps (or one likely to take more than a few minutes), call it with action "plan": a short title and 3-10 steps, each at most 45 characters and named by its outcome, with a weight of 1-5 for relative effort.
- Call "start" with the step number when you begin a step, and "done" when it is finished and verified; the next pending step starts by itself. Use "skip" for a step no longer needed and "add" when new steps appear.
- Use "note" sparingly, for a one-line milestone or decision the user should see (at most 80 characters).
- Call "finish" when the whole task is complete.
- Never mark a step done before it is actually done. Don't mention the panel in replies, and don't use it for quick questions or single-step tasks.
- If the user asks how far along you are, update the board first, then answer briefly.`

const CHECK_IN = `Progress board: you haven't updated ${TOOL_FULL} in over 5 minutes. If a step has finished or started since, update it now (and add a short "note" on what you're doing if useful), then continue.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['plan', 'start', 'done', 'skip', 'add', 'note', 'finish'],
      description:
        'plan: set a new task (title + steps). start/done/skip: change one step (step = its 1-based number). add: append steps. note: a one-line update. finish: the task is complete.',
    },
    title: { type: 'string', description: 'Task title, for "plan" (at most 60 characters).' },
    steps: {
      type: 'array',
      description: 'For "plan" and "add": the steps in order.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'At most 45 characters.' },
          weight: { type: 'number', description: 'Relative effort, 1-5 (default 1).' },
        },
        required: ['title'],
      },
    },
    step: { type: 'integer', description: 'For start/done/skip: the 1-based step number.' },
    note: { type: 'string', description: 'Optional one-line note shown in the Recent feed.' },
  },
  required: ['action'],
}

// ── helpers ──────────────────────────────────────────────────────────────

const clampWeight = (w: unknown) =>
  typeof w === 'number' && Number.isFinite(w) ? Math.min(5, Math.max(1, Math.round(w))) : 1

const toSteps = (raw: ProgressArgs['steps']): Step[] =>
  (raw ?? [])
    .filter(s => typeof s?.title === 'string' && s.title.trim() !== '')
    .map(s => ({ title: s.title!.trim().slice(0, 60), weight: clampWeight(s.weight), status: 'pending' as StepStatus }))

const totalWeight = (plan: Plan) => plan.steps.reduce((sum, s) => sum + s.weight, 0)
const doneWeight = (plan: Plan) =>
  plan.steps.reduce((sum, s) => sum + (s.status === 'done' || s.status === 'skipped' ? s.weight : 0), 0)

const percentOf = (plan: Plan) => {
  if (plan.finishedAt !== undefined) return 100
  const total = totalWeight(plan)
  return total === 0 ? 0 : Math.round((doneWeight(plan) / total) * 100)
}

const countDone = (plan: Plan) => plan.steps.filter(s => s.status === 'done' || s.status === 'skipped').length

// Time left: the pace is fixed when a step finishes, then counts down until the next one,
// so the estimate falls each second instead of growing while a step is in progress.
// Below zero means the work in progress is running over the estimate.
const etaOf = (plan: Plan, now: number): number | undefined => {
  if (plan.finishedAt !== undefined) return undefined
  const done = doneWeight(plan)
  const left = totalWeight(plan) - done
  if (done === 0 || left <= 0) return undefined
  const lastDoneAt = plan.steps.reduce(
    (latest, s) => (s.status === 'done' || s.status === 'skipped' ? Math.max(latest, s.doneAt ?? 0) : latest),
    plan.startedAt,
  )
  return ((lastDoneAt - plan.startedAt) / done) * left - (now - lastDoneAt)
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const fmtClock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const bar = (pct: number, width: number) => {
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const shortPath = (p: string) => {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 3 ? parts.join('/') : `…/${parts.slice(-3).join('/')}`
}

const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`)

// "cd x && FOO=1 claude plugin list 2>&1 | grep y" -> "claude plugin list …"
const shortCommand = (command: string) => {
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  const main = segments.find(s => !/^(cd|export|set|source|\.)\s/.test(s) && !/^\w+=\S*$/.test(s)) ?? segments[0] ?? command
  const words = main.split(/\s+/).filter(w => !/^\w+=/.test(w) && !/^\d?>/.test(w))
  const head = words.slice(0, 3).join(' ')
  return words.length > 3 || segments.length > 1 ? `${head} …` : head
}

const recentText = (item: ActivityItem) =>
  item.kind === 'Bash' ? shortCommand(item.text) : item.kind === 'Edit' || item.kind === 'Write' ? basename(item.text) : item.text

const startNext = (steps: Step[], now: number): Step[] => {
  if (steps.some(s => s.status === 'working')) return steps
  const i = steps.findIndex(s => s.status === 'pending')
  return i === -1 ? steps : steps.map((s, j) => (j === i ? { ...s, status: 'working', startedAt: now } : s))
}

const STEP_ICON: Record<StepStatus, string> = {
  done: '✔',
  working: '●',
  pending: '○',
  skipped: '–',
}

const stepTime = (s: Step, now: number) =>
  s.startedAt === undefined ? '' : fmtDur((s.doneAt ?? (s.status === 'working' ? now : s.startedAt)) - s.startedAt)

// ── state changes ────────────────────────────────────────────────────────

const addRecent = ($: EngineInterface, item: ActivityItem) =>
  update($, activityAtom, a => ({ ...a, recent: [...a.recent, item].slice(-RECENT_MAX) }))

const openPane = ($: EngineInterface, plan: Plan | null) =>
  $.ui.open({ id: PANE, title: plan ? `Progress · ${plan.project}` : 'Progress' })

const isPaneOpen = async ($: EngineInterface, id = PANE) => (await $.ui.panes()).some(p => p.id === id)

const openMission = ($: EngineInterface) => $.ui.open({ id: MISSION, title: 'Mission control' })

// ── Mission control: every open session publishes itself to the shared store ──

type MissionStatus = 'working' | 'waiting' | 'done' | 'idle'

const statusOf = (s: MissionEntry): MissionStatus =>
  s.isWorking ? 'working' : s.title === undefined ? 'idle' : s.finishedAt === undefined ? 'waiting' : 'done'

const STATUS_ORDER: Record<MissionStatus, number> = { working: 0, waiting: 1, done: 2, idle: 3 }

const MISSION_ICON: Record<MissionStatus, string> = { working: '●', waiting: '◐', done: '✔', idle: '○' }
const MISSION_COLOR: Record<MissionStatus, string | undefined> = {
  working: 'claude',
  waiting: 'warning',
  done: 'success',
  idle: undefined,
}

async function publishSelf($: EngineInterface) {
  const self = await read($, selfAtom)
  if (self === null) return
  const plan = await read($, planAtom)
  const working = plan ? plan.steps.findIndex(s => s.status === 'working') : -1
  const entry: MissionEntry = {
    id: self.id,
    project: self.project,
    updatedAt: await $.clock.now(),
    isWorking: await read($, workingAtom),
    ...(plan && {
      title: plan.title,
      pct: percentOf(plan),
      done: countDone(plan),
      total: plan.steps.length,
      step: working === -1 ? undefined : working + 1,
      startedAt: plan.startedAt,
      finishedAt: plan.finishedAt,
    }),
  }
  await $.store.set(STORE_PREFIX + self.id, entry)
}

async function refreshSessions($: EngineInterface) {
  const now = await $.clock.now()
  const live: MissionEntry[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const entry = (await $.store.get(key)) as MissionEntry | undefined
    if (!entry || typeof entry.updatedAt !== 'number') continue
    if (now - entry.updatedAt > FORGET_MS) await $.store.delete(key)
    else if (now - entry.updatedAt <= ALIVE_MS) live.push(entry)
  }
  live.sort((a, b) => STATUS_ORDER[statusOf(a)] - STATUS_ORDER[statusOf(b)] || a.project.localeCompare(b.project))
  await update($, sessionsAtom, () => live)
}

async function setWorking($: EngineInterface, isWorking: boolean) {
  await update($, workingAtom, () => isWorking)
  await publishSelf($)
  await refreshSessions($)
}

async function handleProgress($: EngineInterface, args: ProgressArgs) {
  const now = await $.clock.now()
  const current = await read($, planAtom)
  const fail = (text: string) => ({ deny: `progress: ${text}` })

  let next: Plan
  let recent: string | undefined

  switch (args.action) {
    case 'plan': {
      const steps = toSteps(args.steps)
      if (!args.title || steps.length === 0) return fail('"plan" needs a title and at least one step.')
      next = {
        title: args.title.trim().slice(0, 60),
        project: basename(await $.session.cwd()),
        steps: startNext(steps, now),
        startedAt: now,
        updatedAt: now,
      }
      await update($, activityAtom, () => EMPTY_ACTIVITY)
      recent = `Plan: ${next.title} (${steps.length} steps)`
      break
    }
    case 'start':
    case 'done':
    case 'skip': {
      if (current === null) return fail('no plan yet; call with action "plan" first.')
      const i = (args.step ?? 0) - 1
      if (i < 0 || i >= current.steps.length) return fail(`step must be 1-${current.steps.length}.`)
      const status: StepStatus = args.action === 'start' ? 'working' : args.action === 'done' ? 'done' : 'skipped'
      let steps = current.steps.map((s, j) =>
        j !== i
          ? s
          : {
              ...s,
              status,
              startedAt: s.startedAt ?? now,
              doneAt: status === 'working' ? undefined : now,
            },
      )
      if (status !== 'working') steps = startNext(steps, now)
      next = { ...current, steps, updatedAt: now, finishedAt: undefined }
      recent = `${STEP_ICON[status]} ${current.steps[i]!.title}`
      break
    }
    case 'add': {
      if (current === null) return fail('no plan yet; call with action "plan" first.')
      const added = toSteps(args.steps)
      if (added.length === 0) return fail('"add" needs at least one step.')
      next = { ...current, steps: startNext([...current.steps, ...added], now), updatedAt: now, finishedAt: undefined }
      recent = `Added ${added.length} step${added.length === 1 ? '' : 's'}`
      break
    }
    case 'note': {
      if (current === null) return fail('no plan yet; call with action "plan" first.')
      if (!args.note) return fail('"note" needs a note.')
      next = { ...current, updatedAt: now }
      break
    }
    case 'finish': {
      if (current === null) return fail('no plan to finish.')
      const steps = current.steps.map(s =>
        s.status === 'done' || s.status === 'skipped' ? s : { ...s, status: 'done' as StepStatus, startedAt: s.startedAt ?? now, doneAt: now },
      )
      next = { ...current, steps, updatedAt: now, finishedAt: now }
      recent = `Finished in ${fmtDur(now - current.startedAt)}`
      break
    }
    default:
      return fail('action must be one of plan, start, done, skip, add, note, finish.')
  }

  await update($, planAtom, () => next)
  if (recent) await addRecent($, { at: now, kind: 'Step', text: recent })
  if (args.note) await addRecent($, { at: now, kind: 'Note', text: args.note.trim().slice(0, 120) })
  await update($, tickAtom, () => now)
  await publishSelf($)

  if (args.action === 'plan' && next.steps.length >= AUTO_OPEN_MIN_STEPS) void openPane($, next)

  const pct = percentOf(next)
  const working = next.steps.findIndex(s => s.status === 'working')
  const tail = next.finishedAt
    ? 'Task finished.'
    : working === -1
      ? 'No step in progress.'
      : `Now on step ${working + 1}: ${next.steps[working]!.title}.`
  return { result: `Progress ${pct}% (${countDone(next)}/${next.steps.length} steps). ${tail}` }
}

// ── the HUD lines, drawn as claude-hud drew its status line ─────────────────

type Ui = ReturnType<EngineInterface['ui']['resolve']>

const HUD_BAR = 10
const MAX_AGENTS = 3
const AGENT_LINGER_MS = 60 * 1000

const agentElapsed = (ms: number) => {
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function drawHud(Box: Ui['Box'], Text: Ui['Text'], hud: Hud, now: number) {
  const sep = (thin = false) => <Text dimColor>{thin ? ' | ' : ' │ '}</Text>
  const joined = (parts: Array<RenderChildren | false | undefined>, thin = false): RenderChildren[] =>
    parts.filter((p): p is RenderChildren => Boolean(p)).flatMap((part, i) => (i === 0 ? [part] : [sep(thin), part]))
  const meter = (pct: number, color: string) => {
    const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * HUD_BAR)
    return [<Text color={color}>{'█'.repeat(filled)}</Text>, <Text dimColor>{'░'.repeat(HUD_BAR - filled)}</Text>]
  }
  const resets = (resetsAt: number | undefined) =>
    resetsAt !== undefined && resetsAt > now ? <Text dimColor> (resets in {fmtUntil(resetsAt - now)})</Text> : null

  // Line 1: [Opus 5.5 ◑ high] │ folder git:(main*) │ session name │ ⏱️  48m │ Cost $16.68
  const effort = hud.effort ? ` ${[effortSymbol(hud.effort), hud.effort].filter(Boolean).join(' ')}` : ''
  const line1 = joined([
    hud.model !== undefined && <Text color="cyan">[{hud.model}{effort}]</Text>,
    hud.project !== undefined && (
      <Text>
        <Text color="yellow">{hud.project}</Text>
        {hud.branch !== undefined && (
          <Text color="magenta">
            {' '}git:({hud.branch}
            {hud.isDirty ? '*' : ''})
          </Text>
        )}
        {(hud.addedDirs ?? []).slice(0, 5).map(dir => (
          <Text dimColor> +{dir}</Text>
        ))}
        {(hud.addedDirs ?? []).length > 5 && <Text dimColor> +{(hud.addedDirs ?? []).length - 5} more</Text>}
      </Text>
    ),
    hud.title !== undefined && (
      <Text dimColor wrap="truncate-end">
        {hud.title}
      </Text>
    ),
    hud.startedAt !== undefined && <Text dimColor>⏱️  {fmtSession(now - hud.startedAt)}</Text>,
    hud.costUsd !== undefined && <Text dimColor>Cost {fmtUsd(hud.costUsd)}</Text>,
  ])

  // Line 2: Context ████░░░░░░ 42% │ Usage ░░░░░░░░░░ 2% (resets in 4h 51m) | Weekly ██░░░░░░░░ 23% (resets in 6d 6h)
  const ctx = hud.contextPct
  const context =
    ctx !== undefined && (
      <Text>
        <Text dimColor>Context </Text>
        {meter(ctx, contextColor(ctx))}
        <Text color={contextColor(ctx)}> {ctx}%</Text>
        {ctx >= 85 && hud.contextTokens !== undefined && hud.contextWindow !== undefined && (
          <Text dimColor>
            {' '}({fmtTokens(hud.contextTokens)}/{fmtTokens(hud.contextWindow)})
          </Text>
        )}
      </Text>
    )
  const { fiveHour, sevenDay } = hud
  const limitHit = fiveHour?.pct === 100 ? fiveHour : sevenDay?.pct === 100 ? sevenDay : undefined
  const usage = limitHit
    ? [
        <Text>
          <Text dimColor>Usage </Text>
          <Text color="red">⚠ Limit reached</Text>
          {resets(limitHit.resetsAt)}
        </Text>,
      ]
    : [
        fiveHour && (
          <Text>
            <Text dimColor>Usage </Text>
            {meter(fiveHour.pct, quotaColor(fiveHour.pct))}
            <Text color={quotaColor(fiveHour.pct)}> {fiveHour.pct}%</Text>
            {resets(fiveHour.resetsAt)}
          </Text>
        ),
        sevenDay && (
          <Text>
            <Text dimColor>Weekly </Text>
            {meter(sevenDay.pct, quotaColor(sevenDay.pct))}
            <Text color={quotaColor(sevenDay.pct)}> {sevenDay.pct}%</Text>
            {resets(sevenDay.resetsAt)}
          </Text>
        ),
        hud.spend && (
          <Text>
            <Text dimColor>Spend </Text>
            {meter(hud.spend.pct, quotaColor(hud.spend.pct))}
            <Text color={quotaColor(hud.spend.pct)}> {hud.spend.pct}%</Text>
            {resets(hud.spend.resetsAt)}
          </Text>
        ),
      ]
  const usageParts = usage.filter(Boolean)
  const line2 = joined([context, usageParts.length > 0 && <Text>{joined(usageParts, true)}</Text>])

  // Agents: running ones first, then those that finished in the last minute.
  const running = hud.agents.filter(a => a.endedAt === undefined).slice(-MAX_AGENTS)
  const recent = hud.agents
    .filter(a => a.endedAt !== undefined && now - a.endedAt <= AGENT_LINGER_MS)
    .slice(-Math.min(2, MAX_AGENTS - running.length))
  const agents = [...running, ...(running.length < MAX_AGENTS ? recent : [])]

  // Todos: the one in progress, or all done.
  const done = hud.todos.filter(t => t.status === 'completed').length
  const current = hud.todos.find(t => t.status === 'in_progress')

  return (
    <Box flexDirection="column">
      {line1.length > 0 && <Text wrap="truncate-end">{line1}</Text>}
      {line2.length > 0 && <Text wrap="truncate-end">{line2}</Text>}
      {agents.map(a => {
        const model = shortModel(a.model)
        return (
          <Text key={`agent-${a.id}`} wrap="truncate-end">
            {a.endedAt === undefined ? <Text color="yellow">◐</Text> : <Text color="green">✓</Text>}{' '}
            <Text color="magenta">{a.type}</Text>
            {model && <Text dimColor> [{model}]</Text>}
            {a.description && <Text dimColor>: {a.description.slice(0, 40)}</Text>}
            <Text dimColor> ({agentElapsed((a.endedAt ?? now) - a.startedAt)})</Text>
          </Text>
        )
      })}
      {current ? (
        <Text wrap="truncate-end">
          <Text color="yellow">▸</Text> {current.content.slice(0, 50)}
          <Text dimColor>
            {' '}({done}/{hud.todos.length})
          </Text>
        </Text>
      ) : (
        hud.todos.length > 0 &&
        done === hud.todos.length && (
          <Text>
            <Text color="green">✓</Text> All todos complete
            <Text dimColor>
              {' '}({done}/{hud.todos.length})
            </Text>
          </Text>
        )
      )}
    </Box>
  )
}

export const register: Register = on => {
  let lastNudgeAt = 0
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    await update($, selfAtom, () => ({ id, project: basename(e.cwd) }))
    await update($, workingAtom, () => false)
    await $.command.register({
      name: 'sessions',
      description: 'Open or close Mission control: every open Claude session and its progress',
      immediate: true,
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Update the live progress panel the user watches: post a plan for a multi-step task, mark steps started/done, add notes, finish.',
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'progress',
      description: 'Open or close the live progress dashboard',
      immediate: true,
    })

    $.clock.every(TICK_MS, async () => {
      ticks += 1
      if (ticks % HEARTBEAT_EVERY === 0) await publishSelf($)
      if (ticks % REFRESH_EVERY === 0) await refreshSessions($)
      if (ticks % HUD_USAGE_EVERY === 0) await refreshUsage($)
      if (ticks % HUD_GIT_EVERY === 0) await refreshGit($)
      if (ticks % HUD_TITLE_EVERY === 0) await refreshTitle($)
      const plan = await read($, planAtom)
      if (plan === null || plan.finishedAt !== undefined) return
      const now = await $.clock.now()
      await update($, tickAtom, () => now)
    })

    // The bar under the prompt is the one summary; clear the status-line
    // entry earlier versions pinned there.
    $.ui.status(undefined)
    await publishSelf($)
    await refreshSessions($)
    await Promise.allSettled([refreshModel($), refreshUsage($), refreshGit($), refreshTitle($), refreshAddedDirs($)])

    return next(e)
  })

  // A folder added with /add-dir joins the HUD's folder part.
  on('classic.DirectoryAdded', async ($, e, next) => {
    await addDir($, e.directory)
    return next(e)
  })

  // The effort each main-loop request is sent with, for the HUD's model badge.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await setEffort($, e.effort)
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) await setRequestTokens($, result.usage)
    return result
  })

  // Working or waiting, as Mission control shows it.
  on('prompt.submit', async ($, e, next) => {
    await setWorking($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await setWorking($, false)
      await Promise.allSettled([refreshModel($), refreshUsage($), refreshGit($), refreshTitle($)])
    }
    return done
  })

  on('session.end', async ($, e, next) => {
    const self = await read($, selfAtom)
    if (self !== null) await $.store.delete(STORE_PREFIX + self.id)
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    if (await isPaneOpen($, MISSION)) {
      await $.ui.close({ id: MISSION })
      return { text: 'Mission control closed.' }
    }
    await refreshSessions($)
    const opened = await openMission($)
    return { text: opened.isPlaced ? 'Mission control opened.' : `Mission control is waiting: ${opened.reason}` }
  })

  // Tell the model how to use the board, only where it has the tool.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL_FULL)) return composed

    return { sections: [...composed.sections, { id: `${PLUGIN}:guide`, text: GUIDE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'progress' }, async $ => {
    if (await isPaneOpen($)) {
      await $.ui.close({ id: PANE })
      return { text: 'Progress dashboard closed.' }
    }
    const opened = await openPane($, await read($, planAtom))
    return { text: opened.isPlaced ? 'Progress dashboard opened.' : `Progress dashboard is waiting: ${opened.reason}` }
  })

  // Serves the board tool, and records edits and commands while a plan runs.
  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL_FULL) return handleProgress($, e as unknown as ProgressArgs)

    // Agents and todos for the HUD, whether or not a plan is on the board.
    const agentId = e.tool === 'Agent' ? (e.tool_use_id ?? `agent-${await $.clock.now()}`) : undefined
    if (e.tool === 'Agent' && agentId) {
      await agentStarted($, {
        id: agentId,
        type: e.subagent_type ?? 'agent',
        description: e.description,
        model: e.model,
        startedAt: await $.clock.now(),
      })
    } else if (e.tool === 'TodoWrite') {
      await setTodos($, e.todos.map(t => ({ content: t.content, status: t.status })))
    }

    const ran = await next(e)

    if (agentId) await agentEnded($, agentId, await $.clock.now())
    if (e.tool === 'TaskCreate' && ran.deny === undefined && ran.isError !== true) {
      const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
      await addTask($, { id, content: e.subject, status: 'pending' })
    } else if (e.tool === 'TaskUpdate' && ran.deny === undefined && ran.isError !== true) {
      await updateTask($, e.taskId, e.status, e.subject)
    }

    const plan = await read($, planAtom)
    if (plan === null || plan.finishedAt !== undefined) return ran

    const now = await $.clock.now()
    const isFailed = ran.deny === undefined && ran.isError === true

    if (e.tool === 'Edit' || e.tool === 'Write') {
      const file = e.file_path
      await update($, activityAtom, a => ({
        ...a,
        files: a.files.includes(file) ? a.files : [...a.files, file],
        recent: [...a.recent, { at: now, kind: e.tool, text: shortPath(file), isOk: !isFailed } as ActivityItem].slice(-RECENT_MAX),
      }))
    } else if (e.tool === 'Bash') {
      const command = e.command.replace(/\s+/g, ' ').trim()
      await update($, activityAtom, a => ({
        ...a,
        commands: a.commands + 1,
        recent: [...a.recent, { at: now, kind: 'Bash', text: command, isOk: !isFailed } as ActivityItem].slice(-RECENT_MAX),
      }))
    }

    // Check in: remind the main agent if the board has gone quiet.
    const quietSince = Math.max(plan.updatedAt, lastNudgeAt)
    if (e.agentId === undefined && ran.deny === undefined && now - quietSince >= CHECK_IN_MS) {
      lastNudgeAt = now
      return { ...ran, context: [...(ran.context ?? []), CHECK_IN] }
    }

    return ran
  })

  // ── the bar under the prompt, above the engine's hint line ─────────────
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const plan = await read($, planAtom)
    const sessions = await read($, sessionsAtom)
    const hud = await read($, hudAtom)
    await read($, tickAtom)
    const engineLine = await next(e)

    // The bar shows whenever there is a task, a finished one included. Earlier
    // versions had a Hide button; the flag it stored is no longer read.
    const showsPlan = plan !== null
    const showsSessions = sessions.length > 1

    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const hudLines = drawHud(Box, Text, hud, now)
    const isOpen = await isPaneOpen($)
    const isMissionOpen = await isPaneOpen($, MISSION)
    const width = Math.max(8, Math.min(20, Math.floor(((e.viewport?.columns ?? 100) - 80) / 2)))
    const working = sessions.filter(s => statusOf(s) === 'working').length

    return (
      <Box flexDirection="column">
        {(showsPlan || showsSessions) && (
        <Box flexDirection="row" gap={1}>
          {showsPlan && plan !== null && (
            <Box flexDirection="row" gap={1} flexShrink={1}>
              <Text color={plan.finishedAt !== undefined ? 'success' : 'claude'}>{plan.finishedAt !== undefined ? '✔' : '▸'}</Text>
              <Text bold wrap="truncate-end">
                {plan.title}
              </Text>
              <Text color={plan.finishedAt !== undefined ? 'success' : 'claude'}>{bar(percentOf(plan), width)}</Text>
              <Text bold>{percentOf(plan)}%</Text>
              <Text dimColor>
                · {countDone(plan)}/{plan.steps.length} · {fmtDur((plan.finishedAt ?? now) - plan.startedAt)}
              </Text>
              <Button
                key="toggle"
                label={isOpen ? 'Close' : 'Open'}
                hotkey="p"
                onPress={() => (isOpen ? $.ui.close({ id: PANE }) : openPane($, plan))}
              />
            </Box>
          )}
          <Button
            key="sessions"
            label={`Sessions ${sessions.length}${working > 0 ? ` · ${working} working` : ''}`}
            hotkey="s"
            onPress={async () => {
              if (isMissionOpen) return $.ui.close({ id: MISSION })
              await refreshSessions($)
              await openMission($)
            }}
          />
        </Box>
        )}
        {hudLines}
        {engineLine}
      </Box>
    )
  })

  // ── Mission control: every open session in one panel ────────────────────
  on('ui.render', { component: 'Pane', requestId: MISSION }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const sessions = await read($, sessionsAtom)
    const self = await read($, selfAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const cols = e.viewport?.columns ?? 80
    const showsBar = cols >= 70

    const count = (status: MissionStatus) => sessions.filter(s => statusOf(s) === status).length
    const summary = (['working', 'waiting', 'done', 'idle'] as const)
      .filter(status => count(status) > 0)
      .map(status => `${count(status)} ${status}`)
      .join(' · ')

    const detail = (s: MissionEntry) => {
      const status = statusOf(s)
      if (status === 'waiting') return 'waiting for you'
      if (status === 'done') return `done ${fmtClock(s.finishedAt ?? s.updatedAt)}`
      if (status === 'idle') return 'idle'
      if (s.step !== undefined && s.total !== undefined && s.startedAt !== undefined)
        return `step ${s.step}/${s.total} · ${fmtDur(now - s.startedAt)}`
      return 'working'
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Sessions</Text>
          <Text dimColor>{summary || 'none'}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {sessions.length === 0 && <Text dimColor>No open sessions yet.</Text>}
          {sessions.map(s => {
            const status = statusOf(s)
            const isSelf = s.id === self?.id
            return (
              <Box key={`session-${s.id}`} flexDirection="row" gap={1}>
                <Box width={2} flexShrink={0}>
                  <Text color={MISSION_COLOR[status]} dimColor={status === 'idle'}>
                    {MISSION_ICON[status]}
                  </Text>
                </Box>
                <Box width={16} flexShrink={0}>
                  <Text bold={isSelf} wrap="truncate-end">
                    {s.project}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end" dimColor={s.title === undefined}>
                    {s.title ?? '—'}
                  </Text>
                </Box>
                {showsBar && (
                  <Box width={10} flexShrink={0}>
                    <Text color={MISSION_COLOR[status]} dimColor={s.pct === undefined}>
                      {bar(s.pct ?? 0, 10)}
                    </Text>
                  </Box>
                )}
                <Box width={5} flexShrink={0} justifyContent="flex-end">
                  <Text bold>{s.pct === undefined ? '' : `${s.pct}%`}</Text>
                </Box>
                <Box width={18} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">
                    {detail(s)}
                    {isSelf ? ' · this' : ''}
                  </Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })

  // ── the dashboard pane: a stepper timeline ─────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const plan = await read($, planAtom)
    const activity = await read($, activityAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const cols = e.viewport?.columns ?? 60
    const rows = e.viewport?.rows ?? 24

    if (plan === null) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>No task in progress</Text>
          <Text dimColor>Claude posts a plan here when it starts a multi-step task.</Text>
        </Box>
      )
    }

    const pct = percentOf(plan)
    const eta = etaOf(plan, now)
    const isDone = plan.finishedAt !== undefined
    const elapsed = (plan.finishedAt ?? now) - plan.startedAt
    const barWidth = Math.max(10, Math.min(40, cols - 10))
    const textWidth = Math.max(10, cols - 22)

    const summary = isDone
      ? `${countDone(plan)} of ${plan.steps.length} steps · done in ${fmtDur(elapsed)}`
      : `${countDone(plan)} of ${plan.steps.length} steps · ${fmtDur(elapsed)} elapsed` +
        (eta === undefined ? '' : eta > 0 ? ` · ~${fmtDur(eta)} left` : ' · running over')

    // What the working step is doing right now: the last command or edit since it started.
    const workingStep = plan.steps.find(s => s.status === 'working')
    const lastAction = workingStep
      ? [...activity.recent].reverse().find(r => r.at >= (workingStep.startedAt ?? 0) && r.kind !== 'Note' && r.kind !== 'Step')
      : undefined
    const running = lastAction ? `${lastAction.kind === 'Bash' ? 'running' : 'editing'}: ${recentText(lastAction)}` : undefined

    // Fit the height: drop the connector lines first when the pane is short.
    const recent = activity.recent.slice(-3).reverse()
    const fixedRows = 5 + (recent.length > 0 ? recent.length + 2 : 0) + 2 + (running ? 1 : 0)
    const hasConnectors = fixedRows + plan.steps.length * 2 + 1 <= rows
    const stepColor = (s: Step) => (s.status === 'done' ? 'success' : s.status === 'working' ? 'claude' : undefined)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="truncate-end">
          {plan.title}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color={isDone ? 'success' : 'claude'}>{bar(pct, barWidth)}</Text>
          <Text bold>{pct}%</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {summary}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {plan.steps.map((s, i) => {
            const isWorking = s.status === 'working'
            const isQuiet = s.status === 'pending' || s.status === 'skipped'
            const time = stepTime(s, now)
            return (
              <Box key={`step-${i}`} flexDirection="column">
                <Box flexDirection="row">
                  <Box width={3} flexShrink={0}>
                    <Text color={stepColor(s)} dimColor={isQuiet}>
                      {STEP_ICON[s.status]}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end" bold={isWorking} dimColor={isQuiet} strikethrough={s.status === 'skipped'}>
                      {s.title}
                    </Text>
                  </Box>
                  <Box width={9} flexShrink={0} justifyContent="flex-end">
                    <Text dimColor={!isWorking} color={isWorking ? 'claude' : undefined} tabular>
                      {time === '' ? '' : isWorking ? `${time}…` : time}
                    </Text>
                  </Box>
                </Box>
                {isWorking && running && (
                  <Box flexDirection="row">
                    <Box width={3} flexShrink={0}>
                      <Text dimColor>│</Text>
                    </Box>
                    <Text dimColor wrap="truncate-end">
                      └ {clip(running, textWidth)}
                    </Text>
                  </Box>
                )}
                {hasConnectors && <Text dimColor>│</Text>}
              </Box>
            )
          })}
          <Box flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text color={isDone ? 'success' : undefined} dimColor={!isDone}>
                {isDone ? '✔' : '○'}
              </Text>
            </Box>
            <Text dimColor={!isDone} color={isDone ? 'success' : undefined}>
              Done
            </Text>
          </Box>
        </Box>

        {recent.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Recent</Text>
            {recent.map((item, i) => (
              <Box key={`recent-${i}`} flexDirection="row">
                <Box width={7} flexShrink={0}>
                  <Text dimColor tabular>
                    {fmtClock(item.at)}
                  </Text>
                </Box>
                <Box width={6} flexShrink={0}>
                  <Text color={item.kind === 'Note' ? 'suggestion' : item.kind === 'Step' ? 'claude' : undefined} dimColor={item.kind !== 'Note' && item.kind !== 'Step'}>
                    {item.kind}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end">{clip(recentText(item), textWidth)}</Text>
                </Box>
                {item.isOk === false && (
                  <Box width={2} flexShrink={0}>
                    <Text color="error"> ✘</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {activity.files.length} file{activity.files.length === 1 ? '' : 's'} · {activity.commands} command
            {activity.commands === 1 ? '' : 's'}
          </Text>
        </Box>
      </Box>
    )
  })
}
