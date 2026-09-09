// Claude Code encodes a working directory into its "projects" folder name by
// replacing path-separator-ish characters with '-'. Inferred from observed
// examples on this machine:
//   C:\AE\claude-work        -> C--AE-claude-work
//   C:\GitRepos\dwh_il       -> C--GitRepos-dwh-il
//   C:\GitRepos\SPOT1        -> C--GitRepos-SPOT1
// Best-effort, used only for an optional preview snippet: if it's ever wrong
// for some path shape, the effect is a missing preview, nothing else breaks.
export function encodeCwdForProjectDir(cwd) {
  return cwd.replace(/[:\\/_.]/g, '-');
}
