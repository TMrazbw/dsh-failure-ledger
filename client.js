/**
 * dsh-failure-ledger — Client half.
 *
 * 1. `conversation.chat.turnTail`: per-Turn reminder from the `failureLedger`
 *    projection. Zero token, no timers, no polling.
 * 2. `main` page + `sidebar.panellist`: read-only overview (error sources,
 *    anomalies, savings/estimated CNY) fetched from the authenticated Host
 *    snapshot route, plus a `configForms`-backed rules/parameters form.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-failure-ledger',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    let translate = (zh) => zh;
    let activeLayout = null;
    let activeConfigForms = null;

    const PANEL_ID = 'failure-ledger';
    const CONFIG_ENTRY = 'failure-ledger';
    const SNAPSHOT_URL = 'api/failure-ledger.snapshot';
    const ADMIN_URL = 'api/failure-ledger.admin';

    const RULE_ROWS = [
      ['repeatFailure', '重复失败', 'Repeated failure', [
        ['threshold', '阈值', 'Threshold'],
        ['windowMinutes', '窗口分钟', 'Window (min)'],
      ]],
      ['largeErrorResend', '大错误重发', 'Large error resend', [
        ['minRawTokens', '最小原文 tokens', 'Min raw tokens'],
      ]],
      ['requestRetry', '请求重试', 'Request retry', [
        ['alertAfter', '告警重试次数', 'Alert after retries'],
      ]],
      ['cacheReset', '缓存重置', 'Cache reset', [
        ['minInputTokens', '最小输入 tokens', 'Min input tokens'],
      ]],
      ['contextPressure', '上下文压力', 'Context pressure', [
        ['ratio', '压力比例', 'Pressure ratio'],
      ]],
      ['contextJump', '上下文跳变', 'Context jump', [
        ['minDeltaTokens', '最小增量 tokens', 'Min delta tokens'],
        ['minWindowRatio', '最小窗口占比', 'Min window ratio'],
        ['maxHitsPerSession', '每会话最多', 'Max hits per session'],
      ]],
      ['maxTokens', 'max-tokens 截断', 'max-tokens truncation', []],
      ['abortedTurn', '中止回合', 'Aborted turn', []],
      ['subagentFailure', '子代理失败', 'Subagent failure', []],
      ['idleLoop', '空转循环', 'Idle loop', [
        ['minStepsWithoutProgress', '无进展步数', 'Steps without progress'],
      ]],
    ];

    const CONFIG_PATHS = [
      ['minSeverity'],
      ['digest', 'enabled'],
      ['digest', 'maxInlineTokens'],
      ['digest', 'maxDetailChars'],
      ['savings', 'priceMode'],
      ['savings', 'customUnitPricePerMTokens'],
      ['budget', 'enabled'],
      ['budget', 'sessionCNY'],
      ['budget', 'dailyCNY'],
      ['budget', 'warnRatio'],
      ...RULE_ROWS.flatMap(([ruleId, , , fields]) => [
        ['rules', ruleId, 'enabled'],
        ...fields.map(([field]) => ['rules', ruleId, field]),
      ]),
    ];

    function Reminder(props) {
      let projection = null;
      try {
        if (typeof props.useProjection === 'function') projection = unwrapProjection(props.useProjection('failureLedger'));
      } catch {
        projection = null;
      }

      const n1 = toCount(projection?.turnN1);
      const savedTokens = toCount(projection?.turnSavedTokens);
      if (n1 === 0 && savedTokens === 0) return null;

      const parts = [];
      if (n1 > 0) parts.push(translate(`失败 ${n1} 次`, `${n1} failed`));
      if (savedTokens > 0) {
        parts.push(translate(`节省 ~${formatTokens(savedTokens)} tokens`, `~${formatTokens(savedTokens)} tokens saved`));
      }
      const summary = `${translate('本回合：', 'This turn: ')}${parts.join(' · ')}`;
      const action = translate('打开对话异常统计', 'Open Conversation Anomaly Stats');

      return h('button', {
        type: 'button',
        title: translate('打开对话异常统计面板', 'Open the Conversation Anomaly Stats panel'),
        'aria-label': `${summary} · ${action}`,
        onClick(event) {
          try {
            event?.preventDefault?.();
          } catch {
            // Ignore a missing event.
          }
          try {
            activeLayout?.selectPanel(PANEL_ID);
          } catch {
            // Opening the panel is best-effort.
          }
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          maxWidth: '100%',
          padding: '2px 0',
          border: '0',
          background: 'transparent',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '1.4',
          color: 'var(--dsw-alias-label-secondary)',
          textAlign: 'left',
        },
      },
      h('span', {
        'aria-hidden': true,
        style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '10px' },
      }, '●'),
      h('span', null, summary),
      h('span', {
        style: {
          color: 'var(--dsw-alias-brand-primary)',
          textDecoration: 'underline',
          textUnderlineOffset: '2px',
          whiteSpace: 'nowrap',
        },
      }, action));
    }

    function PanelIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M5 4h10a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z' }),
      h('path', { d: 'M8 8h6M8 12h6M8 16h3' }),
      h('circle', { cx: 18, cy: 18, r: 4, fill: 'var(--dsw-alias-bg-layer-1)' }),
      h('path', { d: 'M18 16v2.4' }),
      h('circle', { cx: 18, cy: 20, r: 0.8, fill: 'currentColor', stroke: 'none' }));
    }

    function ComposerStats(props) {
      let projection = null;
      try {
        if (typeof props.useProjection === 'function') projection = unwrapProjection(props.useProjection('failureLedger'));
      } catch {
        projection = null;
      }
      const n1 = toCount(projection?.n1);
      const n2 = toCount(projection?.n2);
      const savedTokens = toCount(projection?.savedTokens);
      if (n1 === 0 && n2 === 0 && savedTokens === 0) return null;
      return h('button', {
        type: 'button',
        title: translate('打开对话异常统计面板', 'Open the Conversation Anomaly Stats panel'),
        onClick(event) {
          try {
            event?.preventDefault?.();
          } catch {
            // Ignore a missing event.
          }
          try {
            activeLayout?.selectPanel(PANEL_ID);
          } catch {
            // Opening the panel is best-effort.
          }
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          maxWidth: '100%',
          alignSelf: 'flex-end',
          padding: '2px 6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '11px',
          lineHeight: '1.4',
          whiteSpace: 'nowrap',
        },
      }, translate(
        `失败 ${n1} · 异常 ${n2} · 节省 ${formatTokens(savedTokens)}`,
        `${n1} failed · ${n2} anomalies · ${formatTokens(savedTokens)} saved`,
      ));
    }


    function PanelBridge(props) {
      let request = 0;
      try {
        const projection = typeof props.useProjection === 'function'
          ? unwrapProjection(props.useProjection('failureLedger'))
          : null;
        request = toCount(projection?.panelOpenSeq);
      } catch {
        request = 0;
      }
      const lastRequest = useRef(null);
      useEffect(() => {
        if (lastRequest.current == null) {
          lastRequest.current = request;
          return;
        }
        if (request > lastRequest.current) {
          lastRequest.current = request;
          try {
            activeLayout?.selectPanel(PANEL_ID);
          } catch {
            // The panel may not be registered yet during startup.
          }
        }
      }, [request]);
      return null;
    }

    function Panel(props) {
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [formState, setFormState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState(null);
      const [selectedSession, setSelectedSession] = useState('');
      const [selectedStatsSession, setSelectedStatsSession] = useState('');
      const [copied, setCopied] = useState(false);
      const [guardDraft, setGuardDraft] = useState(null);
      const [guardSaving, setGuardSaving] = useState(false);
      const [guardError, setGuardError] = useState(null);
      let liveProjection = null;
      try {
        if (typeof props?.useProjection === 'function') {
          liveProjection = unwrapProjection(props.useProjection('failureLedger'));
        }
      } catch {
        liveProjection = null;
      }

      async function load() {
        setLoading(true);
        setError(null);
        try {
          const response = await fetch(SNAPSHOT_URL, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`snapshot HTTP ${response.status}`);
          setSnapshot(await response.json());
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setLoading(false);
        }
      }

      useEffect(() => {
        void load();
      }, []);

      useEffect(() => {
        const form = getForm();
        if (!form) return undefined;
        const sync = () => setFormState(form.getSnapshot());
        sync();
        const unsubscribe = form.subscribe?.(sync);
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, []);

      useEffect(() => {
        if (formState?.value) setDraft(deepClone(formState.value));
      }, [formState?.revision, formState?.status]);

      useEffect(() => {
        if (!formState?.value && snapshot) {
          setDraft({
            minSeverity: snapshot.config?.minSeverity ?? 'medium',
            digest: deepClone(snapshot.config?.digest ?? {}),
            report: deepClone(snapshot.config?.report ?? {}),
            savings: deepClone(snapshot.config?.savings ?? {}),
            budget: deepClone(snapshot.config?.budget ?? {}),
            rules: deepClone(snapshot.rules ?? {}),
          });
        }
      }, [snapshot, formState?.value]);

      const totals = snapshot?.totals ?? {};
      const sessionStats = snapshot?.sessionStats ?? [];
      const selectedStats = sessionStats.find((row) => row.sessionId === selectedStatsSession)
        ?? sessionStats.find((row) => row.context != null)
        ?? sessionStats[0]
        ?? null;
      const context = selectedStats?.context
        ?? liveProjection?.context
        ?? snapshot?.context
        ?? null;
      const writable = snapshot != null;
      const rules = mergeRules(snapshot?.rules, draft?.rules);
      const digest = { ...(snapshot?.config?.digest ?? {}), ...(draft?.digest ?? {}) };
      const savings = { ...(snapshot?.config?.savings ?? {}), ...(draft?.savings ?? {}) };
      const budget = { ...(snapshot?.config?.budget ?? {}), ...(draft?.budget ?? {}) };
      const minSeverity = draft?.minSeverity ?? snapshot?.config?.minSeverity ?? 'medium';
      const allFailures = snapshot?.failures ?? [];
      const sessionIds = [...new Set(allFailures.map((row) => row.session).filter(Boolean))];
      const sessionFailures = selectedSession
        ? allFailures.filter((row) => row.session === selectedSession)
        : [];
      const sessionCategories = [...sessionFailures.reduce((map, row) => {
        map.set(row.category, (map.get(row.category) ?? 0) + 1);
        return map;
      }, new Map()).entries()];
      const sessionAnomalies = selectedSession
        ? (snapshot?.anomalies ?? []).filter((row) => row.session === selectedSession)
        : [];
      const coverage = snapshot?.guardCoverage ?? {};
      const unresolvedGroups = Array.isArray(snapshot?.unresolvedGroups)
        ? snapshot.unresolvedGroups
        : groupFailureRows(snapshot?.failures ?? []);
      const recentFailures = snapshot?.recentFailures ?? snapshot?.failures ?? [];

      async function copyUnresolved() {
        if (!navigator?.clipboard?.writeText) return;
        const lines = [`待解决失败（${unresolvedGroups.length} 个指纹）`];
        unresolvedGroups.slice(0, 20).forEach((group, index) => {
          lines.push(`${index + 1}. ${group.fingerprint} | ${group.tool}/${group.category} | ${group.count} 条 | 最近 ${formatTime(group.lastSeen)} | ${group.report ?? ''}`);
        });
        try {
          await navigator.clipboard.writeText(lines.join('\n'));
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }

      const update = (path, value) => {
        setDraft((current) => setIn(current ?? {}, path, value));
        setSavedAt(null);
      };

      async function postAdmin(payload) {
        const response = await fetch(ADMIN_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok !== true) {
          throw new Error(data?.error ?? data?.message ?? `admin HTTP ${response.status}`);
        }
        return data;
      }

      async function save() {
        if (!draft) return;
        setSaving(true);
        setError(null);
        try {
          const ops = CONFIG_PATHS
            .map((path) => ({ op: 'set', path, value: getIn(draft, path) }))
            .filter((operation) => operation.value !== undefined);
          await postAdmin({ action: 'config', ops });
          setSavedAt(new Date());
          await load();
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setSaving(false);
        }
      }

      function startNewGuard() {
        setGuardError(null);
        setGuardDraft({
          id: `custom-${Date.now().toString(36)}`,
          label: '',
          tool: '',
          category: '',
          code: '',
          hint: '',
          action: 'hint',
          mode: 'observe',
          enabled: true,
          isNew: true,
        });
      }

      function startEditGuard(guard) {
        setGuardError(null);
        setGuardDraft({
          id: guard.id,
          label: guard.label ?? '',
          tool: guard.tool ?? '',
          category: guard.category ?? '',
          code: guard.code ?? '',
          hint: guard.hint ?? '',
          action: guard.action ?? 'hint',
          mode: guard.mode ?? 'observe',
          enabled: guard.enabled !== false,
          isNew: false,
        });
      }

      function setGuardField(field, value) {
        setGuardDraft((current) => (current ? { ...current, [field]: value } : current));
      }

      async function saveGuard() {
        if (!guardDraft) return;
        setGuardSaving(true);
        setGuardError(null);
        try {
          await postAdmin({
            action: 'saveGuard',
            guard: {
              id: guardDraft.id,
              label: guardDraft.label,
              tool: guardDraft.tool,
              category: guardDraft.category,
              code: guardDraft.code,
              hint: guardDraft.hint,
              action: guardDraft.action,
              enabled: guardDraft.enabled,
            },
          });
          setGuardDraft(null);
          await load();
        } catch (cause) {
          setGuardError(errorText(cause));
        } finally {
          setGuardSaving(false);
        }
      }

      async function deleteGuard() {
        if (!guardDraft || guardDraft.isNew) return;
        setGuardSaving(true);
        setGuardError(null);
        try {
          await postAdmin({ action: 'deleteGuard', id: guardDraft.id });
          setGuardDraft(null);
          await load();
        } catch (cause) {
          setGuardError(errorText(cause));
        } finally {
          setGuardSaving(false);
        }
      }

      const toolRows = [...(snapshot?.errorSources?.byTool ?? [])]
        .sort((left, right) => right.failures - left.failures)
        .slice(0, 8);
      const categoryRows = [...(snapshot?.errorSources?.byCategory ?? [])]
        .sort((left, right) => right.failures - left.failures)
        .slice(0, 8);
      const routeRows = [...(snapshot?.byRoute ?? [])]
        .sort((left, right) => (
          (toCount(right.failures) - toCount(left.failures))
          || (toCount(right.savedTokens) - toCount(left.savedTokens))
        ))
        .slice(0, 8);
      const allGuards = snapshot?.guards ?? [];
      const appearedGuards = allGuards
        .filter((guard) => toCount(guard.hits) > 0)
        .sort((left, right) => toCount(right.hits) - toCount(left.hits));
      const visibleGuards = appearedGuards.slice(0, 20);
      const collapsedGuards = [
        ...appearedGuards.slice(20),
        ...allGuards.filter((guard) => toCount(guard.hits) === 0),
      ];
      const guardRows = (guards) => guards.map((guard) => [
        guard.label,
        guard.id,
        [guard.tool, guard.category, guard.code].filter(Boolean).join(' · ') || '—',
        guard.enabled === false ? '—' : '✓',
        guard.hits,
        h('button', {
          type: 'button',
          style: styles.button,
          onClick: () => startEditGuard(guard),
        }, translate('编辑', 'Edit')),
      ]);

      return h('div', { style: styles.page },
        h('header', { style: styles.header },
          h('div', null,
            h('h1', { style: styles.title }, translate('对话异常统计', 'Conversation Anomaly Stats')),
            h('p', { style: styles.subtitle }, translate(
              '整个 DSH 的失败、token 异常与保守节省统计；金额为估算，不是账单。',
              'Failures, token anomalies, and conservative savings across DSH; the money figure is an estimate, not a bill.',
            ))),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, onClick: () => void load(), disabled: loading },
              translate('刷新', 'Refresh')),
            h('button', {
              type: 'button',
              style: { ...styles.button, opacity: writable && draft ? 1 : 0.5, cursor: writable && draft ? 'pointer' : 'not-allowed' },
              onClick: () => void save(),
              disabled: !writable || !draft || saving,
            }, saving ? translate('保存中…', 'Saving…') : translate('保存参数', 'Save parameters')))),
        loading && snapshot == null ? h('p', { style: styles.muted }, translate('加载中…', 'Loading…')) : null,
        error ? h('p', { style: styles.error, role: 'alert' }, error) : null,
        savedAt ? h('p', { style: styles.muted }, translate('已保存。', 'Saved.')) : null,
        snapshot == null ? null : h('div', { style: { display: 'flex', flexDirection: 'column' } },
          h('div', { style: styles.grid },
            card(translate('累计节省', 'Saved tokens'), formatTokens(totals.savedTokens ?? 0)),
            card(translate('预计节省', 'Estimated saved'), formatCNY(snapshot.estimatedCNY ?? 0)),
            card(translate('累计花费', 'Spend'), formatCNY(snapshot.totalCostCNY ?? 0)),
            card(translate('今日花费', 'Today spend'), formatCNY(snapshot.todayCostCNY ?? 0)),
            card(translate('执行失败', 'Failures'), String(totals.failures ?? 0)),
            card(translate('未解决', 'Open'), String(snapshot.unresolved?.fingerprints ?? 0)),
            card(translate('异常项', 'Anomalies'), String(totals.anomalies ?? 0)),
            card(translate('压缩次数', 'Compressions'), String(totals.compressions ?? 0)),
            card(translate('覆盖会话', 'Sessions'), String(snapshot.sessions ?? 0))),
          snapshot.budget?.enabled && snapshot.budget?.status !== 'ok'
            ? h('p', {
              style: snapshot.budget.status === 'exceeded' ? styles.error : styles.muted,
              role: 'status',
            }, snapshot.budget.status === 'exceeded'
              ? translate('预算已超限。', 'Budget exceeded.')
              : translate('预算接近上限。', 'Budget approaching the limit.'))
            : null,
          context == null ? null : renderContextSection(context, selectedStats?.cost?.cny ?? null),
          section(translate('对话累计（整体）', 'Conversation totals'),
            sessionStats.length === 0
              ? h('p', { style: styles.muted }, translate('暂无会话累计数据', 'No conversation totals yet'))
              : h('div', null,
                h('div', { style: styles.row },
                  h('select', {
                    style: styles.select,
                    value: selectedStats?.sessionId ?? '',
                    onChange: (event) => setSelectedStatsSession(event.target.value),
                    'aria-label': translate('选择对话', 'Select conversation'),
                  },
                  sessionStats.map((row) => h('option', {
                    key: row.sessionId,
                    value: row.sessionId,
                  }, row.title || shortId(row.sessionId))))),
                selectedStats ? table(
                  [translate('对话', 'Conversation'), translate('失败', 'Failures'), translate('异常', 'Anomalies'), translate('节省 tokens', 'Saved tokens')],
                  [[
                    selectedStats.title || shortId(selectedStats.sessionId),
                    selectedStats.failures ?? 0,
                    selectedStats.anomalies ?? 0,
                    formatTokens(selectedStats.savedTokens ?? 0),
                  ]],
                  '',
                ) : null)),
          section(translate('待解决失败（按指纹）', 'Open failures by fingerprint'),
            h('div', { style: styles.row },
              h('p', { style: styles.muted }, translate(
                '这些是当前还需要处理的失败；把指纹或报告发我即可。',
                'These failures still need work; send me a fingerprint or report to resolve.',
              )),
              unresolvedGroups.length > 0 ? h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => void copyUnresolved(),
              }, copied ? translate('已复制', 'Copied') : translate('复制待解决清单', 'Copy open list')) : null),
            table(
              [translate('指纹', 'Fingerprint'), translate('工具/类别', 'Tool/category'), translate('次数', 'Count'), translate('最近', 'Last'), translate('报告', 'Report')],
              unresolvedGroups.slice(0, 12).map((group) => [
                group.fingerprint,
                `${group.tool}/${group.category}`,
                group.count,
                formatTime(group.lastSeen),
                group.report ?? '—',
              ]),
              translate('没有未解决失败', 'No open failures'),
            )),
          section(translate('最近失败（含已解决状态）', 'Recent failures (with status)'),
            table(
              [translate('ID', 'ID'), translate('工具', 'Tool'), translate('类别', 'Category'), translate('状态', 'Status'), translate('时间', 'Time'), translate('报告', 'Report')],
              recentFailures.slice(0, 10).map((row) => [
                row.id,
                row.tool,
                row.category,
                row.resolved ? translate('已解决', 'Resolved') : translate('未解决', 'Open'),
                formatTime(row.time),
                row.resolved ? '—' : row.report,
              ]),
              translate('暂无失败', 'No failures yet'),
            ),
            h('p', { style: styles.muted }, translate(
              '最近 10 条包含已解决记录；已解决的报告/raw 已清理，只保留索引与统计。',
              'The latest 10 include resolved records; resolved reports/raw are deleted and only the index remains.',
            ))),
          h('details', { style: { ...styles.details, order: 3 } },
            h('summary', { style: styles.summary }, translate(
              '诊断与统计（Guard / 会话 / 错误源 / 节省）',
              'Diagnostics (guards / sessions / sources / savings)',
            )),
            h('p', { style: styles.muted }, translate(
              `Guard 覆盖：${coverage.coveredFingerprints ?? 0}/${coverage.unresolvedFingerprints ?? 0} 个未解决指纹（${coverage.percent ?? 0}%）。`,
              `Guard coverage: ${coverage.coveredFingerprints ?? 0}/${coverage.unresolvedFingerprints ?? 0} open fingerprints (${coverage.percent ?? 0}%).`,
            )),
          section(translate('会话下钻', 'Session drill-down'),
            h('p', { style: styles.muted }, translate(
              '按一次对话/子代理过滤全局失败，查看它当时失败的工具、类别和时间线；不是新的全局统计。',
              'Filter the global ledger to one conversation/subagent to inspect its failed tools, categories, and timeline. It is a filter, not another global metric.',
            )),
            h('div', { style: styles.row },
              h('select', {
                style: styles.select,
                value: selectedSession,
                onChange: (event) => setSelectedSession(event.target.value),
                'aria-label': translate('选择会话', 'Select session'),
              },
              h('option', { value: '' }, translate('选择会话…', 'Select a session…')),
              sessionIds.map((id) => h('option', { key: id, value: id }, shortId(id)))),
              selectedSession ? h('button', {
                type: 'button',
                style: styles.button,
                onClick: () => setSelectedSession(''),
              }, translate('清除', 'Clear')) : null),
            selectedSession
              ? h('div', null,
                h('p', { style: styles.muted }, translate(
                  `${shortId(selectedSession)} · ${sessionFailures.length} 条失败 · ${sessionCategories.map(([key, value]) => `${key}:${value}`).join(' · ') || '无分类'}`,
                  `${shortId(selectedSession)} · ${sessionFailures.length} failures · ${sessionCategories.map(([key, value]) => `${key}:${value}`).join(' · ') || 'no categories'}`,
                )),
                h('p', { style: styles.muted }, translate(
                  `时间线（最近 ${Math.min(sessionFailures.length, 20)} 条）`,
                  `Timeline (latest ${Math.min(sessionFailures.length, 20)})`,
                )),
                table(
                  [translate('时间', 'Time'), translate('工具', 'Tool'), translate('类别', 'Category'), translate('严重度', 'Severity'), translate('报告', 'Report')],
                  sessionFailures.slice(0, 20).map((row) => [
                    formatTime(row.time),
                    row.tool,
                    row.category,
                    row.severity,
                    row.report,
                  ]),
                  translate('该会话暂无失败', 'No failures in this session'),
                ),
                sessionAnomalies.length > 0
                  ? table(
                    [translate('规则', 'Rule'), translate('次数', 'Count'), translate('浪费 tokens', 'Wasted'), translate('时间', 'Time')],
                    sessionAnomalies.slice(0, 10).map((row) => [
                      row.ruleId,
                      row.count,
                      formatTokens(row.wastedTokens),
                      formatTime(row.time),
                    ]),
                    '',
                  )
                  : null)
              : h('p', { style: styles.muted }, translate(
                '选择会话查看失败时间线；当前快照最多 500 条。',
                'Select a session to inspect its failure timeline; the snapshot keeps up to 500 entries.',
              ))),
          section(translate('错误源', 'Error sources'),
            h('div', { style: styles.twoCols },
              table(
                [translate('工具', 'Tool'), translate('次数', 'Failures'), translate('节省', 'Saved')],
                toolRows.map((row) => [row.tool, row.failures, formatTokens(row.savedTokens)]),
                translate('暂无工具错误', 'No tool failures'),
              ),
              table(
                [translate('类别', 'Category'), translate('次数', 'Failures')],
                categoryRows.map((row) => [row.category, row.failures]),
                translate('暂无类别统计', 'No category stats'),
              ))),
          section(translate('防复发 Guard（观察+提示）', 'Guards (observe + hint)'),
            table(
              [
                translate('Guard', 'Guard'),
                translate('匹配', 'Match'),
                translate('模式', 'Mode'),
                translate('命中', 'Hits'),
                translate('最近', 'Last'),
              ],
              (snapshot.guards ?? []).map((guard) => [
                guard.label,
                [guard.fingerprint ? `fp:${guard.fingerprint}` : null, guard.tool, guard.category, guard.code].filter(Boolean).join(' · ') || '—',
                guard.mode,
                guard.hits,
                formatTime(guard.lastHitAt),
              ]),
              translate('暂无 Guard', 'No guards'),
            ),
            h('p', { style: styles.muted }, translate(
              `命中 ${coverage.guardHits ?? 0} 次；已解决固化 ${coverage.resolvedGuarded ?? 0}/${coverage.resolvedFingerprints ?? 0}（${coverage.resolvedPercent ?? 0}%）；Step 2 只提示，不阻断。`,
              `${coverage.guardHits ?? 0} hits; resolved fixes guarded ${coverage.resolvedGuarded ?? 0}/${coverage.resolvedFingerprints ?? 0} (${coverage.resolvedPercent ?? 0}%); hints only, never blocks.`,
            ))),
          section(translate('修复库（playbook）', 'Playbook'),
            table(
              [
                translate('指纹', 'Fingerprint'),
                translate('修复', 'Fix'),
                translate('固化', 'Guarded'),
                translate('解决时间', 'Resolved'),
              ],
              (snapshot.playbook ?? []).slice(0, 10).map((row) => [
                row.fingerprint,
                String(row.fix ?? '').slice(0, 140),
                row.guardId ? translate('已固化', 'Guarded') : translate('未固化', 'Not guarded'),
                formatTime(row.resolvedAt),
              ]),
              translate('暂无已解决修复', 'No resolved fixes yet'),
            ),
            h('p', { style: styles.muted }, translate(
              '模型可用 failure_inbox action="playbook" 检索修复；resolve 时自动生成 learned Guard 和 regressions/<指纹>.md 草案。',
              'The model can retrieve fixes with failure_inbox action="playbook"; resolve creates a learned Guard and a regressions/<fingerprint>.md draft.',
            ))),
          section(translate('异常明细（最近）', 'Recent anomalies'),
            table(
              [translate('规则', 'Rule'), translate('次数', 'Count'), translate('浪费 tokens', 'Wasted'), translate('会话', 'Session'), translate('时间', 'Time')],
              (snapshot.anomalies ?? []).slice(0, 10).map((row) => [
                row.ruleId,
                row.count,
                formatTokens(row.wastedTokens),
                shortId(row.session),
                formatTime(row.time),
              ]),
              translate('暂无异常', 'No anomalies'),
            )),
          section(translate('节省明细（按模型）', 'Savings by model'),
            table(
              [translate('模型', 'Model'), translate('失败次数', 'Failures'), translate('节省 tokens', 'Saved'), translate('预计金额', 'Estimated'), translate('单价', 'Unit price')],
              routeRows.map((row) => [
                `${row.provider}/${row.model}`,
                toCount(row.failures),
                formatTokens(row.savedTokens),
                formatCNY(row.cny),
                `${row.unitPricePerMTokens} ${translate('元/百万', 'CNY/M')}`,
              ]),
              translate('暂无节省记录', 'No savings yet'),
            ),
            h('p', { style: styles.muted }, translate(
              `价格来源：${snapshot.pricing?.source ?? 'DeepSeek 官方价'}（抓取 ${snapshot.pricing?.fetchedAt ?? '-'}），模式 ${snapshot.pricing?.mode ?? '-'}；金额只读、保守估算。`,
              `Price source: ${snapshot.pricing?.source ?? 'DeepSeek pricing'} (fetched ${snapshot.pricing?.fetchedAt ?? '-'}), mode ${snapshot.pricing?.mode ?? '-'}; read-only and conservative.`,
            ))),
          ),
          h('div', { style: { ...styles.details, order: 2, display: 'flex', flexDirection: 'column' } },
            h('div', { style: { order: 2, minWidth: 0 } },
            section(translate('Guard 规则（查看 / 修改 / 新建）', 'Guard rules (view / edit / create)'),
              h('div', { style: styles.row },
                h('p', { style: styles.muted }, translate(
                  'Guard 在失败后记录命中，并在下一步给出一行提示；新建规则默认 observe、不阻断。',
                  'Guards record hits after failures and inject one hint on the next step; new rules default to observe and never block.',
                )),
                h('button', { type: 'button', style: styles.button, onClick: startNewGuard }, translate('新建 Guard', 'New guard'))),
              guardError ? h('p', { style: styles.error, role: 'alert' }, guardError) : null,
              guardDraft ? h('div', { style: styles.guardForm },
                h('div', { style: styles.formGrid },
                  h('label', { style: styles.row },
                    h('span', null, 'ID'),
                    h('input', {
                      style: { ...styles.input, width: '100%' },
                      value: guardDraft.id,
                      disabled: !guardDraft.isNew,
                      onInput: (event) => setGuardField('id', event.target.value),
                    })),
                  h('label', { style: styles.row },
                    h('span', null, translate('名称', 'Label')),
                    h('input', {
                      style: { ...styles.input, width: '100%' },
                      value: guardDraft.label,
                      onInput: (event) => setGuardField('label', event.target.value),
                    })),
                  h('label', { style: styles.row },
                    h('span', null, 'tool'),
                    h('input', {
                      style: { ...styles.input, width: '100%' },
                      value: guardDraft.tool,
                      onInput: (event) => setGuardField('tool', event.target.value),
                    })),
                  h('label', { style: styles.row },
                    h('span', null, 'category'),
                    h('input', {
                      style: { ...styles.input, width: '100%' },
                      value: guardDraft.category,
                      onInput: (event) => setGuardField('category', event.target.value),
                    })),
                  h('label', { style: styles.row },
                    h('span', null, 'code'),
                    h('input', {
                      style: { ...styles.input, width: '100%' },
                      value: guardDraft.code,
                      onInput: (event) => setGuardField('code', event.target.value),
                    })),
                ),
                h('label', { style: styles.row },
                  h('span', null, translate('提示文本', 'Hint')),
                  h('textarea', {
                    style: { ...styles.input, width: '100%', minHeight: '56px' },
                    value: guardDraft.hint,
                    onInput: (event) => setGuardField('hint', event.target.value),
                  })),
                h('div', { style: styles.row },
                  checkbox(translate('启用', 'Enabled'), guardDraft.enabled, (value) => setGuardField('enabled', value), false),
                  selectField(translate('动作', 'Action'), guardDraft.action, [
                    ['hint', translate('提示（默认）', 'Hint (default)')],
                    ['observe', translate('只观察', 'Observe only')],
                  ], (value) => setGuardField('action', value), false),
                  h('span', { style: styles.muted }, translate('模式：observe；不阻断', 'Mode: observe; no blocking')),
                ),
                h('div', { style: styles.row },
                  h('button', {
                    type: 'button',
                    style: { ...styles.button, opacity: guardSaving ? 0.5 : 1 },
                    disabled: guardSaving,
                    onClick: () => void saveGuard(),
                  }, guardSaving ? translate('保存中…', 'Saving…') : translate('保存 Guard', 'Save guard')),
                  h('button', {
                    type: 'button',
                    style: styles.button,
                    disabled: guardSaving,
                    onClick: () => setGuardDraft(null),
                  }, translate('取消', 'Cancel')),
                  !guardDraft.isNew ? h('button', {
                    type: 'button',
                    style: styles.button,
                    disabled: guardSaving,
                    onClick: () => void deleteGuard(),
                  }, translate('删除自定义 Guard', 'Delete custom guard')) : null),
              ) : null,
              table(
                [translate('Guard', 'Guard'), translate('ID', 'ID'), translate('匹配', 'Match'), translate('启用', 'On'), translate('命中', 'Hits'), translate('操作', 'Action')],
                guardRows(visibleGuards),
                translate('暂无已出现 Guard', 'No guards have appeared yet'),
              ),
              h('p', { style: styles.muted }, translate(
                `已出现 ${appearedGuards.length} 条，显示前 ${Math.min(appearedGuards.length, 20)} 条；超出 20 条与未出现的规则已收起。`,
                `${appearedGuards.length} guards have appeared; showing the first ${Math.min(appearedGuards.length, 20)}. Overflow beyond 20 and unseen rules are collapsed.`,
              )),
              collapsedGuards.length > 0
                ? h('details', { style: { ...styles.details, marginTop: '8px' } },
                  h('summary', { style: styles.summary }, translate(
                    `更多 Guard（超出 20 / 未出现）：${collapsedGuards.length} 条`,
                    `More guards (overflow / unseen): ${collapsedGuards.length}`,
                  )),
                  table(
                    [translate('Guard', 'Guard'), translate('ID', 'ID'), translate('匹配', 'Match'), translate('启用', 'On'), translate('命中', 'Hits'), translate('操作', 'Action')],
                    guardRows(collapsedGuards),
                    '',
                  ))
                : null,
            ),
            ),
            h('div', { style: { order: 1, minWidth: 0 } },
            section(translate('规则与参数', 'Rules and parameters'),
            writable
              ? h('p', { style: styles.muted }, translate(
                '修改后点顶部“保存参数”；保存后重新读取 Host 配置。',
                'Edit, then use “Save parameters” at the top; the Host config is reloaded afterwards.',
              ))
              : h('p', { style: styles.muted }, translate(
                '参数暂不可写，请稍后刷新。',
                'Parameters are not writable yet; refresh later.',
              )),
            h('div', { style: styles.formGrid },
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, translate('摘要', 'Digest')),
                checkbox(translate('启用大错误压缩', 'Enable large-error digest'), digest.enabled, (value) => update(['digest', 'enabled'], value), !writable),
                numberField(translate('压缩阈值 tokens', 'Digest threshold (tokens)'), digest.maxInlineTokens, (value) => update(['digest', 'maxInlineTokens'], value), !writable),
                numberField(translate('摘要 detail 字符', 'Digest detail chars'), digest.maxDetailChars, (value) => update(['digest', 'maxDetailChars'], value), !writable),
              ),
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, translate('节省与价格', 'Savings and pricing')),
                selectField(translate('计价模式', 'Price mode'), savings.priceMode, [
                  ['cacheMissOffPeak', translate('空闲·缓存未命中（默认）', 'Off-peak cache miss (default)')],
                  ['cacheHitOffPeak', translate('空闲·缓存命中', 'Off-peak cache hit')],
                  ['peakCacheMiss', translate('高峰·缓存未命中', 'Peak cache miss')],
                  ['custom', translate('自定义单价', 'Custom unit price')],
                ], (value) => update(['savings', 'priceMode'], value), !writable),
                numberField(translate('自定义单价 元/百万', 'Custom unit price CNY/M'), savings.customUnitPricePerMTokens, (value) => update(['savings', 'customUnitPricePerMTokens'], value), !writable),
                selectField(translate('摘要最低严重度', 'Digest min severity'), minSeverity, [
                  ['low', translate('低', 'Low')],
                  ['medium', translate('中', 'Medium')],
                  ['high', translate('高', 'High')],
                ], (value) => update(['minSeverity'], value), !writable),
                h('p', { style: styles.muted }, translate(
                  `报表根目录（需重启）：${snapshot.config?.reportRoot ?? '-'}`,
                  `Report root (restart to change): ${snapshot.config?.reportRoot ?? '-'}`,
                )),
              ),
              h('div', { style: styles.card },
                h('h3', { style: styles.sectionTitle }, translate('预算提示', 'Budget warning')),
                checkbox(translate('启用预算提示', 'Enable budget warning'), budget.enabled, (value) => update(['budget', 'enabled'], value), !writable),
                numberField(translate('本会话预算 元', 'Session budget CNY'), budget.sessionCNY, (value) => update(['budget', 'sessionCNY'], value), !writable),
                numberField(translate('今日预算 元', 'Daily budget CNY'), budget.dailyCNY, (value) => update(['budget', 'dailyCNY'], value), !writable),
                numberField(translate('预警比例 0–1', 'Warn ratio 0–1'), budget.warnRatio, (value) => update(['budget', 'warnRatio'], value), !writable),
                h('p', { style: styles.muted }, translate(
                  '只做估算与提示，不查余额、不阻断。',
                  'Estimate and warning only; no balance lookup, no blocking.',
                )),
              )),
            h('div', { style: styles.ruleList },
              RULE_ROWS.map(([ruleId, zhLabel, enLabel, fields]) => {
                const rule = rules?.[ruleId] ?? {};
                return h('div', { key: ruleId, style: styles.ruleRow },
                  checkbox(translate(zhLabel, enLabel), rule.enabled, (value) => update(['rules', ruleId, 'enabled'], value), !writable),
                  ...fields.map(([field, zhField, enField]) => numberField(
                    translate(zhField, enField),
                    rule[field],
                    (value) => update(['rules', ruleId, field], value),
                    !writable,
                    true,
                  )));
              })))),
            ),
        ),
      );
    }

    function card(label, value) {
      return h('div', { style: styles.card },
        h('div', { style: styles.cardLabel }, label),
        h('div', { style: styles.cardValue }, value));
    }

    function section(title, ...content) {
      return h('section', { style: styles.section },
        h('h2', { style: styles.sectionTitle }, title),
        ...content);
    }

    function table(headers, rows, emptyText) {
      if (!rows || rows.length === 0) return h('p', { style: styles.muted }, emptyText);
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: styles.table },
          h('thead', null, h('tr', null, ...headers.map((header) => h('th', { key: header, style: styles.th }, header)))),
          h('tbody', null, ...rows.map((row, index) => h('tr', { key: index },
            ...row.map((cell, cellIndex) => h('td', { key: cellIndex, style: styles.td }, isElement(cell) ? cell : cellText(cell))))))));
    }

    function isElement(value) {
      return value != null && typeof value === 'object'
        && (value.$$typeof != null || typeof value.type === 'string' || typeof value.type === 'function');
    }

    function renderContextSection(context, costCNY) {
      const series = Array.isArray(context?.series) ? context.series : [];
      const window = toCount(context?.window);
      const lastInput = toCount(context?.lastInputTokens);
      const lastOutput = toCount(context?.lastOutputTokens);
      const used = lastInput + lastOutput;
      const ratio = window > 0 ? Math.round((used / window) * 1000) / 10 : null;
      const topSources = contextTopSources(series);
      const turnDelta = contextTurnDelta(series);
      const recent = series.slice(-5).reverse();
      return section(translate('上下文归因（所选对话）', 'Context attribution (selected conversation)'),
        h('div', { style: styles.grid },
          card(translate('当前上下文', 'Current context'),
            window > 0 ? `${formatTokens(used)} / ${formatTokens(window)}` : `${formatTokens(used)} · ${translate('窗口未知', 'window unknown')}`),
          card(translate('窗口占比', 'Window ratio'), ratio == null ? translate('未知', 'unknown') : `${ratio}%`),
          card(translate('本回合增量', 'This turn growth'), `+${formatTokens(turnDelta)}`),
          card(translate('本会话花费', 'Session spend'), costCNY == null ? '—' : formatCNY(costCNY)),
          card(translate('压缩 / 重置', 'Compactions'), String(toCount(context?.compactionCount)))),
        h('p', { style: styles.muted }, translate(
          `主要来源：${topSources.length === 0 ? '—' : topSources.map(([source, tokens, count]) => `${contextSourceLabel(source)} ${formatTokens(tokens)}（${count} 次）`).join(' · ')}`,
          `Top sources: ${topSources.length === 0 ? '—' : topSources.map(([source, tokens, count]) => `${contextSourceLabel(source)} ${formatTokens(tokens)} (${count}x)`).join(' · ')}`,
        )),
        table(
          [
            translate('时间', 'Time'),
            translate('增量', 'Delta'),
            translate('来源', 'Source'),
            translate('工具 / 调用', 'Tool / call'),
            translate('窗口占比', 'Window ratio'),
          ],
          recent.map((entry) => {
            const delta = Number(entry?.delta);
            const entryWindow = toCount(entry?.window);
            return [
              entry?.at == null ? '—' : formatTime(entry.at),
              Number.isFinite(delta) && delta > 0 ? `+${formatTokens(delta)}` : '—',
              contextSourceLabel(entry?.source),
              entry?.tool || entry?.callId || '—',
              Number.isFinite(delta) && delta > 0 && entryWindow > 0
                ? `${Math.round((delta / entryWindow) * 1000) / 10}%`
                : '—',
            ];
          }),
          translate('暂无上下文增长记录', 'No context growth recorded yet'),
        ),
        h('p', { style: styles.muted }, translate(
          `最近 ${Math.min(series.length, 5)} 次请求；归因基于最近一次 tool/user/system 事件，近似 ±10%，不是精确构成。`,
          `Latest ${Math.min(series.length, 5)} requests; attribution uses the nearest tool/user/system event, approximate ±10%, not an exact breakdown.`,
        )));
    }

    function contextTopSources(series) {
      const totals = new Map();
      for (const entry of Array.isArray(series) ? series : []) {
        const delta = Number(entry?.delta);
        if (!Number.isFinite(delta) || delta <= 0 || entry?.compaction === true) continue;
        const source = entry?.source ?? 'unknown';
        const current = totals.get(source) ?? { count: 0, tokens: 0 };
        totals.set(source, { count: current.count + 1, tokens: current.tokens + delta });
      }
      return [...totals.entries()]
        .map(([source, value]) => [source, value.tokens, value.count])
        .sort((left, right) => (right[2] - left[2]) || (right[1] - left[1]))
        .slice(0, 3);
    }

    function contextTurnDelta(series) {
      const rows = Array.isArray(series) ? series : [];
      const latestTurn = rows.at(-1)?.turn;
      if (latestTurn == null) return 0;
      return rows
        .filter((entry) => entry?.turn === latestTurn)
        .reduce((sum, entry) => {
          const delta = Number(entry?.delta);
          return Number.isFinite(delta) && delta > 0 ? sum + delta : sum;
        }, 0);
    }

    function contextSourceLabel(source) {
      switch (source) {
        case 'tool': return translate('工具', 'tool');
        case 'user': return translate('用户', 'user');
        case 'system-cache': return translate('系统/缓存', 'system/cache');
        case 'compaction': return translate('压缩', 'compaction');
        case 'baseline': return translate('基线', 'baseline');
        default: return translate('未知', 'unknown');
      }
    }

    function checkbox(label, value, onChange, disabled) {
      return h('label', { style: styles.row },
        h('input', {
          type: 'checkbox',
          checked: value === true,
          disabled: Boolean(disabled),
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', null, label));
    }

    function numberField(label, value, onChange, disabled, compact = false) {
      return h('label', { style: compact ? styles.compactField : styles.row },
        h('span', null, label),
        h('input', {
          type: 'number',
          value: value ?? '',
          disabled: Boolean(disabled),
          onChange: (event) => {
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          },
          style: styles.input,
        }));
    }

    function selectField(label, value, options, onChange, disabled) {
      return h('label', { style: styles.row },
        h('span', null, label),
        h('select', {
          value: value ?? '',
          disabled: Boolean(disabled),
          onChange: (event) => onChange(event.target.value),
          style: styles.select,
        }, ...options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel))));
    }

    function getForm() {
      try {
        return activeConfigForms?.get?.(CONFIG_ENTRY) ?? null;
      } catch {
        return null;
      }
    }

    return {
      inject: ['slots', 'layout', 'locale', 'configForms', 'commandUi'],
      apply(ctx) {
        activeLayout = ctx.layout ?? null;
        try {
          activeConfigForms = ctx.configForms ?? ctx.get?.('configForms') ?? null;
        } catch {
          activeConfigForms = null;
        }
        try {
          const localeId = String(ctx.locale?.getLocale?.().id ?? '').toLowerCase();
          if (localeId !== '') {
            translate = localeId.startsWith('zh') ? (zh) => zh : (_zh, en) => en;
          }
        } catch {
          translate = (zh) => zh;
        }

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'failure-ledger.reminder',
          order: 40,
        }, Reminder));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => translate('对话异常统计', 'Conversation Anomaly Stats'),
        }, PanelIcon));

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'failure-ledger.stats',
          order: -1000000,
        }, ComposerStats));

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'failure-ledger.bridge',
          order: 999,
        }, PanelBridge));

        ctx.effect(() => ctx.commandUi.register({
          name: 'dfl-ui',
          available: () => true,
          label: () => 'DFL-UI',
          description: () => translate('打开对话异常统计面板', 'Open the Conversation Anomaly Stats panel'),
          icon: PanelIcon,
          ui: {
            kind: 'action',
            run: () => {
              try {
                activeLayout?.selectPanel(PANEL_ID);
              } catch {
                // The panel may not be registered yet during startup.
              }
            },
          },
        }));
      },
    };
  },
});

const styles = {
  page: {
    padding: '20px 24px 28px',
    maxWidth: '1100px',
    width: '100%',
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    boxSizing: 'border-box',
    margin: '0 auto',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '16px',
  },
  title: { margin: 0, fontSize: '18px', fontWeight: 600 },
  subtitle: { margin: '4px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
  actions: { display: 'flex', gap: '8px', flexShrink: 0 },
  button: {
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '10px',
    marginBottom: '16px',
  },
  card: {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
    padding: '12px 14px',
  },
  cardLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '4px' },
  cardValue: { fontSize: '18px', fontWeight: 600 },
  section: { marginBottom: '18px' },
  details: {
    marginBottom: '16px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
    padding: '8px 12px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  summary: { cursor: 'pointer', fontSize: '14px', fontWeight: 600, padding: '4px 0' },
  sectionTitle: { margin: '0 0 8px', fontSize: '14px', fontWeight: 600 },
  twoCols: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px', marginBottom: '12px' },
  guardForm: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
    padding: '10px',
    margin: '10px 0',
    background: 'var(--dsw-alias-bg-base)',
  },
  ruleList: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '4px 16px' },
  ruleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', fontSize: '12px' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '5px 0', fontSize: '12px', flexWrap: 'wrap' },
  compactField: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' },
  input: {
    width: '88px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '4px 6px',
    fontSize: '12px',
  },
  select: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '4px 6px',
    fontSize: '12px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    color: 'var(--dsw-alias-label-secondary)',
    fontWeight: 500,
  },
  td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
  error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
};

function unwrapProjection(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.getSnapshot === 'function') {
    try {
      return value.getSnapshot();
    } catch {
      return null;
    }
  }
  if (value.value && typeof value.value === 'object') return value.value;
  return value;
}

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1_000_000) return `${Math.round(number / 100_000) / 10}M`;
  if (number >= 1_000) return `${Math.round(number / 100) / 10}k`;
  return String(Math.round(number));
}

function formatCNY(value) {
  const number = Number(value);
  return `¥${Number.isFinite(number) ? number.toFixed(2) : '0.00'}`;
}

function formatTime(value) {
  if (value == null) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}

function shortId(value) {
  if (value == null) return '';
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

function groupFailureRows(rows) {
  const groups = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.fingerprint !== 'string') continue;
    let group = groups.get(row.fingerprint);
    if (!group) {
      group = { ...row, count: 0, firstSeen: row.time, lastSeen: row.time };
      groups.set(row.fingerprint, group);
    }
    group.count += 1;
    if (!group.lastSeen || Date.parse(row.time) >= Date.parse(group.lastSeen)) {
      Object.assign(group, row);
      group.lastSeen = row.time;
    }
  }
  return [...groups.values()]
    .sort((left, right) => {
      const countDelta = (right.count ?? 0) - (left.count ?? 0);
      if (countDelta !== 0) return countDelta;
      return Date.parse(right.lastSeen) - Date.parse(left.lastSeen);
    })
    .map((group) => ({
      fingerprint: group.fingerprint,
      count: group.count,
      tool: group.tool,
      category: group.category,
      severity: group.severity,
      code: group.code,
      session: group.session,
      report: group.report,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
    }));
}

function cellText(value) {
  return value == null ? '' : String(value);
}

function mergeRules(base, override) {
  const merged = {};
  for (const [ruleId, value] of Object.entries(base ?? {})) {
    merged[ruleId] = value && typeof value === 'object' ? { ...value } : value;
  }
  for (const [ruleId, value] of Object.entries(override ?? {})) {
    merged[ruleId] = {
      ...(merged[ruleId] && typeof merged[ruleId] === 'object' ? merged[ruleId] : {}),
      ...(value && typeof value === 'object' ? value : {}),
    };
  }
  return merged;
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function getIn(value, path) {
  let current = value;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function setIn(value, path, nextValue) {
  if (path.length === 0) return nextValue;
  const root = Array.isArray(value) ? [...value] : { ...value };
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const child = current[key];
    current[key] = Array.isArray(child) ? [...child] : { ...(child ?? {}) };
    current = current[key];
  }
  current[path[path.length - 1]] = nextValue;
  return root;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
