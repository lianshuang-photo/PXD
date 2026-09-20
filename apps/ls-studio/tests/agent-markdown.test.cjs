const test = require('node:test');
const assert = require('node:assert/strict');
const md = require('../plugin/agent-markdown-014');

class Node extends EventTarget {
  constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = {}; this.style = {}; this.className = ''; this.classList = { add: name => { this.className += ' ' + name; } }; }
  set innerHTML(_) { throw new Error('Unsafe HTML insertion'); }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(c => c.textContent).join(''); }
  get firstChild() { return this.children[0]; }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
}
function root() { const doc = { createElement: tag => new Node(tag, doc) }; return doc.createElement('div'); }
function all(node) { return [node, ...node.children.flatMap(all)]; }

test('untrusted HTML and unsafe links remain inert text', () => {
  const target = root(), opened = [];
  md.render(target, '<img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [data](data:text/html,hi) [good](https://example.com)', { openLink: url => opened.push(url) });
  assert.match(target.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(all(target).filter(n => n.tagName === 'img' || n.tagName === 'script').length, 0);
  const links = all(target).filter(n => n.attributes.role === 'link');
  assert.equal(links.length, 1);
  links[0].dispatchEvent(new Event('click'));
  assert.deepEqual(opened, ['https://example.com']);
  assert.equal(md.safeLink('//remote.example'), null);
});

test('streaming a partial fence becomes a complete code block without losing code or executing it', () => {
  const target = root(), copied = [];
  const codeButton = text => { const b = target.ownerDocument.createElement('div'); b.addEventListener('click', () => copied.push(text)); return b; };
  md.render(target, '说明\n\n```javascript\nconst x = 1;', { codeButton });
  assert.equal(all(target).filter(n => n.tagName === 'pre').length, 1);
  md.render(target, '说明\n\n```javascript\nconst x = 1;\nconsole.log(x);\n```\n\n完成', { codeButton });
  const pre = all(target).find(n => n.tagName === 'pre');
  assert.equal(pre.textContent, 'const x = 1;\nconsole.log(x);');
  const label = all(target).find(n => n.className === 'md-code-label');
  label.children[0].dispatchEvent(new Event('click'));
  assert.deepEqual(copied, [pre.textContent]);
  assert.equal(target.children.at(-1).textContent, '完成');
});

test('table escapes and missing cells preserve column alignment', () => {
  const target = root();
  md.render(target, '| 目标 | 状态 |\n| --- | --- |\n| A \\| B | **完成** |\n| C |');
  const rows = all(target).filter(n => n.className.includes('md-table-row'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every(n => n.children.length === 2));
  assert.equal(rows[1].children[0].textContent, 'A | B');
  assert.equal(rows[2].children[1].textContent, '');
});

test('headings, task lists, quotes and inline emphasis render as structured content', () => {
  const target = root();
  md.render(target, '## 处理步骤\n\n1. **读取**文档\n  - [x] 确认选区\n  - [ ] 执行\n\n> 保留*肤质*，检查 `mask`。');
  assert.ok(all(target).some(n => n.className.includes('md-h2')));
  assert.deepEqual(all(target).filter(n => n.className === 'md-list-marker').map(n => n.textContent), ['1.', '☑', '☐']);
  assert.ok(all(target).some(n => n.className === 'md-em' && n.textContent === '肤质'));
});
