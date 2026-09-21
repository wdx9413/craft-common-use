#!/usr/bin/env node
/**
 * Craft Common Use — one-shot scaffold that installs the generic Craft skill
 * + MCP into a coding agent (Cline / Qoder / Trae / WorkBuddy).
 *
 * Fully self-contained: the MCP bundle, parser worker and every SKILL.md live
 * in THIS folder (bundle/ and skills/), so this script never reads anything
 * from craft-marketplace or the craft source repo at runtime.
 *
 * Everything the script touches is idempotent:
 *   - MCP configs are merged (existing servers and settings are preserved);
 *   - an identical existing entry is a no-op, a conflicting one needs --force;
 *   - skills are copied as-is and only overwritten with --force.
 *
 * Verified conventions live in ./agents.mjs (each entry cites its source).
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AGENTS } from './agents.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, 'bundle', 'craft-mcp.cjs')
const WORKER = join(HERE, 'bundle', 'craft-parser-worker.js')
const SKILLS_ROOT = join(HERE, 'skills')
const SCAFFOLD_VERSION = '0.1.0'

// `mcp` records whether *this* bundle serves the product. The bundle is one
// multi-product server whose supported set is `MCP_PRODUCT_SURFACES` inside it:
// full, knowledge, memory, experience. The remaining products ship a Skill only --
// their MCP lives in the per-plugin marketplace bundles, which this deliberately
// self-contained folder does not carry. Declaring that here is what stops
// `--product context` from writing an MCP entry that can never start.
const PRODUCTS = {
  'full':              { server: 'craft',                 product: 'full',       skill: 'craft-route',          mcp: true },
  'context':           { server: 'craft-context',         product: 'context',    skill: 'craft-context',        mcp: false },
  'memory':            { server: 'craft-memory',           product: 'memory',     skill: 'craft-memory',         mcp: true },
  'knowledge':         { server: 'craft-knowledge',       product: 'knowledge',  skill: 'craft-knowledge',      mcp: true },
  'capability':        { server: 'craft-capability',      product: 'capability', skill: 'craft-capability',     mcp: false },
  'quality':           { server: 'craft-quality',         product: 'quality',    skill: 'craft-quality',        mcp: false },
  'skill-quality':     { server: 'craft-skill-quality',   product: 'quality',    skill: 'craft-skill-quality',  mcp: false },
  'experience':        { server: 'craft-experience',      product: 'experience', skill: 'craft-experience',     mcp: true },
}
const SKILL_ONLY_NOTE = 'MCP 见 craft-marketplace 的同名插件包'


function parseArgs(argv) {
  const options = { agents: [], product: 'full', scope: null, node: process.execPath, dryRun: false, force: false, uninstall: false, mcp: true, skill: true, check: true, list: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--agent') options.agents.push(...(argv[++i] ?? '').split(',').filter(Boolean))
    else if (arg === '--product') options.product = argv[++i]
    else if (arg === '--scope') options.scope = argv[++i]
    else if (arg === '--node') options.node = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--no-mcp') options.mcp = false
    else if (arg === '--no-skill') options.skill = false
    else if (arg === '--no-check') options.check = false
    else if (arg === '--list') options.list = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function printHelp() {
  console.log('用法: node init.mjs --agent <cline|qoder|trae|workbuddy|all> [--product full] [--scope user|project] [--dry-run] [--force] [--uninstall] [--list]')
}

/** cmd /c for %I in ("path") do @echo %~sI — needed because Trae rejects a
 *  command containing spaces (docs.trae.cn, stdio 配置说明). */
function windowsShortPath(p) {
  if (process.platform !== 'win32' || !/\s/.test(p)) return { path: p, adjusted: false }
  try {
    const out = execFileSync('cmd.exe', ['/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8' }).trim()
    if (out && !/\s/.test(out) && existsSync(out)) return { path: out, adjusted: out.toLowerCase() !== p.toLowerCase() }
  } catch { /* fall through */ }
  return { path: p, adjusted: false }
}

/** Trae-compatible interpreter: Trae rejects a command containing spaces
 *  (docs.trae.cn). Try, in order: 8.3 short path, then known space-free node
 *  installs on this machine. Throws with guidance when nothing works. */
