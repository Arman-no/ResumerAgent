import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { purgeSessionFiles } from './purgeSession.mjs';

// Synthetic sessions root only — never a real one.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeragent-purge-test-'));
  const projectDir = path.join(root, 'projects', 'C--fake');
  fs.mkdirSync(projectDir, { recursive: true });
  const id = '11111111-2222-3333-4444-555555555555';
  const filePath = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(filePath, '{}\n');
  fs.mkdirSync(path.join(projectDir, id));
  return { root, projectDir, id, session: { sessionId: id, cwd: 'C:\\fake', filePath } };
}

test('moves the transcript and its companion dir into the trash', () => {
  const { root, projectDir, id, session } = fixture();
  const { movedTo, moved } = purgeSessionFiles(root, session);
  assert.deepEqual(moved, [`${id}.jsonl`, id]);
  assert.ok(fs.existsSync(path.join(movedTo, `${id}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(projectDir, `${id}.jsonl`)));
});

// renameSync used to silently overwrite an earlier trashed copy.
test('refuses, and moves nothing, when the trash already holds that session', () => {
  const { root, projectDir, id, session } = fixture();
  const trashDir = path.join(root, '.resumeragent-trash', 'C--fake');
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(path.join(trashDir, `${id}.jsonl`), 'older copy');
  assert.throws(() => purgeSessionFiles(root, session), /already contains/);
  assert.ok(fs.existsSync(path.join(projectDir, `${id}.jsonl`)));
  assert.equal(fs.readFileSync(path.join(trashDir, `${id}.jsonl`), 'utf8'), 'older copy');
});
