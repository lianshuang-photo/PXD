const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Real EventTarget dispatch exercises event ordering and cancelation; the
// attribute bag supplies only the DOM surface the portable button code needs.
class Element extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
}

function fixture() {
  const window = {};
  const document = { createElement: () => new Element(), querySelectorAll: () => [] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/ui-014.js'), 'utf8'), { window, document, Event });
  let calls = 0;
  const button = window.PXD_UI.createButton('test-action', 'Action', () => { calls++; });
  function key(type, key, repeat = false) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { key, repeat });
    button.dispatchEvent(event);
    return event;
  }
  return { ui: window.PXD_UI, button, key, calls: () => calls };
}

test('Enter activates once; a held Enter does not repeat the action', () => {
  const f = fixture();
  assert.equal(f.key('keydown', 'Enter').defaultPrevented, true);
  f.key('keydown', 'Enter', true);
  f.key('keyup', 'Enter');
  assert.equal(f.calls(), 1);
});

test('Space activates on release, and losing focus cancels a pending press', () => {
  const f = fixture();
  assert.equal(f.key('keydown', ' ').defaultPrevented, true);
  assert.equal(f.calls(), 0);
  assert.equal(f.button.classList.contains('is-pressed'), true);
  f.key('keyup', ' ');
  assert.equal(f.calls(), 1);
  assert.equal(f.button.classList.contains('is-pressed'), false);
  f.key('keydown', ' ');
  f.button.dispatchEvent(new Event('blur'));
  f.key('keyup', ' ');
  assert.equal(f.calls(), 1);
});

test('Disabled actions reject both pointer and keyboard activation, then recover', () => {
  const f = fixture();
  f.ui.setDisabled(f.button, true);
  assert.equal(f.button.classList.contains('is-pressed'), false);
  f.button.dispatchEvent(new Event('click'));
  f.key('keydown', 'Enter');
  f.key('keydown', ' ');
  f.key('keyup', ' ');
  assert.equal(f.calls(), 0);
  assert.equal(f.button.getAttribute('aria-disabled'), 'true');
  assert.equal(f.button.getAttribute('tabindex'), '-1');
  f.ui.setDisabled(f.button, false);
  f.button.dispatchEvent(new Event('click'));
  f.key('keydown', 'Enter');
  assert.equal(f.calls(), 2);
  assert.equal(f.button.getAttribute('role'), 'button');
  assert.equal(f.button.getAttribute('tabindex'), '0');
});

test('Disabling between Space down and up prevents an action', () => {
  const f = fixture();
  f.key('keydown', ' ');
  f.ui.setDisabled(f.button, true);
  f.key('keyup', ' ');
  assert.equal(f.calls(), 0);
});
