(() => {
  "use strict";

  const CFG = {
    btnId: "edit-toggle",
    bodyClass: "editor-mode",
    sessionKey: "editModeRequested",
    editableSelectors: ["[data-editable]", ".js-editable"],
    btnTextOn: "Выключить редактирование",
    btnTextOff: "Редактировать",
  };

  const truthy = (v) => {
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === "" || s === "1" || s === "true" || s === "on" || s === "yes";
  };

  function hasEditInUrl() {
    const sp = new URLSearchParams(location.search);
    if (sp.has("edit") && truthy(sp.get("edit"))) return true;
    const h = location.hash || "";
    const qi = h.indexOf("?");
    if (qi !== -1) {
      const hp = new URLSearchParams(h.slice(qi + 1));
      if (hp.has("edit") && truthy(hp.get("edit"))) return true;
    }
    return false;
  }

  function getEditRequested() {
    return sessionStorage.getItem(CFG.sessionKey) === "1" || hasEditInUrl();
  }

  function persistRequested(flag) {
    if (flag) sessionStorage.setItem(CFG.sessionKey, "1");
    else sessionStorage.removeItem(CFG.sessionKey);
  }

  function ensureStyles() {
    if (document.getElementById("editor-inline-styles")) return;
    const s = document.createElement("style");
    s.id = "editor-inline-styles";
    s.textContent = `
      .${CFG.bodyClass} [contenteditable="true"] { outline: 2px dashed rgba(0,0,0,.28); outline-offset: 2px; }
      #${CFG.btnId} {
        position: fixed; z-index: 2147480000; top: 12px; right: 12px;
        padding: 10px 14px; border: 1px solid rgba(0,0,0,.2); border-radius: 10px;
        background: #fff; font: 14px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, Arial;
        cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.07);
      }
      #${CFG.btnId}:hover { box-shadow: 0 4px 18px rgba(0,0,0,.12); }
    `;
    document.head.appendChild(s);
  }

  function ensureButton() {
    let btn = document.getElementById(CFG.btnId);
    if (btn) return btn;
    btn = document.createElement("button");
    btn.id = CFG.btnId;
    btn.type = "button";
    btn.setAttribute("aria-label", "Переключить режим редактирования");
    btn.style.display = "none";
    btn.addEventListener("click", toggleEditor, false);
    document.body.appendChild(btn);
    return btn;
  }

  function setButtonVisible(v) {
    const btn = ensureButton();
    btn.style.display = v ? "inline-flex" : "none";
    btn.setAttribute("aria-hidden", v ? "false" : "true");
    btn.textContent = isActive() ? CFG.btnTextOn : CFG.btnTextOff;
  }

  function isActive() {
    return document.body.classList.contains(CFG.bodyClass);
  }

  function enableEditor() {
    document.body.classList.add(CFG.bodyClass);
    CFG.editableSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.setAttribute("contenteditable", "true"));
    });
  }

  function disableEditor() {
    document.body.classList.remove(CFG.bodyClass);
    CFG.editableSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.removeAttribute("contenteditable"));
    });
  }

  function toggleEditor() {
    if (isActive()) {
      disableEditor();
      persistRequested(true);
    } else {
      enableEditor();
      persistRequested(true);
    }
    setButtonVisible(true);
  }

  function updateUI() {
    const want = getEditRequested();
    if (want) {
      persistRequested(true);
      enableEditor();
      setButtonVisible(true);
    } else {
      disableEditor();
      setButtonVisible(false);
    }
  }

  function initObserver() {
    const obs = new MutationObserver(() => {
      if (!document.getElementById(CFG.btnId)) {
        ensureButton();
        updateUI();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    ensureStyles();
    ensureButton();
    updateUI();
    addEventListener("hashchange", updateUI);
    addEventListener("popstate", updateUI);
    addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "e" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleEditor();
      }
      if (e.key === "Escape" && isActive()) {
        e.preventDefault();
        disableEditor();
        setButtonVisible(true);
      }
    });
    initObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
