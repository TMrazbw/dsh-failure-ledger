# dsh-failure-ledger（对话异常统计）

DSH Harness 的 **profile 级 Host + Client 插件**：收集工具失败、压缩大型错误、
统计 token 节省与估算金额，并在每回合结束显示失败/异常提醒。

> English: A DSH profile plugin for failure collection, large-error digest,
> per-turn anomaly reminders, and a token-savings panel.

## 功能

- **失败采集**：所有 DSH 会话、代理、子代理自动覆盖；按指纹聚合 report，写入 `index.jsonl`。
- **大错误压缩**：超过阈值的工具错误替换为 ≤200 tokens 摘要，模型可见摘要带
  `Tokens: raw · digest · saved` 标记；不压缩含图片/文件的错误，不覆盖下游替换内容。
- **失败台账**：`failure_inbox` 工具（list/show/resolve/stats）、`INBOX.md`、playbook。
- **回合尾提醒**：`conversation.chat.turnTail` 显示当前会话失败/异常次数，无定时器/轮询。
- **面板“对话异常统计”**：概览（含未解决数量）、错误源、异常、最近失败、
  按模型节省/金额、9 条异常规则与参数。
- **打开方式**：
  - 输入 `/dfl-ui`（Client 命令列表显示 DFL-UI，带图标与中文说明）；
  - 直接说“打开对话异常统计 / 打开失败台账”，模型调用 `open_failure_ledger`；
  - 侧栏“对话异常统计”图标。
- **空间管控**：明细总上限 100 MB；每 200 次写入检查一次；按 mtime 清理最旧的
  `reports/`、`raw/`、`handoffs/` 明细。`totals.json`/`index.jsonl` 不重写，统计不回退。
- **已解决清理**：`resolve` 写 playbook 后删除对应 report/raw，并隐藏已解决指纹；
  累计统计数不变。

## 安装

要求 DSH `0.2.1-rc.2` 或兼容版本，Web/Desktop profile。

在目标 profile 的 `plugin_manager` 中安装：

```text
plugin_manager install_bundle
target: https://github.com/TMrazbw/dsh-failure-ledger
```

或使用 DSH CLI：

```bash
dsh plugin --profile <profile> add https://github.com/TMrazbw/dsh-failure-ledger
```

安装后按 DSH 提示启用/重载。插件不依赖 npm 运行时包；`vendor/` 内含 MIT 许可的
schemastery 依赖，用于 Config schema 和面板参数。

## 配置

通过 DSH Settings / 面板“规则与参数”修改（`.volatile()` 字段）：

- 摘要：启用、阈值 tokens、detail 字符数
- 价格：计价模式、自定义单价
- 9 条异常规则：开关 + 阈值
- `reportRoot`：默认相对插件目录的 `failure-reports`；可在 profile 配置改为持久路径
- `report.maxTotalMB`：内部默认 100，面板不显示
- 摘要最低严重度

金额按 DeepSeek 官方人民币价表估算（Flash/Pro，峰谷价），属于估算，不是账单。

## 数据

默认：`<插件目录>/failure-reports/`

- `index.jsonl`、`savings.jsonl`、`anomalies.jsonl`、`totals.json`、`playbook.jsonl`
- `reports/`、`raw/`、`handoffs/`、`INBOX.md`、`_plugin.log`

报告/日志只保存在本机；错误文本先脱敏（token、Authorization、key-value、邮箱、用户路径）。
插件不调用 LLM，不新增 session event type。

## 测试

```bash
node --test --test-isolation=none
```

124 tests。

## 许可证

MIT。见 [LICENSE](LICENSE)。
