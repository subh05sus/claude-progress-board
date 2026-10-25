# Progress Board for Claude Code

A live progress dashboard inside the Claude Code terminal. Instead of asking Claude "how far along are you?" again and again, and getting the answer in a different format every time, you watch one panel that always looks the same and updates as Claude works.

**The bar above the prompt**: task, progress, steps done and elapsed time, with buttons to open the dashboard or hide the bar.

![Progress bar above the Claude Code prompt](docs/progress-bar.png)

**The dashboard panel**: progress bar, step table with status and time per step, live stats and a recent-activity feed.

<p align="center">
  <img src="docs/dashboard.png" alt="Progress dashboard panel in the Claude Code terminal" width="480">
</p>

## What you get

- **Dashboard panel**: progress bar, %, ETA, a step table with status and time per step, live stats (elapsed, files changed, commands run) and a recent-activity feed (edits, commands with ✘ on failure, Claude's notes).
- **Bar above the prompt**: task title, progress bar, %, steps done and elapsed time, with **Open/Close** and **Hide** buttons (click them, or press `p` / `h` once the bar has focus with `ctrl+x tab`).
- **`/progress`**: opens or closes the dashboard any time, even while Claude is working.
- **Status line entry** under the prompt: `▰ 62% · 3/5 · <task> · 14m`. It sits alongside any custom status line you already use.
- **Opens by itself** when Claude starts a task with 3 or more steps, if the terminal is wide enough (about 144 columns); otherwise use the button or `/progress`.

## How the % works

The plugin gives Claude a `progress` tool and tells it to use it. Before any task with 3 or more steps, Claude posts a plan: a title and steps, each with an effort weight of 1–5. It marks each step started and done as it goes, and the next step starts by itself. The % is the share of weighted steps that are done, and a step only counts once it is actually finished, so the bar never runs ahead of the work. The ETA comes from how fast steps have been finishing so far.

If Claude goes 5 minutes without updating the board during a task, it gets a reminder to update it (at most once every 5 minutes). Quick questions and single-step tasks don't use the board.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install progress-board --marketplace subh05sus/claude-progress-board
```

Answer `y` to add the marketplace, then press Enter to install for your user (all your sessions).

From a shell instead:

```
claude plugin install progress-board --marketplace subh05sus/claude-progress-board
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `subh05sus/claude-progress-board`, then **Add plugin**.

Sessions that were already open pick it up after a restart.

## Requirements

A recent version of Claude Code that supports plugins with function hooks (the plugin API is early access and may change between releases).

## Turn it off

Run `/plugin` and disable `progress-board`, or remove it:

```
claude plugin uninstall progress-board
```
