/* Small, text-only Markdown renderer for Chromium and UXP. No innerHTML. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.PXD_MARKDOWN = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  function safeLink(url) { return /^(https?:\/\/|\/[^/])/.test(String(url || "")) ? url : null; }
  function inline(text, depth) {
    depth = depth || 0;
    if (depth > 4) return [{ type: "text", text: text }];
    var result = [], re = /\\([\\`*_[\]{}()#+.!>~-])|`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|~~([^\n]+?)~~|!?\[([^\]\n]+)\]\(([^\s)]+)\)/g;
    var pos = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > pos) result.push({ type: "text", text: text.slice(pos, m.index) });
      if (m[1]) result.push({ type: "text", text: m[1] });
      else if (m[2]) result.push({ type: "code", text: m[2] });
      else if (m[3] || m[4]) result.push({ type: "strong", children: inline(m[3] || m[4], depth + 1) });
      else if (m[5]) result.push({ type: "em", children: inline(m[5], depth + 1) });
      else if (m[6]) result.push({ type: "strike", children: inline(m[6], depth + 1) });
      else result.push({ type: safeLink(m[8]) ? "link" : "text", text: m[7], href: safeLink(m[8]) });
      pos = re.lastIndex;
    }
    if (pos < text.length) result.push({ type: "text", text: text.slice(pos) });
    return result;
  }
  function cells(line) {
    var text = line.trim().replace(/^\|/, "").replace(/\|$/, ""), result = [], cell = "";
    for (var i = 0; i < text.length; i++) {
      if (text[i] === "\\" && text[i + 1] === "|") { cell += "|"; i++; }
      else if (text[i] === "|") { result.push(cell.trim()); cell = ""; }
      else cell += text[i];
    }
    result.push(cell.trim()); return result;
  }
  function parse(text) {
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n"), blocks = [], i = 0;
    function special(n) { return /^\s*(?:#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|(?:---+|\*\*\*+)\s*$)/.test(lines[n] || ""); }
    while (i < lines.length) {
      var line = lines[i], m;
      if (!line.trim()) { i++; continue; }
      if ((m = /^\s*(```+|~~~+)\s*([^\s]*)/.exec(line))) {
        var fence = m[1], code = []; i++;
        while (i < lines.length && lines[i].trim().indexOf(fence) !== 0) code.push(lines[i++]);
        if (i < lines.length) i++;
        blocks.push({ type: "codeblock", language: m[2], text: code.join("\n") }); continue;
      }
      if ((m = /^(#{1,6})\s+(.+)$/.exec(line))) { blocks.push({ type: "heading", level: m[1].length, text: m[2].replace(/\s+#+$/, "") }); i++; continue; }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ type: "rule" }); i++; continue; }
      if (i + 1 < lines.length && line.indexOf("|") >= 0 && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        var rows = [], header = cells(line); i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) rows.push(cells(lines[i++]));
        blocks.push({ type: "table", header: header, rows: rows }); continue;
      }
      if (/^\s*>/.test(line)) {
        var quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
        blocks.push({ type: "quote", text: quote.join("\n") }); continue;
      }
      if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line))) {
        var content = m[3], marker = /^\d/.test(m[2]) ? m[2].replace(")", ".") : "•";
        if (/^\[[ xX]\]\s/.test(content)) { marker = /^\[[xX]\]/.test(content) ? "☑" : "☐"; content = content.slice(4); }
        i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !special(i)) content += "\n" + lines[i++].trim();
        blocks.push({ type: "list", marker: marker, depth: Math.min(3, Math.floor(m[1].length / 2)), text: content }); continue;
      }
      var paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !special(i)) {
        if (i + 1 < lines.length && lines[i].indexOf("|") >= 0 && /---/.test(lines[i + 1])) break;
        paragraph.push(lines[i++]);
      }
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    }
    return blocks;
  }
  function render(target, text, options) {
    options = options || {};
    var doc = target.ownerDocument || document;
    while (target.firstChild) target.removeChild(target.firstChild);
    function el(tag, cls, value) { var node = doc.createElement(tag); node.className = cls; if (value != null) node.textContent = value; return node; }
    function appendInline(parent, tokens) {
      tokens.forEach(function (token) {
        var node = el("span", "md-" + token.type);
        if (token.children) appendInline(node, token.children); else node.textContent = token.text;
        if (token.type === "link") {
          node.setAttribute("role", "link"); node.setAttribute("tabindex", "0"); node.title = token.href;
          function open() { if (options.openLink) options.openLink(token.href); }
          node.addEventListener("click", open);
          node.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); open(); } });
        }
        parent.appendChild(node);
      });
    }
    parse(text).forEach(function (block) {
      var node = el("div", "md-block md-" + block.type);
      if (block.type === "codeblock") {
        var label = el("div", "md-code-label", block.language || "代码"); node.appendChild(label);
        node.appendChild(el("pre", "md-code-content", block.text));
        if (options.codeButton) label.appendChild(options.codeButton(block.text));
      } else if (block.type === "table") {
        var table = el("div", "md-table-body");
        [block.header].concat(block.rows).forEach(function (row, idx) {
          var tr = el("div", "md-table-row" + (idx === 0 ? " md-table-head" : ""));
          block.header.forEach(function (_, col) { var td = el("div", "md-cell"); appendInline(td, inline(row[col] || "")); tr.appendChild(td); });
          table.appendChild(tr);
        }); node.appendChild(table);
      } else if (block.type === "list") {
        node.style.marginLeft = (block.depth * 12) + "px";
        node.appendChild(el("span", "md-list-marker", block.marker));
        var body = el("div", "md-list-body"); appendInline(body, inline(block.text)); node.appendChild(body);
      } else if (block.type !== "rule") {
        if (block.type === "heading") node.classList.add("md-h" + Math.min(3, block.level));
        appendInline(node, inline(block.text));
      }
      target.appendChild(node);
    });
  }
  return { parse: parse, inline: inline, safeLink: safeLink, render: render };
});
