# Craft Common Use（通用 skill + MCP 脚手架）

一条命令把**通用**的 Craft skill（SKILL.md）和 MCP server 初始化进某个编程 Agent。
本文件夹完全自包含：MCP bundle、parser worker 与全部 SKILL.md 都在 `bundle/` 与 `skills/`
内（取自 Craft v0.12.35 发布物），运行时不依赖 craft-marketplace 或 Craft 源码仓库。
精确版本、来源与 bundle 校验和见 [`release.json`](./release.json)。

## 用法

```powershell
node init.mjs --agent <cline|qoder|trae|workbuddy|all> [--product full] [--scope user|project]
              [--node <path>] [--dry-run] [--force] [--uninstall] [--no-check] [--list]
```

示例：

```powershell
node init.mjs --agent cline  --product memory        # Cline 用户级：MCP + skill
node init.mjs --agent dsh    --product knowledge     # DSH：MCP loader 块 + skill
node init.mjs --agent trae   --product full          # 当前项目的 .trae/mcp.json + .trae/skills
node init.mjs --agent all    --dry-run               # 各家全预览，不落盘
node init.mjs --agent cline --product memory --uninstall
```

- `--product`：`full | context | memory | knowledge | capability | quality | skill-quality | experience`（server 名与 skill 名的映射见 `init.mjs --list`）。
- `--check`（默认开启）会用**与写入配置完全相同的命令行**真实拉起 MCP 进程做
  `initialize` + `tools/list` 握手，安装即验证。
- 幂等：相同配置重跑是 no-op；已有同名但不同的 server/skill 会拒绝改动并提示 `--force`；
  JSON 合并保留文件里的其他内容与其他 server。
- `--uninstall` 只删本脚手架写入的内容（skill 按 frontmatter `name` 校验，MCP 按 server 键名）。

## 生命周期边界

Codex 插件可以额外声明 `SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd` 等原生 Hook，
并用 `mcp_tool` 在用户消息阶段调用已连接的 Knowledge/Memory MCP。这个通用脚手架面向的
Cline、Qoder、Trae、WorkBuddy、DSH 没有一个统一的生命周期 Hook 协议，所以本包只负责安装
Skill 与 MCP，不承诺“每个任务自动开始/结束各调用一次”。没有宿主 Hook 时，按 Skill 在任务
开始执行实际的限定检索/解析，任务结束再执行实际的受控写入/观察；`readiness` 只能做可用性检查，
不能算能力已使用。

## 各 Agent 的落盘位置与兼容要点

| Agent | MCP 配置 | Skill 目录 | 兼容要点 |
|---|---|---|---|
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `~/.cline/skills/<name>/`（项目级 `.cline/skills/`） | 仅用户级 MCP（项目级未获官方文档证实，故不提供） |
| Qoder | `~/.qoder/settings.json`（用户级）或 `<项目>/.qoder/settings.json` | `~/.qoder/skills/` / `.qoder/skills/` | 项目级 MCP 需逐个批准（或 `mcp.enableAllProjectMcpServers`） |
| Trae | `<项目>/.trae/mcp.json`（仅项目级） | `<项目>/.trae/skills/` | 需在 设置>MCP 打开「启用项目级 MCP」；command 不能含空格，脚本自动回退 8.3 短路径或已知的空格路径 node |
| WorkBuddy | `~/.workbuddy-ai/mcp.json` | `~/.workbuddy-ai/skills/<name>/` | 信任绑定 `command+args` 的 SHA-256：装完/改动后需在 Connector 管理 > Custom connectors 点一次 Trust |
| DSH | **不走 JSON 文件**：写 `<DSH_HOME>/cordis.patch.yml` 的 loader 块，复刻 DSH 自带管理器的块格式（`# dsh-plugin-tool-management:server:<id>` 标记 + `@deepseek-ai/dsh-mcp-client` 的 insert 行） | `<DSH_HOME>/tool-management/skills/<name>/` | 该文件决定 harness 能否启动，因此每次写入前先备份到 `<DSH_HOME>/tool-management/backups/`；块按块内 `- id:` 识别（宿主只在第一个块写注释标记），安装幂等、卸载精确。DSH 运行中改动需 HMR 或重启生效 |

