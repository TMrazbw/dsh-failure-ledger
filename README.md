# dsh-failure-ledger（对话异常统计）

DSH Harness 的 **profile 级 Host + Client 插件**：压缩大型工具错误、维护对话异常统计、
在每回合结束显示失败/异常提醒，并统计整个 DSH 的 token 节省与估算金额。

- 完整设计：`PROJECT.md`
- 进度日志：`PROGRESS.md`
- GitHub：**https://github.com/TMrazbw/dsh-failure-ledger**（Public / MIT）
- 当前版本：**V2.8（194 tests pass）：换对话意图由 Agent 调用 handoff，不再提供按钮；Goal 只取真实用户消息（跳过 runner 注入块与 DFL 通知），Done 只写路径/命令摘要；package `0.1.2`；live 复核通过（2026-11-03 第 4 次）**
- 已发布基线：**V2.0（151 tests、commit `fc3deb8`）→ V2.5（155 tests、commit `f9aa8f2`）→ V2.6（175 tests、commit `8456810`）→ UI/分类（176 tests、commit `c060e5f`）→ V2.7（188 tests、commit `d348154`）→ V2.8（194 tests、commit `d81c818`）**

## 目标（V1）

1. 全局失败采集：所有 DSH 会话、代理、子代理自动生效。
2. 大错误压缩：长错误原文落盘，模型只看到短摘要 + 下一步 + 报告路径。
3. 对话异常统计：`INBOX.md`、`index.jsonl`、`reports/<fingerprint>.md`、`failure_inbox` 工具。
4. 实时统计：会话级失败次数、异常项、保守估算的浪费/节省 token。
5. 每回合 UI 提醒：`conversation.chat.turnTail`，零 token；点击打开面板。
6. 侧栏面板：错误源、异常明细、规则/参数开关、只读的全局累计节省与估算金额。

## 设计要点

- **不新增 session event type**，不修改 DSH 核心，只使用公开事件/服务。
- 大错误才替换；小错误/含图片只加一条插件 hint；下游 `block` 原样保留；
  同一 callId 不重复注入。
- 会话级统计由 `failureLedger` 投影提供（n1/n2/saved/usage），摘要的
  `Tokens:` 标记让重放也能恢复节省数；子代理按 sessionId 去重聚合。
- 提醒默认走 UI（零模型请求）；模型可见提醒为 V1.5 可选开关，默认关闭。
- 规则默认全开，阈值取保守值；面板可逐条关闭/调整。
- 金额估算为保守值：只计直接压缩节省，不乘后续重发；默认取空闲时段缓存未命中输入价。

## 官方价格口径

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，抓取于 2026-10-22。

| 模型 | 输入·缓存命中（空闲/高峰） | 输入·缓存未命中（空闲/高峰） | 输出（空闲/高峰） |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 元 | 1.00 / 2.00 元 | 4.00 / 8.00 元 |
| `deepseek-v4-pro` | 0.15 / 0.30 元 | 4.50 / 9.00 元 | 13.50 / 27.00 元 |

单位为人民币/百万 tokens。峰值时段：北京时间周一至周五 09:00–12:00、14:00–18:00
（法定节假日除外）；空闲价为高峰价的一半。

**金额只是本地估算，不是账单。**

## 目录结构

```text
dsh-failure-ledger\
  package.json        Host + Client 清单（dsh.bundle.patch + dsh.client）
  cordis.patch.yml    插入 failure-ledger 行
  index.js            Host 入口（post-execute / failureLedger / failure_inbox）
  client.js           Client 入口（turnTail 提醒 + main 面板 + 侧栏图标）
  lib\                核心模块
    classify.js       错误分类 + hint
    fingerprint.js    规范化 + 指纹
    redact.js         脱敏
    render.js         摘要/报告/INBOX 模板
    rules.js          九条 token 异常规则
    savings.js        token 估算与金额
    store.js          原子存储/JSONL/聚合/轮转/totals
    digest.js         post-execute 摘要处理器
    anomaly.js        会话事件折叠 + 九条规则视图
    projection.js     failureLedger 会话投影单元
    inbox.js          INBOX 渲染 + failure_inbox 工具
    snapshot.js       面板认证快照 + GET 路由
    config-schema.js  默认配置 + .volatile() Config schema
  test\               Node 内置测试（194 项）
  vendor\             从本机 DSH 只读复制的 schemastery 依赖（MIT）
  locale\en.json      显示元数据
  locale\zh.json      显示元数据（中文）
  icon.svg            插件图标
  README.md           本文件
  PROJECT.md          总方针
  PROGRESS.md         进度日志
```

## 测试

```powershell
node --test --test-isolation=none
```

本机沙箱禁止管道 stdio，默认 `node --test` 会因 spawn EPERM 失败，所以用同进程模式；
当前 194 项测试全部通过。

## 面板

打开方式：

