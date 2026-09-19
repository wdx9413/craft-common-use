/**
 * Per-agent compatibility registry for the Craft scaffold.
 *
 * Every entry below was verified against official documentation or real
 * on-machine installs (2026-09-19); nothing here is guessed:
 *
 *   cline     — MCP: ~/.cline/data/settings/cline_mcp_settings.json (official
 *               Cline config docs + confirmed on this machine). Skills:
 *               ~/.cline/skills/<name>/SKILL.md (global) and .cline/skills/
 *               (project) per docs.cline.bot/cline-cli/configuration.
 *   qoder     — MCP: ~/.qoder/settings.json -> mcpServers (user) and
 *               <project>/.qoder/settings.json (project, needs approval) per
 *               docs.qoder.com/zh/cli/mcp-reference. Skills: ~/.qoder/skills/
 *               and .qoder/skills/ per docs.qoder.com/zh/cli/Skills.
 *   trae      — MCP: <project>/.trae/mcp.json per docs.trae.cn "添加 MCP
 *               Server"; requires the 项目级 MCP toggle. No verified global
 *               file, so project scope only. Skills: .trae/skills/<name>/ per
 *               craft/adapters/trae-work (repo convention).
 *   workbuddy — MCP: ~/.workbuddy-ai/mcp.json + ~/.workbuddy-ai/
 *               mcp-approvals.json (trust is bound to a SHA-256 of command +
 *               sorted args; a new entry must be trusted once in the UI) per
 *               craft/adapters/README.md and the live install on this
 *               machine. Skills: ~/.workbuddy-ai/skills/<name>/.
 *
 * The generic skill + MCP payload is shared; agents only differ in where the
 * payloads land and which manual step the host still requires.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()

/**
 * DSH's home directory. The DSH process exports DSH_HOME; outside it, DSH
 * Desktop keeps its harness under %APPDATA%\dsh-desktop\harness (confirmed on
 * this machine), and a plain CLI install uses ~/.dsh.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'dsh-desktop', 'harness')
  }
  return join(home, '.dsh')
}

export const AGENTS = {
  cline: {
    label: 'Cline (IDE / CLI)',
    mcpScopes: {
      user: () => join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    },
    defaultScope: 'user',
    skillScopes: {
      user: () => join(home, '.cline', 'skills'),
      project: (root) => join(root, '.cline', 'skills'),
    },
    notes: [
      'Skills load on demand from the frontmatter description; enable them in the Skills menu if needed.',
    ],
  },
  qoder: {
    label: 'Qoder CLI',
    mcpScopes: {
      user: () => join(home, '.qoder', 'settings.json'),
      project: (root) => join(root, '.qoder', 'settings.json'),
    },
    defaultScope: 'user',
    skillScopes: {
      user: () => join(home, '.qoder', 'skills'),
      project: (root) => join(root, '.qoder', 'skills'),
    },
    notes: [
      'Project-scope MCP servers need per-server approval (or mcp.enableAllProjectMcpServers in settings.json).',
      'User-level skills override project-level skills with the same name.',
    ],
  },
  trae: {
    label: 'Trae / TraeCode',
    mcpScopes: {
      project: (root) => join(root, '.trae', 'mcp.json'),
    },
    defaultScope: 'project',
    skillScopes: {
      project: (root) => join(root, '.trae', 'skills'),
    },
    notes: [
      'Enable Settings > MCP > 启用项目级 MCP, or the .trae/mcp.json entry stays dormant.',
      'The stdio command must not contain spaces: the scaffold tries the 8.3 short path, then a known space-free node install, and finally asks for --node.',
    ],
  },
  workbuddy: {
    label: 'WorkBuddy (CodeBuddy desktop)',
    mcpScopes: {
      user: () => join(home, '.workbuddy-ai', 'mcp.json'),
    },
    defaultScope: 'user',
    skillScopes: {
      user: () => join(home, '.workbuddy-ai', 'skills'),
    },
    notes: [
      'WorkBuddy launches sessions with --strict-mcp-config, so only this declaration is offered as a custom connector.',
      'Trust is bound to a SHA-256 of command + sorted args: after any install or change, open Connector management > Custom connectors and click Trust once.',
    ],
  },
  dsh: {
    label: 'DeepSeek Harness (DSH Desktop)',
    // DSH has no mcpServers JSON file: an MCP server is a cordis loader entry
    // inside cordis.patch.yml, in the exact block shape DSH's own manager
    // (dsh-plugin-tool-management) emits — a comment marker plus an `insert` row
    // naming '@deepseek-ai/dsh-mcp-client'. The marker delimits the block, which
    // makes this install idempotent and an uninstall exact; the file decides
    // whether the harness boots, so every write is backed up first.
    mcpFormat: 'dsh-loader-patch',
    mcpScopes: {
      user: () => join(resolveDshHome(), 'cordis.patch.yml'),
    },
    defaultScope: 'user',
    skillScopes: {
      user: () => join(resolveDshHome(), 'tool-management', 'skills'),
    },
    notes: [
      'MCP server 名即工具前缀：工具名形如 mcp__<serverName>__<tool>，不同 product 之间天然不会重名。',
      '技能落点 <DSH_HOME>/tool-management/skills/<name>/SKILL.md，DSH 启动即发现为 source=hub、enabled。',
      '每次写 cordis.patch.yml 前备份到 <DSH_HOME>/tool-management/backups/；DSH 运行中改动需 HMR 或重启生效。',
    ],
  },
}
