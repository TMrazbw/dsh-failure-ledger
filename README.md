# dsh-failure-ledger（对话异常统计）

DSH Harness 的 profile 级 Host + Client 插件：

- 采集所有会话、代理、子代理的工具失败
- 压缩大型错误并统计节省 tokens
- 维护失败台账、去重、playbook 和面板
- 回合尾只显示本回合失败/节省
- Guard 观察命中，下一步给一行提示，不阻断
- 已解决失败自动生成 learned Guard 和回归草案
- 重复成功工具调用给出下一步提示
- 未解决失败自动进入下一步
- 失败后修正成功自动自愈
- 上下文归因：看清哪一步让上下文增长
- 花费 / 今日花费 / 可选预算提示
- 按会话显示累计失败、异常、节省 tokens

## 安装

要求 DSH 0.2.1-rc.2 或兼容版本，Web/Desktop profile。

```text
plugin_manager install_bundle
target: https://github.com/TMrazbw/dsh-failure-ledger
```

或：

```bash
dsh plugin --profile <profile> add https://github.com/TMrazbw/dsh-failure-ledger
```

插件不需要额外 npm 运行时依赖；`vendor/` 内含 MIT 许可的 schemastery 依赖。

## 行为

### Guard（A 模式）

- 默认 13 条 Guard：edit/read 路径、搜索、命令、超时、sandbox、stale write、
  PWSh 启动失败、未知工具、缺失依赖、人工验证、浏览器下载/授权
- 失败后只记录观察命中；下一步注入一行提示
- **不阻断工具调用**，不增加模型请求
- 面板可查看/新建/禁用 Guard；内置 Guard 只能禁用
- Guard 面板只显示已出现（hits > 0）的规则，最多 20 条；
  超出 20 条和未出现的规则收起

### 已解决不复发

`failure_inbox resolve` 会：

- 写 playbook
- 生成 `learned-<fingerprint>` Guard，hint 使用本次 fix
- 写 `regressions/<fingerprint>.md` 回归草案
- 后续同指纹失败命中 learned Guard（observe + hint）

### 自动闭环

- Guard 未命中的失败自动进入下一步：
  `[未解决失败] tool/category/code: hint`
- 同 turn、同 tool，失败后不同参数的成功调用视为自愈：
  - 自动 resolve
  - 自动生成 learned Guard/regression
  - playbook 记录“自动自愈”
  - 默认 `selfHeal.enabled=true`，窗口 180 秒
- 如果自动自愈误判，可关闭 `selfHeal.enabled`

### Token 浪费守卫

- 同一会话内相同 `tool + arguments` 在 120 秒内重复成功调用
- 下一步提示复用上次结果或改参数
- 不阻断、不增加模型请求
- `guards.tokenWaste` 默认 true

### 上下文归因

- 面板“上下文归因（所选对话）”
- 当前 tokens / window、本回合增量、压缩次数
- 主要来源 Top3 与最近 5 次请求
- 新规则 `contextJump`：
  - 默认 8000 tokens 且窗口 10%
  - 每会话最多 3 条
  - 近似 ±10%，不压缩、不阻断

### 花费 / 预算

- 按 usage 与官方价格估算
- 面板显示累计花费、今日花费、本会话花费
- 可选预算：
  - `budget.enabled` 默认 false
  - `sessionCNY` / `dailyCNY` / `warnRatio`
  - 超限/接近上限只提示，不阻断
- 未知模型回退 flash；不查余额/套餐
- 金额显示到分（2 位小数）

### 面板排序

- 会话累计、未解决失败、错误源、Guard、按模型节省都按出现频率降序；
- 最近失败和会话时间线保留时间顺序；
- “规则与参数”在 Guard 上方。

## 数据

默认数据目录是插件目录下的 `failure-reports/`；可在 profile 配置改为绝对路径。

主要文件：

```text
index.jsonl / savings.jsonl / anomalies.jsonl / totals.json / playbook.jsonl
guards.json / guard-hits.jsonl
reports/ / raw/ / regressions/ / handoffs/
INBOX.md / _plugin.log
```

空间策略：

- 明细总上限 100 MB
- 每 200 次写入检查一次
- 按 mtime 清理最旧明细
- `totals` 单调累计，不因清理回退
- resolve 删除报告/raw，但保留 playbook、Guard 和 regression

所有数据只保存在本机；错误文本先脱敏。插件不调用 LLM。

## 测试

```bash
node --test --test-isolation=none
```

当前 176 项测试全部通过。

## 许可证

MIT。见 [LICENSE](LICENSE)。
