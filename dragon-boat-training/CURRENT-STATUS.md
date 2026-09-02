# 当前进度与接续入口

> 更新：2026-09-02

这份文件只记录当前可复现状态和下一步入口，供新的开发任务快速接续。产品规则仍以[项目说明](README.md)为准，功能边界和验收顺序仍以[Epic 总览](epics/README.md)为准；这里不保存已经被替代的设计讨论。

## 当前基线

- P0 已完成并关闭：Apps Script Web App、私有系统 Spreadsheet、Coach Code 会话、受保护幂等写入和退出均已部署。
- 实际 GitHub Pages 已验证公开健康读取、刘阳的个人 Coach Code 登录、受保护测试写入、退出，以及刷新后不恢复已退出会话。
- P0 最终代码提交为 `59a4430`，验收与文档提交为 `cc6b2e2`；两项均已推送到 `master`，对应 Pages 构建和部署成功。
- 当前公开入口为 <https://jeoker.github.io/hey-yang-liu.github.io/dragon-boat-training/>，管理入口为 <https://jeoker.github.io/hey-yang-liu.github.io/dragon-boat-training/coach/>。
- 已部署服务版本为 `0.2.1-p0`，契约版本为 `2026-08-31.p0.2`。真实 Script ID、私有 Spreadsheet ID、Coach Code、会话令牌及服务端 secret 不写入仓库文档。
- P1 当前本地验证为 27 项测试通过，Astro 构建 0 error、0 warning、0 hint，后端单文件构建和 `git diff --check` 通过。

## 当前开发位置

当前正在完成 P1“建季并开放一周”。以下纵向链路已经写入代码和契约：

1. BE-03：建立 `Seasons`／`SystemSettings` 和每季运营 Tab；检查并锁定 Form、Spreadsheet、响应 Tab 与姓名列绑定；导入成员；提供十分钟共享名单缓存。
2. ADM-02：在统一 Coach Mode 创建赛季、检查绑定、初始化并查看同步结果。
3. BE-04 与 ADM-03：维护默认训练模板，生成当周私有草稿，确认后整周开放；已开放周的新增训练必须单独发布。
4. FE-02：公开本季、入队 Form、已发布周与训练；未确认草稿和未单独发布的新增训练不得出现。
5. 自动化验证覆盖错误绑定不激活、初始化与重复请求恢复、已有及新增回答去重导入、十分钟共享名单快照、未确认周隔离、整周开放及加场单独发布。

私有 Apps Script 项目已经保存 P1 单文件代码，`setupDragonBoatP1` 已执行成功，系统表升级和五分钟预约开放触发器已经就绪。独立测试 Form 和响应 Spreadsheet 已创建并保持私有，表单关闭邮箱收集；真实文件标识不写入仓库。

尚未完成的 P1 验收步骤是：发布隔离测试 Form、更新现有 Web App 部署、发布 GitHub Pages，然后从实际 Pages 使用 Coach Code 完成建季、绑定、既有及新回答同步、周草稿隔离、整周开放、加场草稿隔离和单独发布。完成前，线上公开服务仍按最后一次已验收部署状态理解，不能把本地通过视为线上通过。

P1 完成前不开始普通队员报名、候补和换侧算法；这些属于 P2。排座、训练后 24 小时更正和历史归档分别属于 P3、P4。

## 继续开发时先检查

1. 在仓库根目录运行 `git -c safe.directory=D:/agents/dev-master status --short --branch`，确认没有来自其他任务的改动。
2. 运行 `npm test`、`npm run build` 和 `npm run build:dragon-boat-backend`，确认当前基线；在受限环境中运行 Astro 时设置 `ASTRO_TELEMETRY_DISABLED=1`。
3. 查看本文件及三个 Epic 的状态行；只把已经通过本地测试和真实 Google／Pages 验收的工作包标为完成。
4. 后端写入继续使用服务端权限校验、`LockService`、`request_id` 去重和对象版本冲突；浏览器不直连 Sheet，也不保存 Google 凭证。
5. 部署后从实际 Pages 来源验证，而不是只在 Apps Script 编辑器或本地模拟环境中判断成功。
