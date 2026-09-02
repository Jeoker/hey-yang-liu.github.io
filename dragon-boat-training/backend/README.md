# Apps Script 后端

当前代码覆盖已部署并验收的 P0，以及已经完成真实联调的 P1 阶段核心：建季、Form／响应 Sheet 绑定复核、初始化与成员导入、Form 提交触发器、十分钟共享名单缓存、默认训练模板、周草稿、整周确认或预约开放、加场草稿和单场发布。报名、候补、排座及归档仍不在当前实现范围。

## 代码与数据

- `src/Code.gs`：Web App 入口、动作路由和统一响应格式。
- `src/CoachActions.gs`：登录、会话读取、测试写入和退出。
- `src/Security.gs`：HMAC 摘要、签名令牌、限流和脚本锁。
- `src/SystemStore.gs`：系统 Spreadsheet 表结构、请求去重、恢复记录和审计日志。
- `src/SeasonStore.gs`：赛季与每季 Spreadsheet 的受控记录访问和版本检查。
- `src/SeasonActions.gs`：建季、绑定检查、初始化、成员导入和 Form 提交同步。
- `src/ScheduleActions.gs`：默认模板、周草稿、整周发布、预约发布与加场分层发布。
- `src/PublicActions.gs`：公开赛季、已发布训练、管理详情和十分钟名单投影。
- `src/TimeUtils.gs`：赛季时区、日历边界及本地训练时间解析。
- `src/Setup.gs`：一次性初始化及新增／重置个人 Coach Code。
- `src/appsscript.json`：V8 运行时配置。
- `.clasp.json.example`：测试项目配置示例；真实 Script ID 不提交仓库。
- `build.mjs`：按固定顺序生成可直接粘贴到网页编辑器的单文件构建结果；运行根目录 `npm run build:dragon-boat-backend`。
- `../contracts/api-v1.json`：当前请求和响应契约。

长期系统 Spreadsheet 包含 `Coaches`、`CoachSessions`、`SystemRequests`、`SystemAuditLog`、`Seasons` 和 `SystemSettings`。每季响应 Spreadsheet 在初始化时增加 `Members`、模板、周、训练及后续业务所需系统 Tab。Code 使用随机 salt 和服务端 secret 生成摘要；短期会话令牌带服务端签名，Sheet 只保存令牌摘要。重置 Code 会推进 `credential_version`，停用凭据或版本变化会让旧会话立即失效。

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
4. 将 Web App 设为以部署账号执行，并允许队员无需 Google 登录访问。P0 前端保存当前公开 `/exec` 地址作为默认值，也可以用构建变量 `PUBLIC_DRAGON_BOAT_API_URL` 覆盖。
5. 从实际 GitHub Pages 测试入口验证健康检查、Code 登录、受保护写入、重复请求、退出和过期会话。

本地使用 clasp 时，把 `.clasp.json.example` 复制为 `.clasp.json` 并替换测试 Script ID；`rootDir` 已指向 `src`。真实 `.clasp.json`、Code、会话令牌和 Spreadsheet ID 不提交仓库。

## 新增或重置个人 Code

在 Script Properties 临时设置 `DRAGON_BOAT_PROVISION_COACH_ID`、`DRAGON_BOAT_PROVISION_COACH_NAME` 和 `DRAGON_BOAT_PROVISION_COACH_CODE`，运行一次 `provisionDragonBoatCoachFromProperties`。相同 `coach_id` 会重置凭据并使旧会话失效；新的 `coach_id` 会建立独立凭据。临时明文 Code 在成功后自动删除。

需要停用管理人员时，将 `Coaches.active` 改为 `FALSE`；后续所有管理请求都会拒绝该凭据及其旧会话。交接时应先为继任者建立独立 ID，再停用离任者。

## 验证边界

根目录运行 `npm test` 会以 Apps Script 服务替身验证 P0 会话和 P1 赛季、绑定、同步、缓存与分层发布规则。P0 与 P1 阶段核心均已完成真实 Google 与 Pages 验收；当前版本、隔离测试数据及缺陷修复证据见[当前进度](../CURRENT-STATUS.md)。后续工作仍不得把模拟测试写成线上通过。
