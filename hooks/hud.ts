import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Hud, HudAgent, HudLimit, HudTodo } from '../types'

// The HUD's values, gathered from the session as claude-hud gathered them from
// the status line's input: model and effort, folder and branch, the session's
// name, time, cost, context, the plan's usage windows, agents and todos.

const EMPTY_HUD: Hud = { agents: [], todos: [] }

const hudAtom = atom({ plugin: 'progress-board', key: 'hud' } as const, EMPTY_HUD, { shape: 'hud-1' })

const AGENT_RETENTION_MS = 60 * 1000
const TITLE_TAIL_BYTES = 400000

// ── formatting ───────────────────────────────────────────────────────────

const EFFORT_SYMBOL: Record<string, string> = { low: '○', medium: '◔', high: '◑', xhigh: '◕', max: '●' }

export const effortSymbol = (level: string) => EFFORT_SYMBOL[level] ?? ''

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

// "claude-opus-5-5[1m]" -> "Opus 5.5"; "opus" -> "Opus"; a display name stays as it is.
export const prettyModel = (raw: string) => {
  const id = raw.trim().replace(/\[[^\]]*\]$/, '')
  const current = id.match(/^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i)
  if (current) return `${capitalize(current[1]!)} ${current[2]}${current[3] ? `.${current[3]}` : ''}`
  if (/^(opus|sonnet|haiku|fable)$/i.test(id)) return capitalize(id)
  return id.replace(/\s*\([^)]*\bcontext\b[^)]*\)/i, '').trim() || raw
}

