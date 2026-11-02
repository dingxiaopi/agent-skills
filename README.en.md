# agent-skills

[中文](README.md) | English

Get your AI coding agent to cut your Cloudflare bill and publish open source projects safely, following a fixed process.

These skills follow the [Agent Skills](https://agentskills.io/) format and work with Claude Code, Codex, Cursor, and other agents that support it. **The skill instructions are written in Chinese.**

## Install

Requires Node.js 22.20 or later. Run this in your project, then choose the skills and agents you want:

```bash
npx skills add dingxiaopi/agent-skills
```

To install one skill and make it available across all your projects:

```bash
npx skills add dingxiaopi/agent-skills --skill open-source-release -g
```

Once installed, describe what you need in plain language and your agent will pick the matching skill.

## Skills

### cloudflare-cost-optimization

Lowers the cost of projects on Cloudflare (Workers, D1, R2, KV, Cache API) without changing what they do. For live projects it works from real usage data; for unreleased ones it reviews the code and local database.

**Use when:**

- You want to know where your bill is coming from
- D1 reads, Workers requests, or CPU time are high
- Pages are slow, static files go through a Worker, or bots drive a lot of traffic
- You are about to launch, or want to check a new feature for performance problems

**Try saying:** "Check this project's Cloudflare usage and costs"

### open-source-release

Gets a project ready to publish with confidence. It runs safety checks across the full git history before anything goes public, fills in the README, demo assets, and repository settings, then verifies the result the way a stranger would see it.

**Use when:**

- You are open-sourcing a project or making a private repository public
- You want to check commit emails, secrets, personal information, and third-party licensing
- You are writing or rewriting a README, or the repository doesn't look professional
- You want to confirm links, images, and build steps work after release

**Try saying:** "Help me open-source this project, and check it before release"

## Structure

```text
skills/
└── <skill-name>/
    ├── SKILL.md      # When to use it and the main rules
    ├── references/   # Reference material, read only when needed
    └── scripts/      # Bundled scripts (some skills only)
```

Some findings come from measurements on a single project and are marked as such in the skill. Follow the skill's steps to re-check them on your own project before relying on them.

## License

[MIT](LICENSE)
