import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENTS } from '../agents.mjs'
import { mergeMcp, removeMcp, serverEntry, probeMcp, PRODUCTS, runAgent } from '../init.mjs'

test('client dialects preserve unrelated entries and uninstall only owned configurations', () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-install-test-'))
  try {
    for (const key of ['cursor', 'gemini', 'vscode', 'opencode', 'claude', 'qoder', 'trae', 'workbuddy', 'cline', 'dsh']) {
      const map = AGENTS[key].configKey ?? 'mcpServers', path = join(root, `${key}.json`)
      const original = { theme: 'user', [map]: { other: { command: 'foreign' } } }
      writeFileSync(path, JSON.stringify(original))
      const entry = serverEntry(key, PRODUCTS.memory, process.execPath), opts = { configKey: map, expectedEntry: entry }
      assert.equal(mergeMcp(path, 'craft-memory', entry, opts).changed, true)
      assert.equal(mergeMcp(path, 'craft-memory', entry, opts).changed, false)
      assert.equal(mergeMcp(path, 'craft-memory', { command: 'different' }, opts).blocked, true)
      assert.equal(removeMcp(path, 'craft-memory', { ...opts, expectedEntry: { command: 'different' } }).blocked, true)
      assert.equal(removeMcp(path, 'craft-memory', opts).changed, true)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original)
      assert.equal(mergeMcp(path, 'craft-memory', entry, { ...opts, dryRun: true }).changed, true)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original)
      assert.equal(removeMcp(path, 'craft-memory', opts).changed, false)
    }
    const path = join(root, 'invalid.json')
    for (const content of ['null', '[]', '{"mcpServers":[]}']) { writeFileSync(path, content); assert.throws(() => mergeMcp(path, 'a', {}, {})) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probe negotiates once, calls a real tool, fails closed, and never claims host activation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-probe-test-'))
  try {
    const script = join(root, 'fake.cjs')
    writeFileSync(script, `const rl=require('readline').createInterface({input:process.stdin});rl.on('line', l=>{const m=JSON.parse(l);if(!m.id)return;const result=m.id===1?{protocolVersion:'2025-11-25'}:m.id===2?{tools:[{name:'craft_info'}]}:{content:[],isError:false};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`)
    const result = await probeMcp('not-used', { type: 'local', command: [process.execPath, script] }, 1000)
    assert.equal(result.ok, true); assert.equal(result.level, 'tool_call_verified'); assert.equal(result.host_session_verified, false)
    for (const body of ["process.exit(0)", "process.stdout.write('oops\\n')", "process.stdout.write(JSON.stringify({id:1,error:{code:1}})+'\\n')", "process.stdout.write(JSON.stringify({id:1,result:{protocolVersion:'future'}})+'\\n')", "process.stdout.write('x'.repeat(4*1024*1024+1))", "setTimeout(()=>{},2000)"]) {
      writeFileSync(script, body); assert.equal((await probeMcp(process.execPath, { command: process.execPath, args: [script] }, 300)).ok, false)
    }
    assert.equal((await probeMcp('/does-not-exist', { command: '/does-not-exist', args: [] }, 500)).ok, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('failed real installation restores config and skill; dry run does not spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-rollback-test-')), prior = process.cwd(); process.chdir(root)
  try {
    const options = { node: '/does-not-exist', scope: 'project', mcp: true, skill: true, check: true }
    assert.equal((await runAgent('cursor', { ...options, dryRun: true }, PRODUCTS.memory)).ok, true)
    assert.equal(existsSync(join(root, '.cursor/mcp.json')), false)
    assert.equal((await runAgent('cursor', options, PRODUCTS.memory)).ok, false)
    assert.equal(existsSync(join(root, '.cursor/mcp.json')), false)
    assert.equal(existsSync(join(root, '.cursor/skills/craft-memory')), false)
  } finally { process.chdir(prior); rmSync(root, { recursive: true, force: true }) }
})