// Session time, as claude-hud wrote it: "<1m", "48m", "1h 5m".
export const fmtSession = (ms: number) => {
  const mins = Math.floor(Math.max(0, ms) / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// Time to a reset: "4h 51m", "6d 6h", "12m".
export const fmtUntil = (ms: number) => {
  const totalMins = Math.ceil(Math.max(0, ms) / 60000)
  if (totalMins < 60) return `${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

export const fmtUsd = (usd: number) => (usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`)

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

// Context: green, yellow from 70%, red from 85%. Usage: blue, magenta from 75%, red from 90%.
export const contextColor = (pct: number) => (pct >= 85 ? 'red' : pct >= 70 ? 'yellow' : 'green')
export const quotaColor = (pct: number) => (pct >= 90 ? 'red' : pct >= 75 ? 'magentaBright' : 'blueBright')

// "claude-haiku-4-5-20251001" -> "haiku-4.5", as claude-hud labels an agent's model.
export const shortModel = (model: string | undefined) => {
  if (!model) return undefined
  const id = model.trim().replace(/\[[^\]]*\]$/, '')
  const m = id.match(/^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i)
  return m ? `${m[1]!.toLowerCase()}-${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

// ── gathering ────────────────────────────────────────────────────────────

function setHud($: EngineInterface, patch: Partial<Hud>) {
  return update($, hudAtom, hud => ({ ...hud, ...patch }))
}

const toLimit = (limit: { percentUsed: number; resetsAt?: string } | undefined): HudLimit | undefined => {
  if (!limit || !Number.isFinite(limit.percentUsed)) return undefined
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return { pct: Math.min(100, Math.max(0, Math.round(limit.percentUsed))), ...(Number.isFinite(resetsAt) && { resetsAt }) }
}

/** Context, cost, session start and the plan's usage windows. */
export async function refreshUsage($: EngineInterface) {
  const usage = await $.session.usage()
  const { context } = usage
  // Claude Code reports no tokens before the first answer and in some modes; then
  // use the last main-loop request's input, as claude-hud fell back to its usage.
  const tokens = context.tokens ?? (await read($, hudAtom)).lastRequestTokens
  const pct =
    typeof context.percent === 'number' && context.percent > 0
      ? context.percent
      : tokens !== undefined && context.window > 0
        ? (tokens / context.window) * 100
        : 0
  await setHud($, {
    startedAt: usage.startedAt,
    costUsd: usage.cost?.usd,
    contextPct: Math.min(100, Math.max(0, Math.round(pct))),
    contextTokens: tokens,
    contextWindow: context.window,
    fiveHour: toLimit(usage.rateLimits.find(l => l.kind === 'five_hour')),
    sevenDay: toLimit(usage.rateLimits.find(l => l.kind === 'seven_day')),
    spend: toLimit(usage.rateLimits.find(l => l.kind === 'spend_limit')),
  })
}

const dirName = (dir: string) => {
  const name = dir.split('/').filter(Boolean).pop() ?? dir
  return name.length > 24 ? `${name.slice(0, 23)}…` : name
}

/** Folders added beyond the working one: from settings at start, then each /add-dir. */
export async function refreshAddedDirs($: EngineInterface) {
  try {
    const settings = (await $.settings.read()) as { permissions?: { additionalDirectories?: unknown } }
    const dirs = settings.permissions?.additionalDirectories
    if (Array.isArray(dirs)) {
      const names = dirs.filter((d): d is string => typeof d === 'string' && d.length > 0).map(dirName)
      await update($, hudAtom, hud => ({ ...hud, addedDirs: [...new Set([...(hud.addedDirs ?? []), ...names])] }))
    }
  } catch {
    // No settings to read.
  }
}

export async function addDir($: EngineInterface, dir: string) {
  const name = dirName(dir)
  await update($, hudAtom, hud => ({ ...hud, addedDirs: [...new Set([...(hud.addedDirs ?? []), name])] }))
}

// "claude-opus-5-5[1m]" or "claude-opus-5-5-20261001" -> "claude-opus-5-5", the key modelSettings uses.
const canonicalModel = (raw: string) => raw.trim().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')

/** The main loop's model, and the effort from settings until a request reports one. */
export async function refreshModel($: EngineInterface) {
  const raw = await $.session.model()
  const hud = await read($, hudAtom)
  let effort = hud.effort
  if (effort === undefined) {
    try {
      // The per-model setting (`/effort` saves it there) wins over the top-level one.
      const settings = await $.settings.read()
      const perModel = (settings as { modelSettings?: Record<string, { effortLevel?: unknown }> }).modelSettings?.[canonicalModel(raw)]
      const level = perModel?.effortLevel ?? (settings as { effortLevel?: unknown }).effortLevel
      if (typeof level === 'string') effort = level
    } catch {
      // No effort in settings: the first model request reports it.
    }
  }
  await setHud($, { model: prettyModel(raw), effort })
}

/** The context a main-loop request used: its input, cached or not. */
export async function setRequestTokens($: EngineInterface, usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  const lastRequestTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  await update($, hudAtom, hud => ({
    ...hud,
    lastRequestTokens,
    ...(hud.contextWindow && {
      contextTokens: lastRequestTokens,
      contextPct: Math.min(100, Math.max(0, Math.round((lastRequestTokens / hud.contextWindow) * 100))),
    }),
  }))
}

export async function setEffort($: EngineInterface, effort: string | number | undefined) {
  if (typeof effort === 'string') await setHud($, { effort })
}

/** The folder's name, its git branch and whether the tree has changes. */
export async function refreshGit($: EngineInterface) {
  const cwd = await $.session.cwd()
  const project = cwd.split('/').filter(Boolean).pop() ?? cwd
  try {
    const branch = await $.process.run(['git', 'branch', '--show-current'], { cwd, timeoutMs: 2000 })
    if (branch.exitCode !== 0) return setHud($, { project, branch: undefined, isDirty: undefined })
    const status = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=normal'], { cwd, timeoutMs: 3000 })
    await setHud($, {
      project,
      branch: branch.stdout.trim() || 'HEAD',
      isDirty: status.exitCode === 0 ? status.stdout.trim().length > 0 || status.isStdoutTruncated : undefined,
    })
  } catch {
    await setHud($, { project, branch: undefined, isDirty: undefined })
  }
}

/** The session's name: a /rename title, else the one Claude Code generated. */
export async function refreshTitle($: EngineInterface) {
  const id = await $.session.id()
  const script =
    'f=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$1".jsonl 2>/dev/null | head -1); ' +
    '[ -n "$f" ] && tail -c "$2" "$f" | grep -E \'"type":"(custom-title|ai-title)"\' | tail -40'
  try {
    const run = await $.process.run(['sh', '-c', script, 'sh', id, String(TITLE_TAIL_BYTES)], { timeoutMs: 3000 })
    let custom: string | undefined
    let ai: string | undefined
    for (const line of run.stdout.split('\n')) {
      try {
        const row = JSON.parse(line) as { type?: string; customTitle?: string; aiTitle?: string; title?: string }
        if (row.type === 'custom-title') custom = row.customTitle ?? row.title ?? custom
        if (row.type === 'ai-title') ai = row.aiTitle ?? row.title ?? ai
      } catch {
        // A cut or foreign line.
      }
    }
    const title = (custom ?? ai)?.trim().slice(0, 80)
    if (title) await setHud($, { title })
  } catch {
    // No transcript yet.
  }
}

// ── agents and todos, from the tools Claude calls ──────────────────────────

export async function agentStarted($: EngineInterface, agent: HudAgent) {
  const now = agent.startedAt
  await update($, hudAtom, hud => ({
    ...hud,
    agents: [...hud.agents.filter(a => a.endedAt === undefined || now - a.endedAt <= AGENT_RETENTION_MS), agent].slice(-10),
  }))
}

export async function agentEnded($: EngineInterface, id: string, endedAt: number) {
  await update($, hudAtom, hud => ({ ...hud, agents: hud.agents.map(a => (a.id === id ? { ...a, endedAt } : a)) }))
}

export async function setTodos($: EngineInterface, todos: HudTodo[]) {
  await update($, hudAtom, hud => ({ ...hud, todos }))
}

export async function addTask($: EngineInterface, task: HudTodo) {
  await update($, hudAtom, hud => ({ ...hud, todos: [...hud.todos, task] }))
}

export async function updateTask($: EngineInterface, id: string, status: string | undefined, subject: string | undefined) {
  await update($, hudAtom, hud => ({
    ...hud,
    todos: hud.todos
      .filter(t => !(t.id === id && status === 'deleted'))
      .map(t =>
        t.id !== id
          ? t
          : {
              ...t,
              content: subject ?? t.content,
              status: status === 'pending' || status === 'in_progress' || status === 'completed' ? status : t.status,
            },
      ),
  }))
}