function traeCommand(node) {
  const short = windowsShortPath(node)
  if (short.adjusted) console.log(`  兼容处理：Trae 不允许 command 含空格，已改用 8.3 短路径 ${short.path}`)
  if (!/\s/.test(short.path)) return short.path
  const versionsDir = join(homedir(), '.workbuddy-ai', 'binaries', 'node', 'versions')
  const candidates = []
  try {
    const versions = existsSync(versionsDir)
      ? readdirSync(versionsDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      : []
    for (const version of versions) candidates.push(join(versionsDir, version, 'node.exe'))
  } catch { /* best effort */ }
  candidates.push('C:\\Program Files\\nodejs\\node.exe')
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const fixed = windowsShortPath(candidate)
    if (!/\s/.test(fixed.path)) {
      console.log(`  兼容处理：解释器路径含空格，Trae 配置改用 ${fixed.path}`)
      return fixed.path
    }
  }
  throw new Error(`Trae 的 command 不能包含空格，且未找到可用的空格路径 node；请用 --node 指定（当前 ${node}）`)
}

function serverEntry(agentKey, productSpec, node) {
  const args = [BUNDLE, '--product', productSpec.product]
  if (agentKey === 'trae') {
    return { command: traeCommand(node), args, env: { START_MCP_TIMEOUT_MS: '60000', RUN_MCP_TIMEOUT_MS: '60000' } }
  }
  if (agentKey === 'workbuddy') return { type: 'stdio', command: node, args, timeout: 30000 }
  if (agentKey === 'qoder') return { command: node, args, timeout: 60000 }
  return { command: node, args } // cline
}


function mergeMcp(mcpPath, serverName, entry, { dryRun, force }) {
  let root = {}
  if (existsSync(mcpPath)) {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'))
    if ((parsed !== null && typeof parsed !== 'object') || Array.isArray(parsed)) throw new Error(`${mcpPath} 的内容不是 JSON 对象，拒绝修改`)
    root = parsed
  }
  if (root.mcpServers === undefined) root.mcpServers = {}
  const existing = root.mcpServers[serverName]
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { changed: false, note: '已是目标配置，无需改动' }
  }
  if (existing !== undefined && !force) {
    return { changed: false, blocked: true, note: `已存在不同配置：${JSON.stringify(existing)}（用 --force 覆盖）` }
  }
  if (!dryRun) {
    root.mcpServers[serverName] = entry
    mkdirSync(dirname(mcpPath), { recursive: true })
    writeFileSync(mcpPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  }
  return { changed: true, note: dryRun ? '[dry-run] 将写入' : (existing === undefined ? '新增' : '已用 --force 覆盖旧配置') }
}

