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

      const n1 = toCount(projection?.n1);
      const n2 = toCount(projection?.n2);
      if (n1 === 0 && n2 === 0) return null;

      const savedTokens = toCount(projection?.savedTokens);
      const parts = [];
      if (n1 > 0) parts.push(translate(`失败 ${n1} 次`, `${n1} failed`));
      if (n2 > 0) parts.push(translate(`异常 ${n2} 项`, `${n2} anomalies`));
      if (savedTokens > 0) {
        parts.push(translate(`节省 ~${formatTokens(savedTokens)} tokens`, `~${formatTokens(savedTokens)} tokens saved`));
      }
      const summary = `${translate('本对话累计：', 'This conversation so far: ')}${parts.join(' · ')}`;
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

    function Panel() {
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [formState, setFormState] = useState(null);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState(null);

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
            rules: deepClone(snapshot.rules ?? {}),
          });
        }
      }, [snapshot, formState?.value]);

      const totals = snapshot?.totals ?? {};
      const writable = formState?.writable === true;
      const formStatus = formState?.status ?? 'unavailable';
      const rules = mergeRules(snapshot?.rules, draft?.rules);
      const digest = { ...(snapshot?.config?.digest ?? {}), ...(draft?.digest ?? {}) };
      const savings = { ...(snapshot?.config?.savings ?? {}), ...(draft?.savings ?? {}) };
      const minSeverity = draft?.minSeverity ?? snapshot?.config?.minSeverity ?? 'medium';

      const update = (path, value) => {
        setDraft((current) => setIn(current ?? {}, path, value));
        setSavedAt(null);
      };

      async function save() {
        const form = getForm();
        const current = form?.getSnapshot?.();
        if (!form || !current?.writable || !draft) return;
        setSaving(true);
        setError(null);
        try {
          const ops = CONFIG_PATHS
            .map((path) => ({ op: 'set', path, value: getIn(draft, path) }))
            .filter((operation) => operation.value !== undefined);
          const accepted = await form.mutate(ops, current.revision);
          if (!accepted) {
            setError(translate('保存被拒绝（可能有并发修改），已刷新表单。', 'Save was rejected (possibly a concurrent edit); the form was refreshed.'));
          } else {
            setSavedAt(new Date());
            await load();
          }
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setSaving(false);
        }
      }

      const toolRows = [...(snapshot?.errorSources?.byTool ?? [])]
        .sort((left, right) => right.failures - left.failures)
        .slice(0, 8);
      const categoryRows = [...(snapshot?.errorSources?.byCategory ?? [])]
        .sort((left, right) => right.failures - left.failures)
        .slice(0, 8);
      const routeRows = [...(snapshot?.byRoute ?? [])]
        .sort((left, right) => right.savedTokens - left.savedTokens)
        .slice(0, 8);

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
        snapshot == null ? null : h('div', null,
          h('div', { style: styles.grid },
            card(translate('累计节省', 'Saved tokens'), formatTokens(totals.savedTokens ?? 0)),
            card(translate('预计节省', 'Estimated saved'), formatCNY(snapshot.estimatedCNY ?? 0)),
            card(translate('执行失败', 'Failures'), String(totals.failures ?? 0)),
            card(translate('未解决', 'Open'), String(snapshot.unresolved?.fingerprints ?? 0)),
            card(translate('异常项', 'Anomalies'), String(totals.anomalies ?? 0)),
            card(translate('压缩次数', 'Compressions'), String(totals.compressions ?? 0)),
            card(translate('覆盖会话', 'Sessions'), String(snapshot.sessions ?? 0))),
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
              [translate('模型', 'Model'), translate('节省 tokens', 'Saved'), translate('预计金额', 'Estimated'), translate('单价', 'Unit price')],
              routeRows.map((row) => [
                `${row.provider}/${row.model}`,
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
          section(translate('最近失败', 'Recent failures'),
            table(
              [translate('ID', 'ID'), translate('工具', 'Tool'), translate('类别', 'Category'), translate('严重度', 'Severity'), translate('时间', 'Time'), translate('报告', 'Report')],
              (snapshot.failures ?? []).slice(0, 10).map((row) => [
                row.id,
                row.tool,
                row.category,
                row.severity,
                formatTime(row.time),
                row.report,
              ]),
              translate('暂无失败', 'No failures yet'),
            ),
          ),
          section(translate('规则与参数', 'Rules and parameters'),
            formStatus !== 'ready' || !writable
              ? h('p', { style: styles.muted }, translate(
                `参数表单不可用（状态：${formStatus}）。仍可查看上方只读统计。`,
                `Parameter form unavailable (status: ${formStatus}). Read-only statistics above still apply.`,
              ))
              : h('p', { style: styles.muted }, translate(
                '修改后点“保存参数”写入 profile 配置；保存前会重新读取 revision。',
                'Edits are written to the profile configuration by “Save parameters”; the revision is re-read before writing.',
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
              }))),
        ),
      );
    }

    function card(label, value) {
      return h('div', { style: styles.card },
        h('div', { style: styles.cardLabel }, label),
        h('div', { style: styles.cardValue }, value));
    }

    function section(title, content) {
      return h('section', { style: styles.section },
        h('h2', { style: styles.sectionTitle }, title),
        content);
    }

    function table(headers, rows, emptyText) {
      if (!rows || rows.length === 0) return h('p', { style: styles.muted }, emptyText);
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: styles.table },
          h('thead', null, h('tr', null, ...headers.map((header) => h('th', { key: header, style: styles.th }, header)))),
          h('tbody', null, ...rows.map((row, index) => h('tr', { key: index },
            ...row.map((cell, cellIndex) => h('td', { key: cellIndex, style: styles.td }, cellText(cell))))))));
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
  sectionTitle: { margin: '0 0 8px', fontSize: '14px', fontWeight: 600 },
  twoCols: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px', marginBottom: '12px' },
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
  return `¥${Number.isFinite(number) ? number.toFixed(4) : '0.0000'}`;
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
