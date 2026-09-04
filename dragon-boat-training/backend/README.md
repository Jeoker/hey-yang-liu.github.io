# Apps Script 后端

当前代码覆盖 P0／P1 核心、P2 报名与维护、P2.1 等待体验优化及 P3 排座与最终更正。P3 已部署到 Apps Script Version 11，线上 health 为服务 `0.6.1-p3`、契约 `2026-09-02.p2.1`；真实 Google API、Pages 核心浏览器流程及本轮安全清理／退出通过，[GitHub Pages run 33837698705](https://github.com/jeoker/hey-yang-liu.github.io/actions/runs/33837698705) 成功。其他验证限制见[当前进度](../CURRENT-STATUS.md)。P1 剩余工作与 P4 归档及历史范围见[Epic 总览](../epics/README.md)。

## 代码与数据

- `src/Code.gs`：Web App 入口、动作路由和统一响应格式。
- `src/CoachActions.gs`：登录、会话读取、测试写入和退出。
- `src/Security.gs`：HMAC 摘要、签名令牌、限流和脚本锁。
- `src/SystemStore.gs`：系统 Spreadsheet 表结构、请求去重、恢复记录和审计日志。
- `src/SeasonStore.gs`：赛季与每季 Spreadsheet 的受控记录访问、版本检查及旧赛季 P3 Tab 的按需建立。
- `src/SeasonActions.gs`：建季、绑定检查、初始化、成员导入和 Form 提交同步。
- `src/ScheduleActions.gs`：默认模板、周草稿、整周发布、预约发布、加场分层发布及到期冻结扫描。
- `src/PublicActions.gs`：公开赛季、已发布训练、管理详情和十分钟名单投影。
- `src/SignupActions.gs`：报名、候补、训练详情，以及报名变化与草稿／正式系统 revision 的同次可恢复写入。
- `src/MemberActions.gs`：受保护名册、资料修正、默认偏好、启停、角色和船位关联检查，以及完成赛季最终更正所需读取。
- `src/SeatingActions.gs`：排座工作区、完整草稿快照、角色、手动／系统 revision、最终更正及精确冻结快照。
- `src/TimeUtils.gs`：赛季时区、日历边界及本地训练时间解析。
- `src/Setup.gs`：一次性初始化及新增／重置个人 Coach Code。
- `src/appsscript.json`：V8 运行时配置。
- `.clasp.json.example`：测试项目配置示例；真实 Script ID 不提交仓库。
- `build.mjs`：按固定顺序生成可直接粘贴到网页编辑器的单文件构建结果；运行根目录 `npm run build:dragon-boat-backend`。
- `../contracts/api-v1.json`：当前请求和响应契约。

长期系统 Spreadsheet 包含 `Coaches`、`CoachSessions`、`SystemRequests`、`SystemAuditLog`、`Seasons` 和 `SystemSettings`。每季响应 Spreadsheet 包含名单、排期、训练及报名表，并使用 `SeatPlanCurrent` 保存当前草稿座位、`SeatPlanState` 保存角色和版本指针、`SeatPlanRevisions` 保存不可变正式版本、`PracticeFinalSnapshots` 保存到期冻结快照；既有赛季在首次使用 P3 能力时按需建立新增 Tab。Code 使用随机 salt 和服务端 secret 生成摘要；短期会话令牌带服务端签名，Sheet 只保存令牌摘要。重置 Code 会推进 `credential_version`，停用凭据或版本变化会让旧会话立即失效。

报名与排座沿用同一 `Settings` 报名版本、服务器入队顺序和 `SystemRequests` 恢复协议。取消、换侧和自动递补在一次持锁事务中同步报名、草稿及必要的系统正式 revision；未发布草稿不会混入公开版本。提交顺序和恢复约束见[后端规格](../google-sheets-backend-spec.md#会话与写入一致性)。

正式座位角色使用固定的公开与管理投影入口。公开 `practice` 只返回 Coach／Steerer 的显示姓名；经 Coach session 保护的 seating workspace 才附带角色 `member_id`，供“从正式版重置草稿”恢复内部选择。普通 revision 与冻结快照遵守同一隔离规则。

## 第一次测试部署

1. 使用队伍长期控制的 Google 账号创建独立 Apps Script 测试项目。可以预先创建测试 Spreadsheet，也可以让初始化函数自动建立默认名为 `Dragon Boat Training - P0 Test System` 的私有文件。
2. 在 Apps Script 的 Script Properties 中设置：
   - 可选 `DRAGON_BOAT_SYSTEM_SPREADSHEET_ID`；留空时自动创建
   - 可选 `DRAGON_BOAT_SYSTEM_SPREADSHEET_NAME`；仅在自动创建时使用
   - `DRAGON_BOAT_INITIAL_COACH_ID`，例如 `coach_yang`
   - `DRAGON_BOAT_INITIAL_COACH_NAME`
   - `DRAGON_BOAT_INITIAL_COACH_CODE`，长度 6 至 128 字符
   - 可选 `DRAGON_BOAT_SESSION_TTL_SECONDS`，允许 900 至 86400，默认 28800
3. 将 `src/` 推送到测试 Apps Script 项目，运行 `setupDragonBoatP1` 并完成 Spreadsheet、Forms 和触发器授权。该函数包含 P0 初始化并幂等建立预约开放触发器；临时明文初始 Code 会自动删除。已有管理员且未提供新 Code 时可以安全重跑，不会轮换凭据或重复记录凭据事件。
4. 将 Web App 设为以部署账号执行，并允许队员无需 Google 登录访问。前端保存当前公开 `/exec` 地址作为默认值，也可以用构建变量 `PUBLIC_DRAGON_BOAT_API_URL` 覆盖。
5. 从实际 GitHub Pages 测试入口验证健康检查、Code 登录、受保护写入、重复请求、退出和过期会话。

本地使用 clasp 时，把 `.clasp.json.example` 复制为 `.clasp.json` 并替换测试 Script ID；`rootDir` 已指向 `src`。真实 `.clasp.json`、Code、会话令牌和 Spreadsheet ID 不提交仓库。

## 新增或重置个人 Code

在 Script Properties 临时设置 `DRAGON_BOAT_PROVISION_COACH_ID`、`DRAGON_BOAT_PROVISION_COACH_NAME` 和 `DRAGON_BOAT_PROVISION_COACH_CODE`，运行一次 `provisionDragonBoatCoachFromProperties`。相同 `coach_id` 会重置凭据并使旧会话失效；新的 `coach_id` 会建立独立凭据。临时明文 Code 在成功后自动删除。

需要停用管理人员时，将 `Coaches.active` 改为 `FALSE`；后续所有管理请求都会拒绝该凭据及其旧会话。交接时应先为继任者建立独立 ID，再停用离任者。

## 验证边界

根目录 `npm test` 当前为 117／117，覆盖 P0／P1 基线、P2 业务边界、未知结果重试、写后故障恢复、持锁 `flush` 顺序、请求内缓存隔离，以及 P3 草稿隔离、角色互斥、手动与系统 revision、报名联动、版本冲突、最终更正、精确冻结边界、自动保存后的动态控件解锁和公开／管理角色投影隔离。周生成的计划恢复已有专项回归，其他 P1 写入路径不能据此视为已通过全部中断测试。

当前部署为 Apps Script Version 11／服务 `0.6.1-p3`，Pages run 33837698705 成功。部署版本、测试数量、真实 Google／Pages 验收证据与接续位置统一记录在[当前进度](../CURRENT-STATUS.md)，不以本地测试或部署成功代替验收。本轮 Pages 测试状态已经通过归属受控的严格脚本清理，退出码为 0、最终 `ok=true`；公开与管理双端读回及脚本／页面退出均已确认。

[live-p2-acceptance.mjs](../tests/live-p2-acceptance.mjs) 是显式手动集成脚本，不随 `npm test` 执行。设置运行时环境变量 `DBT_API_URL` 后，从仓库根目录运行 `node dragon-boat-training/tests/live-p2-acceptance.mjs --write-test-data`；仅在隔离测试赛季、约定的虚构队员及初始空报名场次通过检查后写入。清理只取消本次运行创建、且 `queue_at` 与 `queue_sequence` 仍匹配的报名；不清空其他报名、不删除成员或审计，归属变化时停止并人工核对。脚本、文档及测试结果不得包含真实私有文件 ID 或凭据。

[live-p21-timing.mjs](../tests/live-p21-timing.mjs) 对同一测试赛季首场及固定虚构队员执行两轮报名、换侧、取消，再改名并恢复、退出。仅通过运行时环境设置 `DBT_API_URL`、`DBT_COACH_CODE`，显式传入 `--write-test-data`；`--optimized` 使用当前视图及合并读取，默认模式模拟原请求链。可用 `DBT_TIMING_REPORT` 将去除身份信息的报告写入被忽略的 `.build/`。报告测量 API 请求链耗时、次数和响应字节数，不等同于浏览器渲染耗时或锁占用时间。失败会记录清理未完成，必须核对原请求与测试队员状态，不能直接重新整轮运行或清空表格。

[live-p3-acceptance.mjs](../tests/live-p3-acceptance.mjs) 只允许文档约定的隔离测试赛季、22 名虚构成员、三场已发布训练及初始空报名、空角色、空正式座位和空草稿状态。运行同时要求 `DBT_API_URL`、`DBT_COACH_CODE` 及 `--write-test-data`，验证草稿隔离、角色互斥、错侧确认、手动／系统 revision、取消递补和换侧清位。每次重试复用原 `request_id` 和完整参数；若无法确认写入结果或测试数据归属发生变化，立即停止自动清理并要求人工核对。2026-09-04 的 Version 10 真实运行以退出码 0 完成，最终返回 `ok=true`；本轮有效报名全部取消，空角色和空座位正式版已发布，会话已撤销，完整边界见 [P3 验收报告](../tests/P3-ACCEPTANCE.md)。