- 输入 `/dfl-ui`：Client `commandUi` 在命令列表显示左侧 PanelIcon、
  label `DFL-UI`、右侧中文“打开对话异常统计面板”并直接打开（同 DAM-UI 方案；
  Host 不再注册同名命令）。输入名仍是平台要求的小写 `dfl-ui`。
- 或直接说“打开对话异常统计 / 打开 DFL-UI 面板”，模型会调用
  `open_failure_ledger` 工具。
- 侧栏也有“对话异常统计”图标。

面板内容：概览卡片（含“未解决”数量）、错误源、异常、最近失败、
按模型节省与只读估算金额；最近失败表只列 10 条。
规则/参数表单可保存到 profile 配置（`configForms` + `.volatile()`）。Config schema
使用 `vendor/node_modules` 中从本机 DSH 只读复制的 schemastery（MIT；含 cosmokit/
standard-schema）。面板数据来自认证路由 `api/failure-ledger.snapshot`，
打开时/点刷新/保存后拉取，无定时轮询。面板根容器可滚动
（`height:100%; overflow-y:auto`），内容超出时显示滚动条。

命令/工具本身不产生模型请求；自然语言工具调用会留下一次很小的工具调用记录。
打开动作通过 `failureLedger` 投影的 `panelOpenSeq` 交给常驻 Client bridge 执行。

## V2.0 Guard 观察与 hint

- 13 个默认 Guard：edit/read 路径、搜索 asar、路径检查、命令路径、超时、
  sandbox、stale write、PWSh 启动失败、未知工具、依赖缺失、人工验证、
  浏览器下载/授权。
- 失败落盘后 **observe**：写入 `guard-hits.jsonl`、累加 `guards.json` 命中数。
- Step 2：下一次 `agent/pre-step` 注入一行防复发提示（≤320 字符），
  同一 turn 最多一次、60s TTL；**不阻断、不创建额外模型请求**。
- Step 3：面板按“核心优先”重排：
  - 顶部只保留统计卡片；
  - 核心区是“对话累计（整体）下拉”、“待解决失败（按指纹分组）”和“最近失败”；
  - “复制待解决清单”便于通知模型处理；
  - 修复库、Guard/覆盖率、会话下钻、错误源、节省仍然折叠；
  - 规则与参数放在诊断/统计之前，**不折叠**，也不显示“可编辑”；
  - 模型用 `failure_inbox action="unresolved"` 读取未解决分组，
    用 `action="playbook"` 读取已解决修复；后台读取不依赖 UI。
- 回合尾提醒改为**本回合**统计（`turnN1/turnSavedTokens`）；本回合无失败/节省时不显示，
  不再显示整个对话的累计 n1/n2。
- 对话累计下拉使用 Host `workspaceRegistry.list()` 的 workspace `sessionIds`，并用
  `workspaceController.follow` 的 `archivedSessionIds` 过滤归档会话；
  再按 `readTitleSnapshots` 只保留有标题的非空会话（空会话侧栏也不显示），
  与台账统计合并；无失败会话显示 0；标题与侧栏同源。
- 最近失败读取 index 最近 40 条，按 playbook 标记未解决/已解决；面板显示最近 10 条和状态。
  已解决记录仍保留索引，但报告/raw 已删除，因此报告列显示 `—`。
- `conversation.composer.dock` 增加会话累计徽标，注册 order 为 `-1000000`，
  排到 dock 最左侧；文本为 `失败 n · 异常 m · 节省 x`（不带“本对话”前缀）；
  无数据时不显示。无法越过原生 44% 上下文圆环，因为圆环在该 slot 之外。
- Step 3 管理界面：
  - “规则与参数”前置且不折叠，可查看/修改/新建 Guard；
  - Guard 支持 ID、名称、tool/category/code、hint、action、enabled；
  - 摘要/计价/9 条异常规则参数可直接编辑；
  - 保存走自有 `POST api/failure-ledger.admin` + Host `settings`，
    不再依赖未挂载的 `configForms`；
  - 内置 Guard 只能禁用，自定义 Guard 可删除；A 模式永不 block。
- Step 4 固化：
  - `resolve` 自动生成/更新 `learned-<fingerprint>` Guard，hint 使用本次 fix；
  - 写 `regressions/<fingerprint>.md` 回归草案；
  - playbook 记录 guardId/regression，面板显示“固化/未固化”和
    “已解决固化 X/Y”；
  - 后续同指纹失败会命中 learned Guard（observe + hint，不阻断）；
  - 旧 playbook 不回填，避免把测试证据变成规则。
- Step 5 Token 浪费守卫：
  - 同一 session 内相同 `tool + arguments` 在 120s 内重复成功调用；
  - 下一步注入一次“复用上次结果或改参数”的 hint；
  - 不阻断、不增加模型请求；插件管理工具与失败结果跳过；
  - `guards.tokenWaste` 默认 true。