function removeMcp(mcpPath, serverName, { dryRun }) {
  if (!existsSync(mcpPath)) return { changed: false, note: '配置文件不存在' }
  const root = JSON.parse(readFileSync(mcpPath, 'utf8'))
  if (root?.mcpServers?.[serverName] === undefined) return { changed: false, note: '未发现该 server，无需改动' }
  if (!dryRun) {
    delete root.mcpServers[serverName]
    writeFileSync(mcpPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  }
  return { changed: true, note: dryRun ? '[dry-run] 将移除' : '已移除' }
}

/**
 * DSH keeps MCP servers as cordis loader rows inside cordis.patch.yml, in the
 * exact shape DSH's own manager (dsh-plugin-tool-management) emits:
 *
 *   # dsh-plugin-tool-management:server:<id>
 *   - insert:
 *       - id: <id>
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config: { serverName, transport, command, args }
 *
 * The comment marker delimits the block: that is what makes install idempotent,
 * uninstall exact, and a --force rewrite bounded. Because this file decides
 * whether the harness boots at all, every write is preceded by a timestamped
 * backup in the same place the host manager keeps its own.
 */
const DSH_BLOCK_MARKER = '# dsh-plugin-tool-management:server:'
const DSH_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Same loader id rule as the host manager: `mcp-` + lowercased, [a-z0-9-] only. */
function dshLoaderId(serverName) {
  return `mcp-${serverName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

function dshQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function dshInsertBlock(serverName, entry) {
  const id = dshLoaderId(serverName)
  const lines = [
    `${DSH_BLOCK_MARKER}${id}`,
    '- insert:',
    `    - id: ${id}`,
    `      name: '${DSH_MCP_CLIENT}'`,
    '      config:',
    `        serverName: ${dshQuote(serverName)}`,
    '        transport: "stdio"',
    `        command: ${dshQuote(entry.command)}`,
    '        args:',
  ]
  for (const arg of entry.args) lines.push(`          - ${dshQuote(arg)}`)
  return lines
}

/**
 * Split the patch into the head (comments / any foreign rows) and one entry per
 * top-level `- insert:` block.
 *
 * The host manager writes the marker comment only for the FIRST block it adds
 * and leaves later blocks bare, so a block boundary is the indentation-0
 * `- insert:` line, and a block's identity comes from its own `- id:` row —
 * never from the comment, which may be absent.
 */
function splitDshPatch(text) {
  const head = []
  const blocks = []
  let current = null
  let pendingComment = null
  const flush = () => {
    if (current === null) return
    const idLine = current.find((line) => /^\s+-\s+id:\s*\S+/.test(line))
    const id = idLine === undefined ? null : idLine.replace(/^\s+-\s+id:\s*/, '').trim()
    blocks.push({ id, lines: current })
    current = null
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(DSH_BLOCK_MARKER)) {
      flush()
      pendingComment = line
      continue
    }
    if (/^- insert:\s*$/.test(line)) {
      flush()
      current = []
      if (pendingComment !== null) { current.push(pendingComment); pendingComment = null }
      current.push(line)
      continue
    }
    if (current !== null) current.push(line)
    else if (pendingComment !== null) { head.push(pendingComment, line); pendingComment = null }
    else head.push(line)
  }
  flush()
  if (pendingComment !== null) head.push(pendingComment)
  return { head, blocks }
}

/** Render the patch back to text. A bare `[]` only survives while no block exists. */
function renderDshPatch(head, blocks) {
  const cleaned = blocks.length > 0 ? head.filter((line) => line.trim() !== '[]') : head
  const parts = [...cleaned]
  for (const block of blocks) parts.push(...block.lines)
  let out = parts.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  if (!out) out = '[]'
  return `${out}\n`
}

function writeDshPatch(patchPath, head, blocks) {
  const next = renderDshPatch(head, blocks)
  if (existsSync(patchPath)) {
    const before = readFileSync(patchPath, 'utf8')
    if (before === next) return
    const backupDir = join(dirname(patchPath), 'tool-management', 'backups')
    mkdirSync(backupDir, { recursive: true })
    // Millisecond precision: several installs can land inside one second, and a
    // second-resolution stamp would let a later backup overwrite an earlier one.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d+)Z$/, '-$1')
    writeFileSync(join(backupDir, `cordis.patch.yml.global.bak-${stamp}`), before, 'utf8')
  }
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, next, 'utf8')
}

function mergeDshPatch(patchPath, serverName, entry, { dryRun, force }) {
  const id = dshLoaderId(serverName)
  const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const { head, blocks } = splitDshPatch(text)
  const wanted = dshInsertBlock(serverName, entry)
  // The marker comment is optional in blocks the host itself wrote, so identity
  // is the block body, not the comment: compare with comments stripped.
  const normalize = (lines) => lines
    .filter((line) => !line.startsWith(DSH_BLOCK_MARKER))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
  const existing = blocks.find((block) => block.id === id)
  if (existing !== undefined) {
    if (normalize(existing.lines) === normalize(wanted)) return { changed: false, note: `已是目标配置（${id}）` }
    if (!force) return { changed: false, blocked: true, note: `已存在不同的 ${id} 块（用 --force 覆盖）` }
    const others = blocks.filter((block) => block.id !== id)
    if (!dryRun) writeDshPatch(patchPath, head, [...others, { id, lines: wanted }])
    return { changed: true, note: dryRun ? `[dry-run] 将覆盖 ${id}` : `已用 --force 覆盖 ${id}` }
  }
  if (!dryRun) writeDshPatch(patchPath, head, [...blocks, { id, lines: wanted }])
  return { changed: true, note: dryRun ? `[dry-run] 将写入 ${id}` : `新增 ${id}` }
}

function removeDshPatch(patchPath, serverName, { dryRun }) {
  const id = dshLoaderId(serverName)
  if (!existsSync(patchPath)) return { changed: false, note: '补丁文件不存在' }
  const { head, blocks } = splitDshPatch(readFileSync(patchPath, 'utf8'))
  if (!blocks.some((block) => block.id === id)) return { changed: false, note: `未发现 ${id}，无需改动` }
  if (!dryRun) writeDshPatch(patchPath, head, blocks.filter((block) => block.id !== id))
  return { changed: true, note: dryRun ? `[dry-run] 将移除 ${id}` : `已移除 ${id}` }
}

function skillFrontmatterName(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const name = match[1].match(/^name:\s*(\S+)\s*$/m)
  return name ? name[1] : null
}

function installSkill(skillScopes, scope, skillName, { dryRun, force }) {
  const resolve = skillScopes[scope]
  if (!resolve) throw new Error(`该 agent 不支持 ${scope} 作用域的 skill（可用：${Object.keys(skillScopes).join(', ')}）`)
  const source = join(SKILLS_ROOT, skillName, 'SKILL.md')
  if (!existsSync(source)) throw new Error(`缺少内置 skill：${source}`)
  const targetDir = join(resolve(process.cwd()), skillName)
  const target = join(targetDir, 'SKILL.md')
  const body = readFileSync(source, 'utf8')
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') === body) return { changed: false, note: `已一致（${target}）` }
    if (!force) return { changed: false, blocked: true, note: `已存在不同内容：${target}（用 --force 覆盖）` }
  }
  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return { changed: true, note: `${dryRun ? '[dry-run] 将写入' : '已写入'} ${target}` }
}

function uninstallSkill(skillScopes, scope, skillName, { dryRun }) {
  const resolve = skillScopes[scope]
  if (!resolve) return { changed: false, note: '该 agent 不支持此作用域' }
  const targetDir = join(resolve(process.cwd()), skillName)
  const target = join(targetDir, 'SKILL.md')
  if (!existsSync(target)) return { changed: false, note: '未安装' }
  const installedName = skillFrontmatterName(readFileSync(target, 'utf8'))
  if (installedName !== skillName) return { changed: false, blocked: true, note: `${target} 的 name=${installedName}，不是本脚手架安装的 skill，拒绝删除` }
  // A same-name skill with different content belongs to someone else: this
  // folder's copy is the only one the scaffold may remove. (frontmatter name
  // alone is not proof of ownership — every well-formed copy matches it.)
  const ownCopy = join(SKILLS_ROOT, skillName, 'SKILL.md')
  if (existsSync(ownCopy) && readFileSync(target, 'utf8') !== readFileSync(ownCopy, 'utf8')) {
    return { changed: false, blocked: true, note: `${target} 内容与本脚手架的 skill 副本不同，拒绝删除` }
  }
  if (!dryRun) rmSync(targetDir, { recursive: true, force: true })
  return { changed: true, note: `${dryRun ? '[dry-run] 将删除' : '已删除'} ${targetDir}` }
}

/** Real proof of life: stdio JSON-RPC initialize + tools/list against the
 *  same command line we just wrote into the agent's config. */
function probeMcp(node, entry, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(node, entry.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let finished = false
    const timer = setTimeout(() => finish({ ok: false, detail: `${timeoutMs}ms 内无响应` }), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      resolve(result)
    }
    child.on('error', (error) => finish({ ok: false, detail: error.message }))
    child.on('exit', (code) => { if (code !== null && code !== 0) finish({ ok: false, detail: `进程退出 code=${code} stderr=${stderr.slice(0, 400)}` }) })
    child.stdout.on('data', () => {
      const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'))
      let initialized = false
      let listed = null
      for (const line of lines) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id === 1) initialized = true
        if (message?.id === 2 && message.result?.tools) listed = message.result.tools
      }
      if (initialized && listed === null) send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      if (initialized && listed === null && stdout.split('\n').filter((l) => l.includes('"id":2')).length === 0) {
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      }
      if (listed) {
        finish({ ok: listed.length > 0, detail: `tools/list 成功，共 ${listed.length} 个工具（前 3 个：${listed.slice(0, 3).map((tool) => tool.name).join(', ')}）` })
      }
    })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'craft-common-use-scaffold', version: SCAFFOLD_VERSION } } })
  })
}

async function runAgent(agentKey, options, productSpec) {
  const agent = AGENTS[agentKey]
  console.log(`\n=== ${agentKey} — ${agent.label} ===`)
  if (options.mcp && !productSpec.mcp && !options.uninstall) {
    // Skill-only product: say so instead of writing an entry that cannot start.
    console.log(`  MCP   跳过 ${productSpec.server} — 本 bundle 不提供 ${options.product} 的 MCP（仅含 Skill）；${SKILL_ONLY_NOTE}`)
  } else if (options.mcp) {
    const mcpScopes = agent.mcpScopes ?? {}
    const scope = options.scope ?? agent.defaultScope
    const resolve = mcpScopes[scope]
    if (!resolve) throw new Error(`${agentKey} 的 MCP 不支持 ${scope} 作用域（可用：${Object.keys(mcpScopes).join(', ') || '无'}）`)
    const mcpPath = resolve(process.cwd())
    const entry = serverEntry(agentKey, productSpec, options.node)
    // DSH stores servers in a loader patch, every other agent in an mcpServers JSON.
    const dshPatch = agent.mcpFormat === 'dsh-loader-patch'
    // Snapshot the file before touching it, so a failed probe can be rolled back
    // exactly. Leaving the entry would hide the failure until the host tried to
    // launch it; deleting it outright could destroy a working configuration.
    const snapshot = !options.dryRun && !options.uninstall && existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : null
    const result = options.uninstall
      ? (dshPatch ? removeDshPatch(mcpPath, productSpec.server, options) : removeMcp(mcpPath, productSpec.server, options))
      : (dshPatch ? mergeDshPatch(mcpPath, productSpec.server, entry, options) : mergeMcp(mcpPath, productSpec.server, entry, options))
    console.log(`  MCP   ${options.uninstall ? '卸载' : '安装'} ${productSpec.server} @ ${mcpPath} — ${result.note}`)
    if (result.blocked) return { ok: false }
    if (!options.uninstall && options.check) {
      const probe = await probeMcp(options.node, entry)
      console.log(`  检查  ${probe.ok ? 'PASS' : 'FAIL'}  ${probe.detail}`)
      if (!probe.ok) {
        if (snapshot !== null) {
          writeFileSync(mcpPath, snapshot, 'utf8')
          console.log(`  回滚  ${mcpPath} 已恢复到安装前内容`)
        } else if (!options.dryRun) {
          const undo = dshPatch ? removeDshPatch(mcpPath, productSpec.server, options) : removeMcp(mcpPath, productSpec.server, options)
          console.log(`  回滚  已移除新建的 ${productSpec.server} — ${undo.note}`)
        }
        return { ok: false }
      }
    }
  }
  if (options.skill) {
    const scope = options.scope ?? agent.defaultScope
    const result = options.uninstall
      ? uninstallSkill(agent.skillScopes, scope, productSpec.skill, options)
      : installSkill(agent.skillScopes, scope, productSpec.skill, options)
    console.log(`  Skill ${options.uninstall ? '卸载' : '安装'} ${productSpec.skill} — ${result.note}`)
    if (result.blocked) return { ok: false }
  }
  for (const note of agent.notes) console.log(`  提示  ${note}`)
  return { ok: true }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || options.list) {
    printHelp()
    if (options.list) {
      console.log(`\nagents: ${Object.keys(AGENTS).join(', ')}\nproducts:`)
      for (const [name, spec] of Object.entries(PRODUCTS)) {
        const server = spec.mcp ? spec.server : `(无 MCP，仅 Skill；${SKILL_ONLY_NOTE})`
        console.log(`  ${name.padEnd(20)} server=${server.padEnd(26)} skill=${spec.skill}`)
      }
    }
    return
  }
  if (options.agents.length === 0) { printHelp(); throw new Error('必须用 --agent 指定目标 agent') }
  const productSpec = PRODUCTS[options.product]
  if (!productSpec) throw new Error(`未知 product：${options.product}（可用：${Object.keys(PRODUCTS).join(', ')}）`)
  if (!existsSync(BUNDLE) || !existsSync(WORKER)) throw new Error(`自包含产物缺失：${BUNDLE} / ${WORKER}`)
  let failures = 0
  for (const agentKey of options.agents) {
    if (!AGENTS[agentKey]) throw new Error(`未知 agent：${agentKey}（可用：${Object.keys(AGENTS).join(', ')}，或 all）`)
    const agents = agentKey === 'all' ? Object.keys(AGENTS) : [agentKey]
    for (const key of agents) {
      try {
        const result = await runAgent(key, options, productSpec)
        if (!result.ok) failures += 1
      } catch (error) {
        console.error(`  FAIL  ${key} — ${error.message}`)
        failures += 1
      }
    }
  }
  console.log(`\nfailures: ${failures}`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()



