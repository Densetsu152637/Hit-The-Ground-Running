# Hit The Ground Running

A Claude Code mod that keeps long, agent-heavy sessions inside the plan's usage limits and gets them going again after a cap resets.

- **Usage push.** The plan's 5-hour and weekly readings (pushed by the engine as `session.measure`) are compared with tiers. Each time a tier is crossed the model gets one short hidden note, so it knows how much room is left without being asked.
- **Spawn gate.** Near a limit the mod refuses new subagents. Running agents finish and `SendMessage` to them still works. It matches the agent-pool usage gate of the workflow this mod was written for.
- **Auto-resume.** When a rate-limit stop is a real plan cap, the mod waits for the reset and then sends a clearly labeled resume prompt.
- **Compaction before resume.** If more than 25% of the context window is in use when the limits have reset, the session is compacted first, with instructions that keep the plan, decisions, subagent assignments, commits and the exact next step.

## Tiers and the gate

| Window | Warn note | Gate closes | Gate reopens |
| - | - | - | - |
| 5-hour | 70% | 85% | when the window resets |
| Weekly | 90% | 95% | when the window resets |

Notes are edge-triggered, once per window per reset period. A jump from below the warn tier straight to the gate gives the gate note alone. When the gate closes you also get a toast; when the window resets one "gate reopened" note and toast follow.

While the gate is closed the mod answers `{ deny }` to the `Agent` tool and to `agent.spawn` (workflow agents and teammates included). A resumed agent is not a new one and passes. The hooks fail open, as Claude Code hooks do, except that each carries a `.catch` that refuses only while the gate is closed, so a failed check never blocks spawning when usage is low.

The status line shows a compact reading: `HTGR · 5h 62% wk 41% · gate open · resume 06:03 (in 2h14m)`.

## Auto-resume

A resume is scheduled from three sources:

1. **A rate-limit cap.** On a `StopFailure` with `error: "rate_limit"` the mod reads this session's usage. Only if some window reads at least 98% with a reset still ahead is it treated as a plan cap; a transient 429 is ignored and nothing is scheduled.
2. **`/htgr-pause`** (see below).
3. **A stored schedule.** The schedule is kept in the mod's store (`{ sessionId, resetsAt, reason, attempts }` plus the fire time), so an app restart or a mod reload re-arms it when the session starts again. A schedule more than a day overdue is dropped.

The resume fires at the reset plus 30 to 90 seconds of jitter. About a minute before, a toast says so; `/htgr-cancel` stops it. At fire time the mod:

1. waits for the session to be idle (it retries every 30 seconds for up to 10 minutes);
2. re-reads the usage. If a window is still at its gate tier it re-arms for that window's reset. That counts as an attempt; after 2 re-arms it stops and tells you (toast and notification);
3. compacts if the context is over 25% (below);
4. submits: *"Usage limits reset (Hit The Ground Running). Continue where you stopped; re-check the agent-pool usage gate before spawning. If a limit is hit again, stop."* The model reads it as a message from this mod.

Safety: if you type anything in the session after the halt, the schedule is cancelled; you are back. Prompts from background tasks, the mod's own commands and `isMeta` rows do not count. The mod never approves anything: permission prompts still wait for you.

### The reading is this session's last API response

The engine hands the mod the rate-limit figures of the last response. After a cap that reading stays frozen at the pre-halt value. The mod treats a window whose reset time has passed as reset (0%), which is what makes "the limits have reset" checkable without a fresh response. It cannot see usage spent by other sessions or devices since then; if they used the new window up, the resume simply hits the limit again and the mod, being at a new `StopFailure`, schedules the next reset.

### Compaction before resume

Compaction runs only when **both** hold:

1. the limits have reset (re-checked readings are below the gate tiers) and the session is idle between turns, so `$.session.compact` can run; and
2. more than 25% of the context window is used, from the last response's token count over the window. If the size cannot be read, compaction is skipped.

Never during a cap, never while gated. If compaction fails or a hook vetoes it, the resume still goes and a toast says so.

## Native auto-continue and the `fiveHourResume` option

Claude Code already has an auto-continue for 5-hour caps: the desktop app's **Auto-continue when limits reset** checkbox on the session-limit card, and the CLI's `autoContinueAtUsageLimit` setting (**Continue automatically at usage limit** in `/config`). The two are separate switches. Neither covers the weekly limit. To avoid two resumes, the mod has two modes:

| `fiveHourResume` | Behaviour |
| - | - |
| `native` (default) | The mod does not resume 5-hour caps. It tells you the native one is expected, and takes no action. **No compaction happens in this mode:** the host refuses a compaction raised from the prompt hook (it would run under the turn that hook holds), and the mod cannot tell in advance that the native resume is about to fire. |
| `mod` | The mod owns 5-hour resumes, including compaction. **Turn the native auto-continue off** (desktop checkbox; `autoContinueAtUsageLimit: false`) or both will resume the session. |

Recommended: if you want compaction before 5-hour resumes, use `fiveHourResume: mod` and switch the native one off. Otherwise leave the default and the native resume, and use the mod for the gate and the notes.

`weeklyResume` (`on` by default, or `off`) controls weekly caps, which only this mod resumes. `/htgr-pause` is always the mod's.

Set both in the plugin's config menu or under `pluginConfigs` in settings.

## Keep the computer awake

A timer in a sleeping machine does not fire, and the mod cannot wake it. For an unattended resume:

- Desktop app: **Settings > This computer > System > Keep computer awake**. The app must stay open; a closed laptop lid still sleeps the machine.
- CLI: the terminal session must be open and the machine awake.

If the machine slept through a reset, the resume fires shortly after the session loads again (up to a day late), unless you typed first.

## Commands

| Command | What it does |
| - | - |
| `/htgr` | Readings, gate state, the pending resume and its re-arm count, the options. |
| `/htgr-pause [HH:MM \| reset]` | Stops the running turn if there is one and schedules a resume at the local time `HH:MM` (the next time that clock reads) or, with `reset` or no argument, at the next 5-hour reset. Use it to park work deliberately. |
| `/htgr-cancel` | Cancels the pending resume. |

## Not feasible

- **Compacting subagents.** `$.session.compact` takes no agent id, so a subagent's context cannot be compacted from a mod. Subagents keep their own context, and their results flow back through the main session, which is the one this mod compacts.
- **Compaction during a cap.** The summary is a model request; it needs usage. The mod only compacts after the reset.
- **Compaction in `native` mode** (see above). Use `mod` mode.
- **Waking a sleeping machine.** See above.
- **Account-wide fresh usage.** The mod has this session's last API response, not a live account query.

## Install

In a terminal session:

```
/plugin install hit-the-ground-running --marketplace Densetsu152637/Hit-The-Ground-Running
```

From a shell:

```
claude plugin install hit-the-ground-running --marketplace Densetsu152637/Hit-The-Ground-Running
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Densetsu152637/Hit-The-Ground-Running`, then Add plugin.

Requires a Claude Code build with function-hook mods (2.1.308 was used to build and test).

## Develop

```
claude plugin validate .
claude plugin test .
```

The hooks module is `hooks/register.ts`, pure helpers are in `hooks/logic.ts`, and the tests run the module against an in-memory engine (`hooks/harness.ts`).

## License

MIT. See `LICENSE`.
