---
tags: [code-cleaner]
max_turns: 40
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

This is our monorepo (TypeScript apps and packages plus a small Python service). Audit it for dead code and tell me what is safe to delete. Be careful: I don't want anything removed that something still uses. Don't change any files.

Input files: repo/
