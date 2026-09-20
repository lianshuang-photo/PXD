/* Shared HTML button behavior. UXP's native <button> paints its own label and
 * intrinsic size; these HTML surfaces retain our typography in both hosts. */
(function () {
  "use strict";

  function isDisabled(button) {
    return button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true";
  }

  function setDisabled(button, disabled) {
    if (!button) return;
    if (disabled) button.setAttribute("disabled", "");
    else button.removeAttribute("disabled");
    button.setAttribute("aria-disabled", disabled ? "true" : "false");
    button.setAttribute("tabindex", disabled ? "-1" : "0");
    if (disabled) button.classList.remove("is-pressed");
  }

  function enhanceButton(button) {
    button.classList.add("ui-button");
    button.setAttribute("role", "button");
    setDisabled(button, isDisabled(button));
    var spacePressed = false;
    function activate() {
      if (isDisabled(button)) return;
      button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
    }
    button.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      if (isDisabled(button) || event.repeat) return;
      if (event.key === "Enter") activate();
      else {
        spacePressed = true;
        button.classList.add("is-pressed");
      }
    });
    button.addEventListener("keyup", function (event) {
      if (event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      if (spacePressed) activate();
      spacePressed = false;
      button.classList.remove("is-pressed");
    });
    button.addEventListener("blur", function () {
      spacePressed = false;
      button.classList.remove("is-pressed");
    });
    return button;
  }

  function createButton(className, text, onClick) {
    var button = document.createElement("div");
    button.className = className;
    button.textContent = text;
    enhanceButton(button);
    if (onClick) button.addEventListener("click", function (event) {
      if (!isDisabled(button)) onClick(event);
    });
    return button;
  }

  function syncRadios() {
    document.querySelectorAll(".radio-option").forEach(function (option) {
      var input = option.querySelector("input[type=radio]");
      option.classList.toggle("on", input.checked);
      option.setAttribute("aria-checked", input.checked ? "true" : "false");
      option.setAttribute("tabindex", input.checked ? "0" : "-1");
    });
  }

  document.querySelectorAll(".radio-option").forEach(function (option) {
    var input = option.querySelector("input[type=radio]");
    option.setAttribute("role", "radio");
    input.setAttribute("tabindex", "-1");
    function group() {
      return Array.from(document.querySelectorAll(".radio-option")).filter(function (other) {
        return other.querySelector("input[type=radio]").name === input.name;
      });
    }
    function select() {
      option.focus();
      if (input.checked) return;
      group().forEach(function (other) {
        other.querySelector("input[type=radio]").checked = other === option;
      });
      syncRadios();
      // UXP's native input dispatcher requires private event data for "change".
      // Notify on the HTML option instead of synthesizing a native input event.
      option.dispatchEvent(new Event("pxd-radio-change", { bubbles: true }));
    }
    option.addEventListener("click", select);
    input.addEventListener("change", syncRadios);
    option.addEventListener("keydown", function (event) {
      var options = group(), index = options.indexOf(option), target = option;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") target = options[(index + 1) % options.length];
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = options[(index + options.length - 1) % options.length];
      else if (event.key === "Home") target = options[0];
      else if (event.key === "End") target = options[options.length - 1];
      else if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
      event.preventDefault();
      if (event.repeat) return;
      target.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
      target.focus();
    });
  });
  syncRadios();

  window.PXD_UI = { isDisabled: isDisabled, setDisabled: setDisabled, createButton: createButton, syncRadios: syncRadios };
  document.querySelectorAll(".ui-button").forEach(enhanceButton);
})();
