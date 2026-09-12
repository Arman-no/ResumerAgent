# ResumerAgent — Operating Notes

Read by every Claude Code session working in this repo, on any machine.
This project is worked on from more than one place (at least: the owner's
personal machine, and a separate work system behind Docker+a proxy) —
never at the same time, but at different times, so this rule is what keeps
that safe without any special coordination between sessions.

## Git collaboration hygiene — hard rule, every session

1. **Pull before starting work.** `git pull` before making any changes, so
   work never builds on stale state relative to what another session
   already pushed.
2. **Commit and push before ending a work session.** Not "I'll do it
   later" — if this session's clone is on an ephemeral machine/container
   that gets torn down before a push happens, that work is gone for good.
   Treat "did I push?" as a required last step, not an optional one.

As long as every session follows both rules, there is never a scenario
where one session's work destroys another's — no session is ever mid-edit
on the same lines a different session is also touching, since work never
overlaps in time. Skipping either rule (starting from stale state, or
leaving finished work unpushed) is what actually creates risk here, not
the multi-session setup itself.

## Context

- `docs/` holds this project's own design docs, one per feature/decision,
  named `YYYY-MM-DD-<topic>-design.md`. Check there before starting new
  work — a design doc may already exist for what you're about to build.
- See `README.md` and `AGENTS.md` for setup and architecture; `AGENTS.md`
  in particular is written as install + self-troubleshooting instructions
  for an agent picking this project up cold.
