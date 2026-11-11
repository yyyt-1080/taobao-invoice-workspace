import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Windows PowerShell setup script stays ASCII-safe for Windows PowerShell 5', async () => {
  const bytes = await readFile(new URL('../../scripts/setup-windows.ps1', import.meta.url));
  assert.equal(bytes.some(byte => byte > 0x7f), false);
  const script = bytes.toString('ascii');
  assert.match(script, /Setup complete\./);
  assert.match(script, /Invoice details/);
});
