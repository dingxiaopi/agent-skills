# agent-skills

通用的 AI agent 技能合集。每个技能是一个文件夹，入口是标准的 `SKILL.md`（开头 `name` / `description`，下面是正文），不绑定任何一家工具。

A collection of tool-agnostic agent skills. Each skill is a folder with a standard `SKILL.md`; written in Chinese.

## 技能列表

| 技能 | 用途 |
|---|---|
| [cloudflare-cost-optimization](skills/cloudflare-cost-optimization/SKILL.md) | Cloudflare 成本优化：功能不变、费用最低，顺带提升性能；已上线看真实数据，未上线做提前检查 |
| [open-source-release](skills/open-source-release/SKILL.md) | 开源发布规范：公开前的安全检查（提交邮箱、密钥、第三方授权）、README 和演示素材、仓库门面、发布后验证 |

## 使用方法

**支持 `SKILL.md` 的 agent 工具**：把需要的技能文件夹复制或软链接到该工具的技能目录（各工具目录不同，以其文档为准）。例如 Claude Code 是 `~/.claude/skills/`：

```bash
git clone <本仓库地址> ~/agent-skills
ln -s ~/agent-skills/skills/cloudflare-cost-optimization ~/.claude/skills/cloudflare-cost-optimization
```

**其他 agent**：在项目的 `AGENTS.md`（或该工具读取的说明文件）里加一句，让它在相关任务时先读对应的 `SKILL.md`：

```markdown
做 Cloudflare 成本优化时，先读 ~/agent-skills/skills/cloudflare-cost-optimization/SKILL.md
```

## 约定

- 一个技能一个文件夹：`SKILL.md` 放主要规则，较长的案例或参考资料放 `references/`。
- 内容来自真实项目的实测；单次测量的结论写明“实测”并附验证方法，使用前请在自己的项目里复核。
- 不包含任何密钥、账号或私有项目信息。

## 许可证

[MIT](LICENSE)
