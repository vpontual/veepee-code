# Skills

A skill is a markdown file of pre-written guidance for a specific kind of task —
"how to cut a release here", "how this desktop's config is laid out". vcode reads
them from disk, so adding one needs no code change and no restart.

## Where they live

| Scope | Path | Wins? |
|---|---|---|
| Global | `~/.veepee-code/skills/` | — |
| Project | `<cwd>/.veepee/skills/` | shadows a global skill of the same name |

## Two layouts

```
~/.veepee-code/skills/
├── cut-a-release.md          # flat: one file, one skill
└── omarchy/                  # bundle: a directory of related markdown
    ├── SKILL.md              #   the entry point (required)
    ├── hyprland.md           #   companions, linked from SKILL.md
    └── theming.md
```

The bundle layout is the ecosystem convention — Claude Code, Codex and Pi all
read `<name>/SKILL.md` — which means vcode can consume skills it did not write.
A directory without a `SKILL.md` is ignored rather than guessed at. If both
`omarchy.md` and `omarchy/SKILL.md` exist, the bundle wins; the order is fixed in
code rather than left to `readdir`, whose order is filesystem-dependent.

The name comes from the frontmatter, falling back to the filename or the
directory name.

## Frontmatter

```yaml
---
name: omarchy
description: >
  What this skill is for, and when to reach for it. Written as one paragraph —
  this is the only part of the skill that lives in every prompt, so it is what
  the model matches against.
tags: [desktop, config]
model: qwen3.5:35b            # advisory only; vcode never switches model mid-task
allowed-tools: bash, read_file
requires-tools: web_search    # hide unless ALL of these are registered here
fallback-for-tools: browser   # hide when ANY of these is registered
---
```

Values may be plain, quoted, or a YAML block scalar — folded (`>`, newlines
become spaces) or literal (`|`, newlines kept). Block scalars matter more than
they look: the skills Omarchy ships write their description that way, and a
line-based parser reads the marker itself as the value, then treats every
indented line containing a colon ("Triggers: crash, segfault") as a new key. The
skill loads with no usable description and never gets picked.

## How the model sees them

Skills are **not** in the system prompt. Only an index — name, tags, description
— rides along, inside the description of the `skill_invoke` meta-tool. When the
model decides a skill is relevant it calls `skill_invoke({name})` and the body
arrives as the tool result, so the content costs tokens only in the turn that
uses it. Dozens of skills stay affordable.

For a bundle, the result also lists its companion files as **absolute paths**.
Without that, a body saying "see `hyprland.md`" is unresolvable — the model has
the text but no idea where the file is.

`loadSkills()` re-runs on every `skill_invoke`, so dropping in a new skill takes
effect on the next call, not the next restart.

## Using Omarchy's skills

Omarchy (Quattro, 4.0) ships skills at
`/usr/share/omarchy/default/agents/skills/` and symlinks each bundle into
`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` and `~/.pi/agent/skills`
when a user is provisioned. vcode is not on that list, so point it at them
yourself:

```bash
mkdir -p ~/.veepee-code/skills
for skill in /usr/share/omarchy/default/agents/skills/*/; do
  ln -sfn "${skill%/}" ~/.veepee-code/skills/"$(basename "$skill")"
done
```

That is one symlink per bundle, so an `omarchy update` that rewrites the skill
bodies is picked up with no further action. It works because discovery follows
symlinks and reads the target's directory for companions.
