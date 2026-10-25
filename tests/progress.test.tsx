import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__progress-board__progress'

const PANE = {
  plugin: 'progress-board',
  component: 'Pane',
  requestId: 'progress',
  props: {
    title: 'Progress · my-app',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

let now = Date.UTC(2026, 9, 25, 10, 0, 0)

// The store all sessions share, in memory.
const store = new Map<string, unknown>()

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  store.clear()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'this-session' }))
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__progress-board__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/Users/me/projects/my-app' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
}

test('a plan and a finished step show in the dashboard', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/Users/me/projects/my-app', surface: 'terminal', isInteractive: true })

  const planned = await $.tool.call({
    tool: TOOL,
    action: 'plan',
    title: 'Revamp settings page',
    steps: [
      { title: 'Audit current pages', weight: 1 },
      { title: 'Fix auth on grade routes', weight: 1 },
      { title: 'New settings form', weight: 2 },
    ],
  })
  expect(String(planned.result)).toContain('Progress 0%')

  now += 4 * 60 * 1000 + 10 * 1000
  const done = await $.tool.call({ tool: TOOL, action: 'done', step: 1 })
  expect(String(done.result)).toContain('Progress 25%')
  expect(String(done.result)).toContain('Now on step 2')

  await $.tool.call({ tool: 'Bash', command: 'pnpm tsc --noEmit' })
  await $.tool.call({ tool: 'Bash', command: 'cd /Users/me/projects/my-app && FOO=1 claude plugin list 2>&1 | grep -B1 progress' })
  await $.tool.call({ tool: 'Edit', file_path: '/Users/me/projects/my-app/app/settings/form.tsx', old_string: 'a', new_string: 'b' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /settings page/ }))?.text).toBe('Revamp settings page')
    expect((await ui.find({ type: 'Text', text: /^25%$/ }))?.text).toBe('25%')
    expect((await ui.find({ type: 'Text', text: /of 3 steps/ }))?.text).toBe('1 of 3 steps · 4m 10s elapsed · ~12m 30s left')
    expect((await ui.find({ type: 'Text', text: /^4m 10s$/ }))?.text).toBe('4m 10s')
    expect((await ui.find({ type: 'Text', text: /^0s…$/ }))?.text).toBe('0s…')
    expect((await ui.find({ type: 'Text', text: /editing:/ }))?.text).toBe('└ editing: form.tsx')
    // Recent: the last 3 events, newest first, each one short line.
    const recent = (await ui.findAll({ type: 'Text', text: /^(form\.tsx|claude plugin list …|pnpm tsc --noEmit|✔ Audit current pages)$/ })).map(t => t.text)
    expect(recent).toEqual(['form.tsx', 'claude plugin list …', 'pnpm tsc --noEmit'])
    expect((await ui.find({ type: 'Text', text: /command/ }))?.text).toBe('1 file · 2 commands')
    await ui.unmount()
  }
})

test('finish takes the plan to 100%', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'plan', title: 'Small job', steps: [{ title: 'One' }, { title: 'Two' }] })
  const finished = await $.tool.call({ tool: TOOL, action: 'finish' })
  expect(String(finished.result)).toContain('Progress 100%')
})

test('a step before any plan is refused with a hint', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const refused = await $.tool.call({ tool: TOOL, action: 'done', step: 1 })
  expect(refused.deny).toContain('call with action "plan" first')
})

test('the empty dashboard says what it is for', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No task in progress')
  await ui.unmount()
})

test('a quiet board gets a check-in after 5 minutes, then not again right away', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'plan', title: 'Long job', steps: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] })

  now += 2 * 60 * 1000
  const early = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(early.context ?? []).toHaveLength(0)

  now += 4 * 60 * 1000
  const late = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect((late.context ?? []).join(' ')).toContain('in over 5 minutes')

  now += 60 * 1000
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(again.context ?? []).toHaveLength(0)
})

const HINT = { plugin: 'progress-board', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

const engineHint = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>? for shortcuts</Text>
  })

test('the bar sits under the prompt, above the hint line, and stays after the task is done', async ($, on) => {
  engine(on)
  engineHint(on)
  await $.session.start({ cwd: '/Users/me/projects/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'plan', title: 'Ship it', steps: [{ title: 'One' }, { title: 'Two' }] })
  await $.tool.call({ tool: TOOL, action: 'finish' })
  now += 5 * 60 * 60 * 1000

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Ship it/ }))?.text).toBe('Ship it')
  expect((await ui.find({ type: 'Text', text: /^100%$/ }))?.text).toBe('100%')
  expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /for shortcuts/ }))?.text).toBe('? for shortcuts')
  await ui.unmount()
})

test('Mission control lists every live session, with a button beside Open and Hide', async ($, on) => {
  engine(on)
  engineHint(on)
  store.set('session:other-1', { id: 'other-1', project: 'reelcut', updatedAt: now, isWorking: false, title: 'Fix export crash', pct: 30, done: 1, total: 3, startedAt: now - 60000 })
  store.set('session:other-2', { id: 'other-2', project: 'claude-hud', updatedAt: now, isWorking: true, title: 'Add sparkline', pct: 88, done: 7, total: 8, step: 8, startedAt: now - 6 * 60000 })
  store.set('session:gone', { id: 'gone', project: 'old', updatedAt: now - 10 * 60000, isWorking: false })

  await $.session.start({ cwd: '/Users/me/projects/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: TOOL, action: 'plan', title: 'Revamp gradebook', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })

  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await hint.find({ type: 'Button', key: 'toggle' })).toBeDefined()
  expect(await hint.find({ type: 'Button', key: 'sessions' })).toBeDefined()
  await hint.unmount()

  const ui = await $.ui.mount({ plugin: 'progress-board', component: 'Pane', requestId: 'mission', props: { ...PANE.props, title: 'Mission control', bodyColumns: 100 }, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /working ·|waiting/ }))?.text).toBe('1 working · 2 waiting')
  expect((await ui.find({ type: 'Text', text: /^reelcut$/ }))?.text).toBe('reelcut')
  expect((await ui.find({ type: 'Text', text: /Add sparkline/ }))?.text).toBe('Add sparkline')
  expect((await ui.find({ type: 'Text', text: /step 8\/8/ }))?.text).toBe('step 8/8 · 6m 00s')
  expect((await ui.find({ type: 'Text', text: /waiting for you · this/ }))?.text).toBe('waiting for you · this')
  expect(await ui.find({ type: 'Text', text: /^old$/ })).toBeUndefined()
  await ui.unmount()

  // The session's own entry is in the shared store for the other sessions to read.
  expect((store.get('session:this-session') as { title?: string })?.title).toBe('Revamp gradebook')
})
