---
tags: [code-cleaner]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

saveTask accepts empty titles and that's a bug. We ended up with saveTaskV2 as well and the UI uses that one. Fix this properly so there is one save implementation that rejects empty titles, and clean up whatever is left over.

Input files: repo/
