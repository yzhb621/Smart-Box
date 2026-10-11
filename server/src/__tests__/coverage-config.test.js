const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');

test('coverage configuration still loads YAML after the scoped dependency upgrade', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scb-coverage-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), '{}');
    await fs.writeFile(path.join(directory, '.nycrc.yaml'), 'all: true\ninclude:\n  - server/src/**\n');
    expect(await loadNycConfig({ cwd: directory })).toMatchObject({ all: true, include: ['server/src/**'] });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
