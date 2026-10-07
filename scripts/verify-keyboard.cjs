/* The installed native RN keyboard component, driven without an Android device.
 * This checks its rendered layout contract, not IME animation or Pixel rendering.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const babel = require('@babel/core');

const root = path.resolve(__dirname, '..');
const nativeFile = path.join(root, 'node_modules/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js');
const nativeCode = babel.transformFileSync(nativeFile, {
  configFile: false,
  babelrc: false,
  presets: [['module:@react-native/babel-preset', { disableImportExportTransform: false }]],
}).code;
const nativeRequire = createRequire(nativeFile);
const settle = () => new Promise(resolve => setImmediate(resolve));
const flatten = style => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : style || {};

// Read the actual call-site expressions instead of duplicating their platform
// switch or offset in the test. A regression in the app changes this result.
function configuration(relativePath, platform, viewportTop, bottomInset) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const ast = babel.parseSync(source, {
    configFile: false, babelrc: false,
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
  });
  const views = [];
  babel.traverse(ast, {
    JSXOpeningElement(node) {
      if (node.node.name.type === 'JSXIdentifier' && node.node.name.name === 'KeyboardAvoidingView') views.push(node.node);
    },
  });
  assert.equal(views.length, 1, `${relativePath} has one keyboard layout owner`);
  const props = { style: { flex: 1 } };
  for (const name of ['behavior', 'keyboardVerticalOffset', 'enabled']) {
    const attribute = views[0].attributes.find(item => item.type === 'JSXAttribute' && item.name.name === name);
    if (!attribute) continue;
    if (attribute.value?.type === 'StringLiteral') props[name] = attribute.value.value;
    else if (attribute.value?.type === 'JSXExpressionContainer') {
      const expression = babel.transformFromAstSync(babel.types.file(babel.types.program([
        babel.types.returnStatement(attribute.value.expression),
      ])), null, { configFile: false, babelrc: false }).code;
      props[name] = new Function('Platform', 'viewportTop', 'insets', expression)(
        { OS: platform }, viewportTop, { bottom: bottomInset },
      );
    } else props[name] = true;
  }
  return props;
}

function mount(platform, props) {
  const listeners = new Map();
  const keyboard = {
    isVisible: () => false,
    addListener(name, callback) {
      listeners.set(name, callback);
      return { remove: () => listeners.delete(name) };
    },
  };
  const boundary = {
    '../../LayoutAnimation/LayoutAnimation': { configureNext() {}, Types: { keyboard: 'keyboard' } },
    '../../StyleSheet/StyleSheet': { compose: (first, second) => [first, second] },
    '../../Utilities/Platform': { OS: platform },
    '../AccessibilityInfo/AccessibilityInfo': { prefersCrossFadeTransitions: async () => false },
    '../View/View': 'NativeView',
    './Keyboard': keyboard,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', nativeCode)(
    name => Object.hasOwn(boundary, name) ? boundary[name] : nativeRequire(name), module, module.exports,
  );
  const view = new module.exports.default(props);
  // State updates normally supplied by the native renderer. Keep all RN event,
  // overlap, height, padding and render logic intact.
  view.updater = {
    enqueueSetState(instance, update) {
      const next = typeof update === 'function' ? update(instance.state, instance.props) : update;
      instance.state = { ...instance.state, ...next };
    },
  };
  view.componentDidMount();
  return {
    view,
    async layout(height) {
      await view.render().props.onLayout({ persist() {}, nativeEvent: { layout: { x: 0, y: 0, width: 412, height } } });
      await settle();
    },
    async emit(visible, screenY) {
      const event = platform === 'ios' ? (visible ? 'keyboardWillShow' : 'keyboardWillHide') : (visible ? 'keyboardDidShow' : 'keyboardDidHide');
      assert.ok(listeners.has(event), `subscribed to ${event}`);
      listeners.get(event)({ duration: 250, easing: 'keyboard', endCoordinates: { screenX: 0, screenY, width: 412, height: 320 } });
      await settle();
    },
    bottom(parentTop, availableHeight, footerPadding) {
      const render = view.render();
      const style = flatten(render.props.style);
      const displacement = props.behavior === 'position' ? flatten(render.props.children.props.style).bottom || 0 : 0;
      return parentTop + (style.height ?? availableHeight) - (style.paddingBottom || 0) - displacement - footerPadding;
    },
    unmount() { view.componentWillUnmount(); assert.equal(listeners.size, 0); },
  };
}

const threadPath = 'src/chat/registry/components/assistant-ui/elements/thread.aui.tsx';

async function verifyThread({ platform, label, screenHeight, viewportTop, bottomInset, keyboardTop, resized = false }) {
  const fullHeight = screenHeight - viewportTop;
  const footerPadding = bottomInset + 8;
  const props = configuration(threadPath, platform, viewportTop, bottomInset);
  const mounted = mount(platform, props);
  try {
    await mounted.layout(fullHeight);
    const originalBottom = mounted.bottom(viewportTop, fullHeight, footerPadding);
    assert.equal(originalBottom, screenHeight - footerPadding);
    const available = resized ? keyboardTop - viewportTop : fullHeight;
    if (resized) await mounted.layout(available);
    await mounted.emit(true, keyboardTop);
    const composerBottom = mounted.bottom(viewportTop, available, footerPadding);
    assert.ok(composerBottom <= keyboardTop,
      `${label}: composer bottom ${composerBottom}px is hidden below keyboard top ${keyboardTop}px`);
    assert.ok(composerBottom >= keyboardTop - footerPadding - 1,
      `${label}: keyboard space was counted twice (${keyboardTop - composerBottom}px gap)`);
    // Feed the resulting layout back, as Android does after a height update.
    const renderedHeight = flatten(mounted.view.render().props.style).height ?? available;
    await mounted.layout(renderedHeight);
    assert.equal(mounted.bottom(viewportTop, available, footerPadding), composerBottom, `${label}: layout settles without drifting`);
    if (!resized) {
      // Android re-emits keyboardDidShow when an emoji panel changes IME height.
      const tallerKeyboardTop = keyboardTop - 40;
      await mounted.emit(true, tallerKeyboardTop);
      assert.ok(mounted.bottom(viewportTop, available, footerPadding) <= tallerKeyboardTop,
        `${label}: a taller keyboard panel must not cover the composer`);
    }
    await mounted.emit(false, screenHeight);
    if (resized) await mounted.layout(fullHeight);
    assert.equal(mounted.bottom(viewportTop, fullHeight, footerPadding), originalBottom, `${label}: dismiss restores the composer`);
    console.log(`PASS ${label}: composer above keyboard, no double inset, dismiss restores layout`);
  } finally { mounted.unmount(); }
}

async function verifySheet() {
  const props = configuration('App.tsx', 'android', 0, 24);
  const mounted = mount('android', props);
  try {
    await mounted.layout(892);
    await mounted.emit(true, 560);
    const sheetContentBottom = mounted.bottom(0, 892, 36);
    assert.ok(sheetContentBottom <= 560,
      `Android sheet: form bottom ${sheetContentBottom}px is hidden below keyboard top 560px`);
    await mounted.emit(false, 892);
    assert.equal(mounted.bottom(0, 892, 36), 856);
    console.log('PASS Android input sheet: form stays above keyboard and dismiss restores layout');
  } finally { mounted.unmount(); }
}

(async () => {
  await verifyThread({ platform: 'android', label: 'Android edge-to-edge portrait', screenHeight: 892, viewportTop: 92, bottomInset: 24, keyboardTop: 560 });
  await verifyThread({ platform: 'android', label: 'Android edge-to-edge landscape', screenHeight: 412, viewportTop: 64, bottomInset: 0, keyboardTop: 236 });
  await verifyThread({ platform: 'android', label: 'Android resized window', screenHeight: 892, viewportTop: 92, bottomInset: 24, keyboardTop: 560, resized: true });
  await verifyThread({ platform: 'ios', label: 'iOS header and home indicator', screenHeight: 852, viewportTop: 123, bottomInset: 34, keyboardTop: 510 });
  await verifySheet();
})().catch(error => { console.error(error.message); process.exitCode = 1; });
