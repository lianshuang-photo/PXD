(function (root) {
  "use strict";
  function attach(options) {
    var field = options.field, frame = options.frame, document = options.document;
    var composing = false, paste = false, lastValue = field.value, shift = false, disposed = false;
    var listeners = [], compositionEnded = 0, focused = false;
    function on(node, type, fn, capture) { node.addEventListener(type, fn, !!capture); listeners.push(function () { node.removeEventListener(type, fn, !!capture); }); }
    function report(type) { if (options.onEvent) options.onEvent(type); }
    function focus(on) { frame.classList.toggle("is-focused", on); if (focused !== on) { focused = on; report(on ? "focus" : "blur"); } }
    function keydown(e) {
      if (e.target !== field && document.activeElement !== field) return;
      shift = !!e.shiftKey;
      if (e.defaultPrevented || !options.enterSends() || composing || e.isComposing || e.keyCode === 229 || Date.now() - compositionEnded < 80) return;
      if ((e.key === "Enter" || e.keyCode === 13 || e.keyIdentifier === "Enter") && !shift) {
        e.preventDefault(); if (!e.repeat) { report("enter-keydown"); options.send(); }
      }
    }
    on(field, "focus", function () { focus(true); });
    on(field, "blur", function () { focus(false); shift = false; });
    on(field, "compositionstart", function () { composing = true; });
    on(field, "compositionend", function () { composing = false; compositionEnded = Date.now(); lastValue = field.value; });
    on(field, "paste", function () { paste = true; setTimeout(function () { paste = false; lastValue = field.value; }, 100); });
    on(field, "keydown", keydown);
    if (document.addEventListener) {
      on(document, "keydown", keydown, true);
      on(document, "keyup", function (e) { shift = !!e.shiftKey; }, true);
    }
    on(field, "input", function (e) {
      var value = field.value;
      // UXP's native editor may consume keydown. Only a single newly inserted
      // newline can submit; multiline paste/replacement and IME input stay intact.
      if (options.native && options.enterSends() && !paste && !shift && !composing && !e.isComposing && Date.now() - compositionEnded >= 80 &&
          (!e.inputType || e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") && value.length === lastValue.length + 1) {
        var i = 0; while (i < lastValue.length && value[i] === lastValue[i]) i++;
        if (value[i] === "\n" && value.slice(i + 1) === lastValue.slice(i)) {
          field.value = lastValue; options.saveDraft(); report("enter-native-input"); options.send();
        }
      }
      lastValue = field.value; options.saveDraft();
    });
    var timer = setInterval(function () {
      if (disposed) return;
      focus(document.activeElement === field);
      // Keep programmatic draft clears/restores in sync with the native fallback.
      lastValue = field.value;
    }, 150);
    return { sync: function () { lastValue = field.value; },
      newline: function () {
        var start = typeof field.selectionStart === "number" ? field.selectionStart : field.value.length;
        var end = typeof field.selectionEnd === "number" ? field.selectionEnd : start;
        field.value = field.value.slice(0, start) + "\n" + field.value.slice(end);
        lastValue = field.value; options.saveDraft(); field.focus();
        try { field.setSelectionRange(start + 1, start + 1); } catch (_) {}
      },
      close: function () { disposed = true; clearInterval(timer); listeners.forEach(function (off) { off(); }); } };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { attach: attach };
  if (root) root.PXD_COMPOSER = { attach: attach };
})(typeof window === "undefined" ? null : window);
