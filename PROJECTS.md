# 项目目录

这个文件是 `dev-master` 下所有独立项目的入口。每个项目的设计、代码和相关资料都应放在自己的子文件夹中，根目录只保留索引。

| 项目 | 状态 | 说明 | 文档 |
|---|---|---|---|
| Dragon Boat Training | P0 实现中 | 按赛季入队与训练报名、统一 Coach Mode、排座和历史荣誉墙 | [项目说明](dragon-boat-training/README.md) · [前端规格](dragon-boat-training/frontend-spec.md) · [后端规格](dragon-boat-training/google-sheets-backend-spec.md) · [Epic 规划](dragon-boat-training/epics/README.md) |
| Meowsformer | 已有实现，独立 Git 仓库 | 将人类语音转换为猫叫表达的应用，包含 Python 后端、Vue 网页和音频处理管线 | [开发概览](meowsformer/docs/development-overview.md) · [技术参考](meowsformer/docs/technical-reference.md) · [测试文档](meowsformer/docs/project-testing.md) · [GitHub 仓库](https://github.com/Jeoker/meowsformer) |

## 本地目录与仓库边界

- Dragon Boat Training 位于 `dragon-boat-training/`，设计文档由当前仓库管理。
- Meowsformer 位于 `meowsformer/`，于 2026-08-30 从 `D:\agents\meowsformer` 整体迁入，保留独立的 `.git`、提交历史和远程仓库。
- 当前仓库的 `.gitignore` 排除 `/meowsformer/`，避免把嵌套仓库和它的本地数据重复提交。Meowsformer 的 Git 命令应在它自己的目录中运行。
- 上面的相对文档链接供本地目录导航使用；在 GitHub 上查看 Meowsformer 时，请使用其独立仓库链接。
