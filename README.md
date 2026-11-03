# dsh-failure-ledger（对话异常统计）

DSH Harness 的 profile 级 Host + Client 插件：

- 采集所有会话、代理、子代理的工具失败
- 压缩大型错误并统计节省 tokens
- 维护失败台账、去重、playbook 和面板
- 回合尾只显示本回合失败/节省
- Guard 观察命中，下一步给一行提示，不阻断
- 已解决失败自动生成 learned Guard/regression
- 重复成功工具调用给出下一步提示
- 未解决失败自动进入下一步
- 失败后修正成功自动自愈
- 同错两次时给出 unstick 提示
- 无证据完成只记录异常，不阻断
- 生成事实型会话交接文件（非 LLM 总结）
- 上下文归因、花费/今日花费、可选预算提示

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

`vendor/` 内含 MIT 许可的 schemastery 依赖。

## 行为

### Guard（A 模式）

- 默认 13 条 Guard：路径、搜索、命令、超时、sandbox、stale write、
  PWSh 启动失败、未知工具、缺失依赖、人工验证、浏览器下载/授权
- 失败后只记录观察命中；下一步注入一行提示
- **不阻断工具调用**
- Guard 面板只显示已出现（hits > 0）的规则，最多 20 条；
  超出和未出现的规则收起

### 自动闭环

- Guard 未命中失败自动进入下一步：
  `[未解决失败] tool/category/code: hint`
- 同 turn、同 tool，失败后修正成功自动 resolve + learned Guard/regression
- 同一 session/fingerprint 第 2 次失败时注入一次 unstick 提示
- 默认 `selfHeal.enabled=true`，窗口 180 秒

### claimWithoutEvidence（观察版）

- 记录 lastEdit / lastVerify / lastClaim
- 声称完成但最近编辑后无成功验证 → 记异常
- 只进面板/异常计数，不注入 hint、不阻断
- 默认规则开启，可在规则区关闭

### 事实型 handoff

- 面板“生成交接”按钮
- `failure_inbox action=handoff`
- 输出 Goal / Done / Next / Open questions / Key facts
- 只写事实，不做 LLM 语义总结
- 写入 `handoffs/<sessionId>.md`

### Token 浪费 / 上下文 / 花费

- 相同工具+参数 120 秒内重复成功 → 下一步提示
- 上下文归因：当前 tokens/window、本回合增量、主要来源、最近请求
- 花费/今日花费；可选预算提示，金额显示到分
- 不查余额/套餐

### 面板排序

- 会话累计、未解决失败、错误源、Guard、按模型节省都按出现频率降序
- 最近失败和会话时间线保留时间顺序

## 数据

默认数据目录是插件目录下的 `failure-reports/`；可在 profile 配置改为绝对路径。

```text
index.jsonl / savings.jsonl / anomalies.jsonl / totals.json / playbook.jsonl
guards.json / guard-hits.jsonl
reports/ / raw/ / regressions/ / handoffs/
INBOX.md / _plugin.log
```

所有数据只保存在本机；错误文本先脱敏。插件不调用 LLM。

## 测试

```bash
node --test --test-isolation=none
```

当前 188 项测试全部通过。

## 许可证

MIT。见 [LICENSE](LICENSE)。
