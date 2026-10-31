import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const CLIENT_PATH = new URL('../client.js', import.meta.url);

async function loadClient(extraReact = {}) {
  const source = await readFile(CLIENT_PATH, 'utf8');
  let definition;
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
  };
  vm.runInNewContext(source, { window, console });
  assert.ok(definition, 'client module was not loaded');
  assert.equal(definition.id, '@local/dsh-failure-ledger');

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(),
  });
  const module = definition.factory((name) => {
    if (name === 'react') return { createElement, ...extraReact };
    throw new Error(`unexpected require: ${name}`);
  });
  return { module, source };
}

function applyClient(module, { locale = 'zh-CN' } = {}) {
  const registrations = [];
  const panels = [];
  const commands = [];
  const ctx = {
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    commandUi: {
      register(command) {
        commands.push(command);
        return () => {};
      },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback();
        return () => dispose?.();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    layout: {
      selectPanel(id) {
        panels.push(id);
      },
    },
    locale: {
      getLocale() {
        return { id: locale };
      },
    },
  };
  module.apply(ctx);
  return { registrations, panels, commands };
}

function flatten(node) {
  if (node == null) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (typeof node === 'object') return (node.children ?? []).flatMap(flatten);
  return [];
}

function createHookHarness() {
  const refs = [];
  let hookIndex = 0;
  let effects = [];
  return {
    react: {
      useRef(initial) {
        const index = hookIndex;
        hookIndex += 1;
        if (!(index in refs)) refs[index] = { current: initial };
        return refs[index];
      },
      useEffect(effect) {
        effects.push(effect);
      },
      useState(initial) {
        return [initial, () => {}];
      },
    },
    begin() {
      hookIndex = 0;
      effects = [];
    },
    run() {
      for (const effect of [...effects]) effect();
    },
  };
}

test('client registers the turn-tail reminder, main page, and sidebar entry', async () => {
  const { module } = await loadClient();
  assert.equal(module.inject.join(','), 'slots,layout,locale,configForms,commandUi');
  const { registrations, commands, panels } = applyClient(module);
  assert.equal(registrations.length, 5);

  const reminder = registrations.find((entry) => entry.options.id === 'failure-ledger.reminder');
  const panel = registrations.find((entry) => entry.options.name === 'main');
  const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  const bridge = registrations.find((entry) => entry.options.id === 'failure-ledger.bridge');

  assert.ok(reminder);
  assert.equal(reminder.options.name, 'conversation.chat.turnTail');
  assert.equal(reminder.options.order, 40);
  assert.equal(typeof reminder.component, 'function');

  assert.ok(panel);
  assert.equal(panel.options.key, 'failure-ledger');
  assert.equal(typeof panel.component, 'function');

  assert.ok(sidebar);
  assert.equal(sidebar.options.id, 'failure-ledger');
  assert.equal(sidebar.options.order, 20);
  assert.equal(typeof sidebar.options.label, 'function');
  assert.equal(typeof sidebar.component, 'function');

  assert.ok(bridge);
  assert.equal(bridge.options.name, 'conversation.composer.dock');
  assert.equal(bridge.options.order, 999);
  assert.equal(typeof bridge.component, 'function');

  const stats = registrations.find((entry) => entry.options.id === 'failure-ledger.stats');
  assert.ok(stats);
  assert.equal(stats.options.name, 'conversation.composer.dock');
  assert.equal(stats.options.order, -1000000);
  assert.equal(typeof stats.component, 'function');

  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.equal(command.name, 'dfl-ui');
  assert.equal(command.label(), 'DFL-UI');
  assert.equal(command.description(), '打开对话异常统计面板');
  assert.equal(typeof command.icon, 'function');
  assert.equal(command.ui.kind, 'action');
  command.ui.run();
  assert.deepEqual(panels, ['failure-ledger']);
});

test('the turn reminder renders this turn counts and opens the panel', async () => {
  const { module } = await loadClient();
  const { registrations, panels } = applyClient(module);
  const component = registrations.find((entry) => entry.options.id === 'failure-ledger.reminder').component;

  const tree = component({
    useProjection(key) {
      assert.equal(key, 'failureLedger');
      return { turnN1: 3, turnSavedTokens: 1800, n1: 12, n2: 4 };
    },
  });

  assert.equal(tree.type, 'button');
  const text = flatten(tree).join(' ');
  assert.match(text, /本回合/);
  assert.match(text, /失败 3 次/);
  assert.match(text, /1\.8k/);
  assert.doesNotMatch(text, /本对话/);
  assert.match(text, /打开对话异常统计/);
  assert.match(tree.props['aria-label'], /失败 3 次/);
  assert.match(JSON.stringify(tree.props.style), /--dsw-alias-label-secondary/);

  tree.props.onClick({ preventDefault() {} });
  assert.deepEqual(panels, ['failure-ledger']);
  tree.props.onClick();
  assert.deepEqual(panels, ['failure-ledger', 'failure-ledger']);

  const wrapped = component({ useProjection: () => ({ value: { turnN1: 1, turnSavedTokens: 0 } }) });
  assert.match(flatten(wrapped).join(' '), /失败 1 次/);
});

test('the turn reminder ignores cumulative-only data', async () => {
  const { module } = await loadClient();
  const { registrations } = applyClient(module);
  const component = registrations.find((entry) => entry.options.id === 'failure-ledger.reminder').component;

  assert.equal(component({ useProjection: () => ({ turnN1: 0, turnSavedTokens: 0, n1: 9, n2: 3, savedTokens: 100 }) }), null);
  assert.equal(component({ useProjection: () => null }), null);
  assert.equal(component({}), null);
  assert.equal(component({ useProjection: () => { throw new Error('projection unavailable'); } }), null);
});

test('the reminder follows the active locale', async () => {
  const { module } = await loadClient();
  const { registrations } = applyClient(module, { locale: 'en-US' });
  const component = registrations.find((entry) => entry.options.id === 'failure-ledger.reminder').component;
  const tree = component({
    useProjection: () => ({ turnN1: 3, turnSavedTokens: 1800 }),
  });
  const text = flatten(tree).join(' ');
  assert.match(text, /This turn/);
  assert.match(text, /3 failed/);
  assert.match(text, /Open Conversation Anomaly Stats/);
});

test('the composer stats show cumulative session data', async () => {
  const { module } = await loadClient();
  const { registrations } = applyClient(module);
  const component = registrations.find((entry) => entry.options.id === 'failure-ledger.stats').component;
  const tree = component({
    useProjection: () => ({ n1: 5, n2: 2, savedTokens: 900 }),
  });
  const text = flatten(tree).join(' ');
  assert.match(text, /失败 5/);
  assert.match(text, /异常 2/);
  assert.match(text, /900/);
  assert.doesNotMatch(text, /本对话/);
  assert.doesNotMatch(JSON.stringify(tree.props.style), /marginLeft/);
  assert.equal(component({ useProjection: () => ({ n1: 0, n2: 0, savedTokens: 0 }) }), null);
});

test('the panel bridge opens on a new panel request only', async () => {
  const hooks = createHookHarness();
  const { module } = await loadClient(hooks.react);
  const { registrations, panels } = applyClient(module);
  const bridge = registrations.find((entry) => entry.options.id === 'failure-ledger.bridge').component;

  hooks.begin();
  bridge({
    useProjection: () => ({ panelOpenSeq: 0 }),
  });
  hooks.run();
  assert.deepEqual(panels, []);

  hooks.begin();
  bridge({
    useProjection: () => ({ panelOpenSeq: 1 }),
  });
  hooks.run();
  assert.deepEqual(panels, ['failure-ledger']);

  hooks.begin();
  bridge({
    useProjection: () => ({ panelOpenSeq: 1 }),
  });
  hooks.run();
  assert.deepEqual(panels, ['failure-ledger']);
});

test('the panel includes context attribution and its rule controls', async () => {
  const { source } = await loadClient();
  assert.match(source, /上下文归因/);
  assert.match(source, /contextJump/);
  assert.match(source, /minDeltaTokens/);
  assert.match(source, /contextTopSources/);
  assert.match(source, /toFixed\(2\)/);
  assert.match(source, /appearedGuards/);
  assert.match(source, /collapsedGuards/);
  assert.match(source, /order: 1/);
});

test('the client half contains no timers or polling', async () => {
  const { source } = await loadClient();
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame/);
});
