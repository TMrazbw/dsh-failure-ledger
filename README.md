# dsh-failure-ledger（对话异常统计）

DSH Harness 的 profile 级 Host + Client 插件：

- 采集所有会话、代理、子代理的工具失败
- 压缩大型错误并统计节省 tokens
- 维护失败台账、去重、playbook 和面板
- 回合尾只显示**本回合**失败/节省
- V2 Guard：失败后观察命中，下一步给一行提示，不阻断
- 已解决失败自动生成 learned Guard 和回归草案
- 重复成功工具调用给出下一步提示，减少无意义重复
- 按会话显示累计失败、异常、节省 tokens
- V2.5：未解决失败自动进入下一步；失败后修正成功自动自愈

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

## V2.5 行为

### A. 未解决失败自动进入下一步

Guard 未命中的失败落盘后，下一步自动注入：

```text
[未解决失败] tool/category/code: hint
```

不需要用户先提醒模型。仍然不阻断工具调用。

### B. 成功重试自动自愈

同一 turn、同一工具，失败后用不同参数成功：

- 自动 resolve 该失败
- 自动生成 learned Guard
- 自动生成 regression 草案
- playbook 记录 `自动自愈：<失败提示>`
- 清理待注入提示

只使用内存中的参数签名，不保存原始参数。默认：

```text
selfHeal.enabled = true
selfHeal.windowSeconds = 180
```

如果自动自愈误判，可以在 profile 配置中关闭。

### Guard（A 模式）

- 默认 Guard 覆盖 edit/read 路径、搜索、命令、超时、sandbox、stale write、
  PWSh 启动失败、人工验证、浏览器下载/授权
- 失败后只记录观察命中；下一步注入一行提示
- **不阻断工具调用**，不增加模型请求
- 面板可查看/新建/禁用 Guard；内置 Guard 只能禁用

### 已解决不复发

`failure_inbox resolve` 会：

- 写 playbook
- 生成 `learned-<fingerprint>` Guard，hint 使用本次 fix
- 写 `regressions/<fingerprint>.md` 回归草案
- 后续同指纹失败命中 learned Guard（observe + hint）

### Token 浪费守卫

- 同一会话内相同 `tool + arguments` 在 120 秒内重复成功调用
- 下一步提示复用上次结果或改参数
- 不阻断、不增加模型请求
- `guards.tokenWaste` 默认 true

### 面板

- 顶部统计
- 对话累计下拉（与侧栏会话标题同源）
- 待解决失败（按指纹）
- 最近失败（含已解决状态）
- 规则与参数（前置、可编辑）
- 诊断/统计折叠：Guard 覆盖率、会话下钻、错误源、节省明细
- 输入区 composer 右侧显示当前会话累计徽标

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

当前 155 项测试全部通过。

## 许可证

MIT。见 [LICENSE](LICENSE)。