以上路径全部来自官方文档或本机实测（依据逐条写在 `agents.mjs` 注释里），不是猜测。

## 数据位置

MCP 子进程默认写 `~/.craft_data`（可用 `CRAFT_DATA_DIR` 覆盖）。多个 Agent 共用同一份
Craft 数据是刻意设计：记忆、知识、执行观察互通。

## 更新 bundle / skills

发布物升级后，应以 `craft-marketplace` 的已校验插件包为唯一发布源，重新同步
bundle、parser worker 与对应 Skill；脚本本身无需改动：

```powershell
Copy-Item ..\craft-marketplace\plugins\craft-memory\dist\plugin\craft-mcp.cjs, `
           ..\craft-marketplace\plugins\craft-memory\dist\plugin\craft-parser-worker.js .\bundle\
Copy-Item ..\craft-marketplace\plugins\*\skills\*\SKILL.md .\skills\<技能名>\SKILL.md
```

**同步后必须更新 `release.json` 并核对版本/校验和**，否则会出现“README 说新版本、bundle
其实是旧版本”的静默不一致：

```powershell
# bundle 内部真实版本（应与 release.json / craft-marketplace 各插件 manifest 一致）
Select-String .\bundle\craft-mcp.cjs -Pattern 'var VERSION = "([^"]+)"' | Select-Object -First 1
# 与 craft-marketplace 发布物逐字节比对（应为 True）
(Get-FileHash .\bundle\craft-mcp.cjs).Hash -eq (Get-FileHash ..\craft-marketplace\plugins\craft-memory\dist\plugin\craft-mcp.cjs).Hash
```

## 已验证

- v0.12.35 发布物：bundle 与 `craft-marketplace/plugins/craft-memory` 逐字节一致；版本、来源提交
  和 SHA-256 记录于 `release.json`。Craft 源码侧已完成 MCP bundle 冒烟检查。

- Cline 用户级真实安装 `craft-memory`：JSON 合并保留既有 `craft` 条目；探针 `tools/list`
  返回 18 个工具；skill 落盘；重跑 no-op。
- Trae 项目级真实安装 `craft`（full）：DSH node 路径含空格被自动替换为 WorkBuddy 自带
  node（v22 实测可跑）；探针 16 个工具；`--uninstall` → 重装回路通过。
- WorkBuddy 检出既有 `craft` connector 配置并拒绝覆盖（需 `--force`）。
- Qoder dry-run 计划正确（本机未装 Qoder，未做真实写盘）。

- 生命周期行为：Codex 使用插件 Hook；通用 Agent 使用 Skill + MCP 约定，宿主没有原生 Hook 时不做强制自动触发。
- **DSH 真实安装**：`--agent dsh` 把 MCP loader 块写进 `<DSH_HOME>/cordis.patch.yml`、把 Skill 装到
  `<DSH_HOME>/tool-management/skills/`。`mcp_manager_list` 显示三个 server `loader:on:active`
  （craft-memory 23 / craft-knowledge 50 / craft-experience 20 个工具），
  `skill_manager_list` 显示三个 skill `source=hub、enabled`。
  隔离 `DSH_HOME` 下验证了完整回路：`[]` → 新增块 → 二次运行 no-op → 追加第二块 →
  卸载一块 → 卸最后一块回到 `[]`，四次写入产生四份独立备份。

## 未覆盖的风险

- WorkBuddy 的 Trust 点击与 Cline/Trae/Qoder 的宿主 UI 加载效果未在本轮验证（需要真人操作宿主）。
- Trae 对 command/args 的内部 spawn 引号处理未知，因此本脚手架选择「空格路径回退」而非 `cmd /c` 包装。
- Qoder/Trae 用户级 MCP 全局文件（若未来官方支持）未跟踪。
