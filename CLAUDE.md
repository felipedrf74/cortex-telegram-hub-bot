@AGENTS.md

# Claude Code

Use `AGENTS.md` as the complete project bootloader. Claude-specific project
skills live under `.claude/skills/` and symlink to the canonical
`.agents/skills/` bodies. Grok Build, Codex, and Claude Code share the product
brief (`docs/NEXUS_HUB_PRODUCT_BRIEF.md`) via `AGENTS.md`.

The Stop hook is advisory and cached. It does not authorize commits, pushes,
deployments, destructive Git operations, production mutation, or new Markdown
handoffs. Use `docs/project-map.json` for navigation and load large domain
material only when the task requires it.
