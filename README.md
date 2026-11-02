# agent-skills

中文 | [English](README.en.md)

让 AI 编程工具按一套固定流程，帮你降低 Cloudflare 费用、安全地开源项目。

技能遵循 [Agent Skills](https://agentskills.io/) 格式，可用于 Claude Code、Codex、Cursor 等支持该格式的工具。技能内容为中文。

## 安装

需要 Node.js 22.20 或更高版本。在项目目录运行，然后选择要装的技能和工具：

```bash
npx skills add dingxiaopi/agent-skills
```

只装一个技能，并让它在所有项目里可用：

```bash
npx skills add dingxiaopi/agent-skills --skill open-source-release -g
```

装好后直接用自然语言提出需求，工具会自动选用对应的技能。

## 技能

### cloudflare-cost-optimization

在功能不变的前提下，降低部署在 Cloudflare（Workers、D1、R2、KV、Cache API）上的项目的费用。已上线的项目看真实用量数据，还没上线的项目检查代码和本地数据库。

附带两个只读脚本，只需 Node 18+，macOS、Linux、Windows 通用：

- `cf-usage.mjs`：拉取账户的用量，也能拆开看单个 Worker 每天、每个版本、每小时的 CPU。
- `tail-summary.mjs`：实时采样几分钟请求，看 CPU 花在哪些路径和客户端上。

可以直接用 `wrangler login` 的登录令牌，不用另外申请。

**适用场景：**

- 想知道账单主要花在哪里
- D1 读取量、Workers 请求量或 CPU 时间偏高
- 页面慢、静态文件误走 Worker、爬虫流量大
- 上线前检查，或上线新功能后确认有没有性能问题

**可以这样说：** “查一下这个项目的 Cloudflare 用量和费用”

### open-source-release

把项目整理成可以放心公开的仓库。公开前检查全部 git 历史，再补齐 README、演示素材和仓库设置，发布后用陌生人的视角验证一遍。

**适用场景：**

- 准备开源项目，或把私有仓库改成公开
- 想检查提交邮箱、密钥、私人信息和第三方内容授权
- 写或重写 README，仓库看起来不够专业
- 发布后确认链接、图片和构建步骤都正常

**可以这样说：** “帮我开源这个项目，发布前先检查一遍”

## 技能结构

```text
skills/
└── <技能名>/
    ├── SKILL.md      # 触发条件和主要规则
    ├── references/   # 需要时才读取的参考资料
    └── scripts/      # 技能自带的脚本（部分技能有）
```

部分结论来自单个项目的实测，已在技能中标明。用在自己的项目前，请先按技能里的方法复核。

## 许可证

[MIT](LICENSE)
