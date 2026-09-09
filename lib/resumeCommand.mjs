export function buildResumeCommand({ session, resumeTemplate, attachTemplate }) {
  const useAttach = session.live && session.kind === 'background' && session.id;
  const template = useAttach ? attachTemplate : resumeTemplate;

  return template
    .replaceAll('{cwd}', session.cwd)
    .replaceAll('{sessionId}', session.sessionId)
    .replaceAll('{id}', session.id ?? '');
}
