import assert from 'node:assert/strict';
import {access, readFile, readdir, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skill = join(root, 'skills', 'walkthrough');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const within = (parent: string, path: string) => {
  const rel = relative(parent, path);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `${path} must remain inside ${parent}`);
};

test('portable and native plugin manifests describe the same guidance-only product', async () => {
  const portable = await json(join(root, 'plugin.json'));
  const native = await json(join(root, '.claude-plugin', 'plugin.json'));
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    assert.deepEqual(portable[key], native[key], `shared plugin field: ${key}`);
  }
  assert.equal(portable.name, 'walkthrough');
  assert.match(portable.version, /^\d+\.\d+\.\d+$/);
  assert.equal(portable.license, 'MIT');
  // Claude acquires dependencies when both inputs exist at plugin root.
  // The explicit installer, not guidance discovery, owns runtime acquisition.
  await assert.rejects(access(join(root, 'package.json')), {code: 'ENOENT'});
  await assert.rejects(access(join(root, 'package-lock.json')), {code: 'ENOENT'});
  assert.equal((await json(join(root, 'runtime', 'package.json'))).version, portable.version);
  assert.equal(portable.extensions['com.openai'].requires_local_executor, true);
  assert.deepEqual(Object.keys(portable.extensions), ['com.openai']);
  for (const manifest of [portable, native]) {
    for (const key of ['hooks', 'mcpServers', 'lspServers']) assert.equal(manifest[key], undefined);
  }
  for (const name of ['hooks', '.mcp.json', '.lsp.json']) {
    await assert.rejects(access(join(root, name)), {code: 'ENOENT'});
  }
  const presentation = portable.extensions['com.openai'].interface;
  assert.equal(presentation.displayName, 'Walkthrough');
  for (const key of ['composerIcon', 'logo']) {
    const path = resolve(root, presentation[key]);
    within(root, path);
    await access(path);
  }
  const icon = await readFile(join(root, '.claude-plugin', 'icon.png'));
  assert.equal(icon.subarray(1, 4).toString(), 'PNG');
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.ok(icon.length < 2 * 1024 * 1024);
});

test('one portable skill source and its host assets are reachable', async () => {
  assert.equal(await realpath(skill), skill);
  await assert.rejects(access(join(root, 'config', 'skills', 'walkthrough', 'SKILL.md')), {code: 'ENOENT'});
  const entry = await readFile(join(skill, 'SKILL.md'), 'utf8');
  const frontmatter = entry.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, 'skill frontmatter is present');
  const fields = Object.fromEntries(frontmatter[1].split('\n').map(line => {
    const match = line.match(/^([a-z-]+): (.+)$/);
    assert.ok(match, `portable frontmatter scalar: ${line}`);
    return [match[1], match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]];
  }));
  assert.deepEqual(Object.keys(fields).sort(), ['compatibility', 'description', 'license', 'name']);
  assert.equal(fields.name, 'walkthrough');
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024);
  assert.ok(fields.compatibility.length > 0 && fields.compatibility.length <= 500);
  assert.equal(fields.license, 'MIT');
  const metadata = await readFile(join(skill, 'agents', 'openai.yaml'), 'utf8');
  assert.match(metadata, /^  display_name: "Walkthrough"$/m);
  assert.match(metadata, /^  allow_implicit_invocation: true$/m);
  for (const match of metadata.matchAll(/^  icon_(?:small|large): (".*")$/gm)) {
    const path = resolve(skill, JSON.parse(match[1]));
    within(skill, path);
    await access(path);
  }
});

test('public owners and the complete authoring resource set have resolvable local links', async () => {
  const paths = ['README.md', 'VISION.md', 'ARCHITECTURE.md', 'QUALITY.md', 'SECURITY.md', 'docs/browser-authoring.md']
    .map(path => join(root, path));
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.md')) paths.push(path);
    }
  };
  await visit(skill);
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      const resolved = resolve(dirname(path), decodeURIComponent(target.split('#')[0]));
      within(root, resolved);
      await access(resolved);
    }
  }
});
