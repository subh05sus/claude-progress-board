import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityItem, Plan, Step, StepStatus } from '../types'

const PLUGIN = 'progress-board'
const PANE = 'progress'
const TOOL = 'progress'
const TOOL_FULL = `mcp__${PLUGIN}__${TOOL}`
const CHECK_IN_MS = 5 * 60 * 1000
const AUTO_OPEN_MIN_STEPS = 3
const BAND_LINGER_MS = 15 * 60 * 1000
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
const bandHiddenAtom = atom({ plugin: 'progress-board', key: 'isBandHidden' } as const, false)

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

const etaOf = (plan: Plan, now: number): number | undefined => {
  if (plan.finishedAt !== undefined) return undefined
  const done = doneWeight(plan)
  const left = totalWeight(plan) - done
  if (done === 0 || left <= 0) return undefined
  return ((now - plan.startedAt) / done) * left
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

const startNext = (steps: Step[], now: number): Step[] => {
  if (steps.some(s => s.status === 'working')) return steps
  const i = steps.findIndex(s => s.status === 'pending')
  return i === -1 ? steps : steps.map((s, j) => (j === i ? { ...s, status: 'working', startedAt: now } : s))
}

const STATUS_LABEL: Record<StepStatus, string> = {
  done: '✔ done',
  working: '● working',
  pending: '○ pending',
  skipped: '– skipped',
}

const STATUS_COLOR: Record<StepStatus, string | undefined> = {
  done: 'success',
  working: 'claude',
  pending: undefined,
  skipped: undefined,
}

const stepTime = (s: Step, now: number) =>
  s.startedAt === undefined ? '' : fmtDur((s.doneAt ?? (s.status === 'working' ? now : s.startedAt)) - s.startedAt)

// ── state changes ────────────────────────────────────────────────────────

const addRecent = ($: EngineInterface, item: ActivityItem) =>
  update($, activityAtom, a => ({ ...a, recent: [...a.recent, item].slice(-RECENT_MAX) }))

const showStatus = ($: EngineInterface, plan: Plan | null, now: number) => {
  if (plan === null) return $.ui.status(undefined)
  if (plan.finishedAt !== undefined) {
    return $.ui.status(`✔ ${plan.title} · done in ${fmtDur(plan.finishedAt - plan.startedAt)}`)
  }
  const pct = percentOf(plan)
  $.ui.status(`▰ ${pct}% · ${countDone(plan)}/${plan.steps.length} · ${plan.title} · ${fmtDur(now - plan.startedAt)}`)
}

const openPane = ($: EngineInterface, plan: Plan | null) =>
  $.ui.open({ id: PANE, title: plan ? `Progress · ${plan.project}` : 'Progress' })

const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

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
      await update($, bandHiddenAtom, () => false)
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
      recent = `${STATUS_LABEL[status]}: ${i + 1}. ${current.steps[i]!.title}`
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
  showStatus($, next, now)

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

export const register: Register = on => {
  let lastNudgeAt = 0

  on('session.start', async ($, e, next) => {
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
      const plan = await read($, planAtom)
      if (plan === null || plan.finishedAt !== undefined) return
      const now = await $.clock.now()
      await update($, tickAtom, () => now)
      showStatus($, plan, now)
    })

    const plan = await read($, planAtom)
    showStatus($, plan, await $.clock.now())

    return next(e)
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

    const ran = await next(e)
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

  // ── the band above the prompt ──────────────────────────────────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const plan = await read($, planAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const isStale = plan?.finishedAt !== undefined && now - plan.finishedAt > BAND_LINGER_MS

    if (e.props.hasSurvey || plan === null || isStale || (await read($, bandHiddenAtom))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const pct = percentOf(plan)
    const isOpen = await isPaneOpen($)
    const isDone = plan.finishedAt !== undefined
    const width = Math.max(8, Math.min(20, Math.floor(((e.viewport?.columns ?? 100) - 70) / 2)))

    return (
      <Box flexDirection="row" gap={1}>
        <Text color={isDone ? 'success' : 'claude'}>{isDone ? '✔' : '▸'}</Text>
        <Text bold wrap="truncate-end">
          {plan.title}
        </Text>
        <Text color={isDone ? 'success' : 'claude'}>{bar(pct, width)}</Text>
        <Text bold>{pct}%</Text>
        <Text dimColor>
          · {countDone(plan)}/{plan.steps.length} · {fmtDur((plan.finishedAt ?? now) - plan.startedAt)}
        </Text>
        <Button
          key="toggle"
          label={isOpen ? 'Close' : 'Open'}
          hotkey="p"
          onPress={() => (isOpen ? $.ui.close({ id: PANE }) : openPane($, plan))}
        />
        <Button key="hide" label="Hide" hotkey="h" onPress={() => update($, bandHiddenAtom, () => true)} />
      </Box>
    )
  })

  // ── the dashboard pane ─────────────────────────────────────────────────
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
    const barWidth = Math.max(10, Math.min(40, cols - 26))
    const recentRoom = Math.max(0, rows - plan.steps.length - 10)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold wrap="truncate-end">
          {plan.title}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color={isDone ? 'success' : 'claude'}>{bar(pct, barWidth)}</Text>
          <Text bold>{pct}%</Text>
          <Text dimColor>{isDone ? 'done' : eta !== undefined ? `ETA ~${fmtDur(eta)}` : 'ETA —'}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Box width={4}>
              <Text dimColor>#</Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor>Step</Text>
            </Box>
            <Box width={12}>
              <Text dimColor>Status</Text>
            </Box>
            <Box width={8}>
              <Text dimColor>Time</Text>
            </Box>
          </Box>
          {plan.steps.map((s, i) => (
            <Box key={`step-${i}`} flexDirection="row">
              <Box width={4}>
                <Text dimColor>{i + 1}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text
                  wrap="truncate-end"
                  bold={s.status === 'working'}
                  dimColor={s.status === 'pending' || s.status === 'skipped'}
                  strikethrough={s.status === 'skipped'}
                >
                  {s.title}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={STATUS_COLOR[s.status]} dimColor={s.status === 'pending' || s.status === 'skipped'}>
                  {STATUS_LABEL[s.status]}
                </Text>
              </Box>
              <Box width={8}>
                <Text dimColor tabular>
                  {stepTime(s, now)}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            Elapsed {fmtDur(elapsed)} · {activity.files.length} file{activity.files.length === 1 ? '' : 's'} changed ·{' '}
            {activity.commands} command{activity.commands === 1 ? '' : 's'}
          </Text>
        </Box>

        {recentRoom > 0 && activity.recent.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>{'─ Recent ' + '─'.repeat(Math.max(0, cols - 14))}</Text>
            {activity.recent
              .slice(-recentRoom)
              .reverse()
              .map((item, i) => (
                <Box key={`recent-${i}`} flexDirection="row" gap={1}>
                  <Text dimColor tabular>
                    {fmtClock(item.at)}
                  </Text>
                  <Box width={5}>
                    <Text color={item.kind === 'Note' ? 'suggestion' : item.kind === 'Step' ? 'claude' : undefined} dimColor={item.kind === 'Bash' || item.kind === 'Edit' || item.kind === 'Write'}>
                      {item.kind}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">{item.text}</Text>
                  </Box>
                  {item.isOk === false && <Text color="error">✘</Text>}
                </Box>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
