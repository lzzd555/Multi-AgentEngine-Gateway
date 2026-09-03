# demo-skill 伴随文件（reference.md）

本文件是 demo-skill 的伴随参考文件，用于验证网关 skills 供给的**整目录复制**语义：

- `gateway.config.json` 的 `skills` 数组按目录引用（`./skills/demo-skill`），供给时目录内全部文件（SKILL.md + 伴随文件）一并复制到所选引擎的隔离 skills 目录；
- 每次网关启动幂等重同步（按 skill 清理重建），源目录删除文件后目标不残留；
- 三引擎目标位置：OpenCode `<state>/opencode/xdg/opencode/skills/demo-skill/`、OMP `<state>/omp/agent/skills/demo-skill/`、PI `<state>/pi/agent/skills/demo-skill/`。

若在某引擎的 skills 目录下看到本文件，说明整目录复制生效。