- V2.5 A：Guard 未命中的新失败自动进入下一步：
  `[未解决失败] tool/category/code: hint`；不阻断。
- V2.5 B：同一 turn、同一 tool，失败后不同参数的成功调用视为自愈；
  自动 resolve、生成 learned Guard/regression，并清理 pending hint。
  默认 `selfHeal.enabled=true`，窗口 180s。
- V2.7 Step 1 `unstick`：
  - 同一 session / fingerprint 第 2 次失败时提示一次；
  - 写下共同假设 → 最小 probe → 3 个不同机制 → 不第三次变体；
  - 不阻断、不新增模型请求。
- V2.7 Step 2 `claimWithoutEvidence`（观察版）：
  - 记录 lastEdit / lastVerify / lastClaim；
  - 声称完成但最近编辑后没有成功验证 → 记异常；
  - 只进面板/异常计数，不注入 hint、不阻断；
  - 默认规则开启，可在规则区关闭。
- V2.8 换对话自动 handoff：
  - 不提供按钮；
  - 用户表达“换对话/新开会话/下次继续/先到这里”时，Agent 判断是否调用；
  - 调用 `failure_inbox action=handoff`；
  - 工具返回：已调用功能、写入路径、用户下一步；
  - 输出 Goal / Done / Open failures / Open questions / Key facts；
  - 只写事实，不做 LLM 语义总结；
  - 写入 `handoffs/<sessionId>.md`。
- V2.6 上下文归因（本地 Step14）：
  - 面板“上下文归因（所选对话）”；
  - snapshot 按会话注入 context，避免主面板无会话 projection 时不显示；
  - 当前 tokens / window、本回合增量、压缩次数；
  - 主要来源 Top3 与最近 5 次请求；
  - 新规则 `contextJump`（默认 8000 tokens + 10% 窗口，最多 3 条）；
  - 近似 ±10%，不压缩、不阻断、不注入模型。
- V2.6 花费/预算（Step15b）：
  - `lib/cost.js` 按 usage 与官方价格估算；
  - 顶部“累计花费 / 今日花费”，上下文卡片“本会话花费”；
  - `budget.enabled` 默认关闭；可设本会话/今日 CNY 与预警比例；
  - 面板显示“预算已超限/接近上限”；
  - 未知模型回退 flash；只估算，不查余额/套餐。
- 预计节省金额：`formatCNY` 与 snapshot `estimatedCNY` 都只保留 **2 位小数（分）**。
- 中文显示名统一为“对话异常统计”；英文包名、仓库名、DFL 缩写不变。
- 面板 UI：
  - “规则与参数”在上，“Guard 规则”在下；
  - Guard 只显示已出现（`hits > 0`），最多 20 条；
  - 超出 20 条和未出现的 Guard 收进折叠区；
  - 会话、未解决失败、错误源、Guard、按模型节省都按出现频率降序；
  - “最近失败”和会话时间线保留时间顺序。

## 运行数据（默认 `D:\deepseek插件\dsh-failure-ledger\failure-reports`）

`index.jsonl` / `savings.jsonl` / `anomalies.jsonl` / `totals.json` / `playbook.jsonl` /
`reports\` / `raw\` / `handoffs\` / `INBOX.md` / `_plugin.log`。
`totals.json` 是单调累计，清理明细不会让它回退。空间策略只有两条：
**每 200 次写入检查一次** + **明细总上限 100 MB**。启动/检查时按 mtime 清理最旧的
reports/raw/handoffs 明细；不做按天保留。已 `resolve` 的失败会删除对应
report/raw 文件，totals/index 统计不变。旧根目录会在启动时迁移到插件目录。

Step 10 V1 技术验收通过（Config/四 Client 注册/真实压缩/命令/提醒已确认）。
按反馈完成改名、命令列表图标/中文、滚动、目录迁移、100 MB/200 次写入策略和
已解决记录删除；需最后一次重启加载。

## 安装

本地 desktop profile 已通过 `plugin_manager install_bundle` 安装
（`application: applied`）。其他电脑可安装同一 GitHub 仓库：

```text
plugin_manager install_bundle
target: https://github.com/TMrazbw/dsh-failure-ledger
```

修改 Host 代码后，DSH 的 ESM 模块缓存要求重启应用；Client 代码变化要求刷新 Web 页面。

## 安全与边界

- 错误原文、报告、日志只保存在本机；按工具定制采集并脱敏。
- 默认不调用 LLM；不把统计写入 session log。
- 面板写参数前必须确认；只允许 `.volatile()` 字段，并落 profile 配置。
- 金额/节省为估算值，不得作为计费或对账依据。

## 开发约定

- 任何文件/安装/配置变更都先取得用户同意；每步完成后追加 `PROGRESS.md`。
- 先写纯函数与测试，再接入 DSH 事件；先本地验证，再安装。
- 只用公开 API；可选服务用 `ctx.get()` 探测，缺失时降级。