test('probe tolerates notifications and fragmentation, exercises readiness, and rejects incomplete surfaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-probe-contract-'))
  try {
    const file = join(root, 'server.cjs')
    for (const scenario of ['ready', 'tool-error', 'missing-content', 'missing-tools', 'empty-tools', 'wrong-product', 'no-result']) {
      writeFileSync(file, `const scenario=${JSON.stringify(scenario)};const rl=require('readline').createInterface({input:process.stdin});process.stderr.write('private diagnostic');process.stdout.write('\\n'+JSON.stringify({method:'notifications/hello'})+'\\n');rl.on('line',l=>{const m=JSON.parse(l);if(!m.id)return;let result=m.id===1?{protocolVersion:'2025-11-25'}:m.id===2?(scenario==='missing-tools'?{}:{tools:scenario==='empty-tools'?[]:[{name:'craft_component_readiness_get'}]}):scenario==='missing-content'?{}:{content:[],isError:scenario==='tool-error'};const response=JSON.stringify({id:m.id,...(scenario==='no-result'?{}:{result})})+'\\n';process.stdout.write(response.slice(0,5));setTimeout(()=>process.stdout.write(response.slice(5)),5)})`)
      const result = await probeMcp(process.execPath, { args: [file, '--product', scenario === 'wrong-product' ? 'other' : 'memory'] }, 1000)
      assert.equal(result.ok, scenario === 'ready')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('installer CLI lists clients and all expands without writes; per-target rollback restores existing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-install-main-')), prior = process.cwd(), cli = resolve('init.mjs'); process.chdir(root)
  try {
    assert.match(execFileSync(process.execPath, [cli, '--list'], { encoding: 'utf8' }), /cursor.*gemini.*vscode.*opencode/)
    assert.match(execFileSync(process.execPath, [cli, '--agent', 'all', '--dry-run', '--no-mcp', '--no-skill'], { encoding: 'utf8' }), /failures: 0/)
    assert.throws(() => execFileSync(process.execPath, [cli, '--agent', 'unknown'], { stdio: 'pipe' }), /未知 agent/)
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../init.mjs', import.meta.url).href)})`], { stdio: 'pipe' })
    const options = { node: process.execPath, mcp: true, skill: true, check: false }
    assert.equal((await runAgent('cursor', options, PRODUCTS.memory)).ok, true)
    const path = join(root, '.cursor/mcp.json'), original = readFileSync(path, 'utf8')
    const installedSkill = join(root, '.cursor/skills/craft-memory/SKILL.md'), beforeSkill = readFileSync(installedSkill, 'utf8')
    assert.equal((await runAgent('cursor', { ...options, node: '/missing', check: true, force: true }, PRODUCTS.memory)).ok, false)
    assert.equal(readFileSync(path, 'utf8'), original); assert.equal(readFileSync(installedSkill, 'utf8'), beforeSkill)
    writeFileSync(path, 'not json')
    await assert.rejects(() => runAgent('cursor', options, PRODUCTS.memory))
    assert.equal(readFileSync(path, 'utf8'), 'not json')
    writeFileSync(path, original)
    assert.equal((await runAgent('cursor', { ...options, uninstall: true }, PRODUCTS.memory)).ok, true)
    assert.equal(existsSync(installedSkill), false)
    assert.equal((await runAgent('cursor', { ...options, mcp: false, skill: false }, PRODUCTS.memory)).ok, true)
  } finally { process.chdir(prior); rmSync(root, { recursive: true, force: true }) }
})

test('the distributed bundle responds through standard and OpenCode launcher shapes for every product', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-distributed-probe-'))
  try {
    for (const product of Object.keys(PRODUCTS)) {
      const entry = serverEntry(product === 'memory' ? 'opencode' : 'cursor', PRODUCTS[product], process.execPath)
      if (Array.isArray(entry.command)) entry.environment = { CRAFT_DATA_DIR: join(root, product) }
      else entry.env = { CRAFT_DATA_DIR: join(root, product) }
      const result = await probeMcp(process.execPath, entry, 10000)
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.host_session_verified, false)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Experience installs reference files, repairs old single-file copies and protects local additions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-skill-tree-')), prior = process.cwd(); process.chdir(root)
  try {
    const options = { node: process.execPath, mcp: false, skill: true, check: false }
    const dir = join(root, '.cursor/skills/craft-experience'), ref = join(dir, 'references/composition.md')
    assert.equal((await runAgent('cursor', options, PRODUCTS.experience)).ok, true)
    const original = readFileSync(ref, 'utf8'); assert.match(original, /craft_procedure_plan/)
    assert.equal((await runAgent('cursor', options, PRODUCTS.experience)).ok, true)
    rmSync(ref)
    assert.equal((await runAgent('cursor', { ...options, dryRun: true }, PRODUCTS.experience)).ok, true)
    assert.equal(existsSync(ref), false)
    assert.equal((await runAgent('cursor', options, PRODUCTS.experience)).ok, true)
    assert.equal(readFileSync(ref, 'utf8'), original)
    writeFileSync(ref, 'user-edited reference')
    assert.equal((await runAgent('cursor', options, PRODUCTS.experience)).ok, false)
    assert.equal(readFileSync(ref, 'utf8'), 'user-edited reference')
    assert.equal((await runAgent('cursor', { ...options, uninstall: true }, PRODUCTS.experience)).ok, false)
    assert.equal((await runAgent('cursor', { ...options, force: true }, PRODUCTS.experience)).ok, true)
    const entry = join(dir, 'SKILL.md'), originalEntry = readFileSync(entry, 'utf8')
    writeFileSync(entry, originalEntry + '\nUser edits\n')
    assert.equal((await runAgent('cursor', { ...options, uninstall: true }, PRODUCTS.experience)).ok, false)
    writeFileSync(entry, originalEntry)
    writeFileSync(join(dir, 'notes.md'), 'user notes')
    assert.equal((await runAgent('cursor', { ...options, uninstall: true }, PRODUCTS.experience)).ok, false)
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), 'user notes')
    rmSync(join(dir, 'notes.md'))
    const { symlinkSync } = await import('node:fs')
    symlinkSync(ref, join(dir, 'linked.md'))
    await assert.rejects(() => runAgent('cursor', options, PRODUCTS.experience), /符号链接/)
    rmSync(join(dir, 'linked.md'))
    assert.equal((await runAgent('cursor', { ...options, uninstall: true, dryRun: true }, PRODUCTS.experience)).ok, true)
    assert.equal(existsSync(ref), true)
    assert.equal((await runAgent('cursor', { ...options, uninstall: true }, PRODUCTS.experience)).ok, true)
    assert.equal(existsSync(dir), false)
  } finally { process.chdir(prior); rmSync(root, { recursive: true, force: true }) }
})
