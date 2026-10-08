import { shQuote, winQuote } from './terminalCommand.mjs';

// session.cwd comes from transcript content, not from a trusted config
// file, and {cwd} only appears here at all when a user's own
// RESUME_COMMAND/ATTACH_COMMAND template opts into it (the shipped
// defaults don't) — same quoting rule terminalCommand.mjs uses for its own
// {cwd} substitution, so an unusual directory name (a quote, `&`, a space)
// can't break or inject into the resulting command line.
export function buildResumeCommand({ session, resumeTemplate, attachTemplate, platform = process.platform }) {
  const useAttach = session.live && session.kind === 'background' && session.id;
  const template = useAttach ? attachTemplate : resumeTemplate;
  const quotedCwd = platform === 'win32' ? winQuote(session.cwd) : shQuote(session.cwd);

  return template
    .replaceAll('{cwd}', quotedCwd)
    .replaceAll('{sessionId}', session.sessionId)
    .replaceAll('{id}', session.id ?? '');
}
