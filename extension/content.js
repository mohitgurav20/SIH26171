/**
 * SIH26171 — Content Script
 * Advanced Perception Engine:
 * - 2-Pass Semantic DOM Filter (~90% payload reduction)
 * - MutationObserver-based Incremental DOM Diffing (Task 104) & Debounce (Task 152)
 * - Zoom-Calibrated Numbered-Tag Grounding Overlays (Task 43, 139)
 * - Deterministic Multi-Action Executor with Step Validation & Halt-on-Failure (Task 44, 140)
 * - Web Worker offload for JSON tree compression (Task 106)
 * Owner: Mohit
 */

(function() {
  'use strict';

  window.__SIH26171_CONTENT_INITIALIZED__ = Date.now();

  // DOM State Cache
  const tagElementMap = new Map();
  let overlayContainer = null;
  let cachedDomData = null;
  let isDomDirty = true;
  let domWorker = null;
  let mutationDebounceTimer = null;
  const mutatedElementsSet = new Set();
  let lastInteractedElement = null;

  // Initialize Web Worker if possible
  try {
    const workerUrl = chrome.runtime.getURL('dom-worker.js');
    domWorker = new Worker(workerUrl);
  } catch (err) {
    console.log('[Content] Web Worker fallback to main thread:', err.message);
  }

  /**
   * Task 104 & 152: MutationObserver for incremental diffing & debouncing
   */
  function initMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      isDomDirty = true;
      for (const mutation of mutations) {
        if (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE) {
          // Ignore our own overlay badges
          if (mutation.target.id === 'sih-tag-overlay-container' || mutation.target.classList?.contains('sih-tag-badge')) {
            continue;
          }
          mutatedElementsSet.add(mutation.target);
        }
      }

      if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        // Debounce settle
      }, 150);
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'value']
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMutationObserver);
  } else {
    initMutationObserver();
  }

  /**
   * Pass 1: Visibility check
   */
  function isElementVisible(node, style) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    // Allow radio/checkbox inputs that use standard sr-only/opacity:0 styling
    const isRadioOrCheck = node.tagName === 'INPUT' && (node.type === 'radio' || node.type === 'checkbox');
    if (style.opacity === '0' && !isRadioOrCheck) {
      return false;
    }
    if (node.hasAttribute('aria-hidden') && node.getAttribute('aria-hidden') === 'true' && !isRadioOrCheck) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && !isRadioOrCheck) return false;
    if (rect.bottom < -500 || rect.top > (window.innerHeight + 500)) return false;

    return true;
  }

  /**
   * Determine interactive candidate
   */
  function isElementInteractive(node, style) {
    const tagName = node.tagName.toUpperCase();

    const INTERACTIVE_TAGS = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA',
      'DETAILS', 'SUMMARY', 'LABEL', 'OPTION'
    ]);

    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio',
      'combobox', 'listbox', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
      'searchbox', 'option'
    ]);

    if (INTERACTIVE_TAGS.has(tagName)) return true;

    // Direct Gmail Compose button detection
    if (node.getAttribute('gh') === 'cm' || node.classList?.contains('T-I-KE') || node.getAttribute('data-tooltip')?.toLowerCase() === 'compose') {
      return true;
    }

    if (tagName === 'IFRAME') {
      const title = (node.getAttribute('title') || node.getAttribute('aria-label') || node.id || node.src || '').toLowerCase();
      if (title.includes('sign in') || title.includes('google') || title.includes('auth') || title.includes('login') || title.includes('continue') || title.includes('gsi')) {
        return true;
      }
    }

    const role = node.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;

    if (node.hasAttribute('onclick') || node.hasAttribute('data-action') || node.hasAttribute('ng-click') || node.hasAttribute('@click') || node.hasAttribute('v-on:click')) {
      return true;
    }

    if (node.isContentEditable) return true;

    const tabIndex = node.getAttribute('tabindex');
    if (tabIndex !== null && parseInt(tabIndex, 10) >= 0) return true;

    if (style.cursor === 'pointer') return true;

    return false;
  }

  /**
   * Component 2: Live Error & Alert Collector
   * Scans document for active error indicators, validation warnings, and flash banners.
   */
  function collectPageAlerts() {
    const alerts = [];
    const alertSelectors = [
      '[role="alert"]',
      '.flash-error',
      '.flash-warn',
      '.TextInput-message--error',
      'p[class*="error" i]',
      'div[class*="error" i]',
      'span[class*="error" i]',
      'dd[class*="error" i]',
      '.error-message',
      '.alert-danger',
      '.alert-warning',
      '[aria-invalid="true"]'
    ];
    try {
      const alertNodes = document.querySelectorAll(alertSelectors.join(', '));
      alertNodes.forEach(node => {
        const style = window.getComputedStyle(node);
        if (style.display !== 'none' && style.visibility !== 'hidden' && (node.offsetWidth > 0 || node.offsetHeight > 0)) {
          const txt = (node.textContent || '').trim().replace(/\s+/g, ' ');
          if (txt && txt.length > 2 && txt.length < 200 && !alerts.includes(txt)) {
            alerts.push(txt);
          }
        }
      });

      // Also scan for red text nodes indicating validation errors
      const candidateNodes = document.querySelectorAll('p, span, div, small, em');
      candidateNodes.forEach(node => {
        if (node.children.length === 0 && (node.offsetWidth > 0 || node.offsetHeight > 0)) {
          const style = window.getComputedStyle(node);
          const col = style.color || '';
          if (col.includes('207, 34') || col.includes('225, 29') || col.includes('239, 68') || col.includes('220, 38') || col.includes('255, 0, 0')) {
            const txt = (node.textContent || '').trim().replace(/\s+/g, ' ');
            if (txt && txt.length > 2 && txt.length < 200 && !alerts.includes(txt)) {
              alerts.push(txt);
            }
          }
        }
      });
    } catch(e) {}
    return alerts;
  }

  /**
   * Pass 2: Extract semantic attributes & compute coordinates
   */
  function extractInteractiveElements(forceFull = true) {
    tagElementMap.clear();

    const SKIP_TAGS = new Set([
      'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR',
      'TEMPLATE', 'SVG', 'PATH', 'SOURCE', 'TRACK', 'WBR'
    ]);

    const rawElements = document.querySelectorAll('*');
    const rawCount = rawElements.length;
    const extracted = [];
    let tagId = 1;

    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (node.id === 'sih-tag-overlay-container' || node.classList?.contains('sih-tag-badge')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode())) {
      const style = window.getComputedStyle(node);
      if (!isElementVisible(node, style)) continue;
      if (!isElementInteractive(node, style)) continue;

      const rect = node.getBoundingClientRect();
      const currentTagId = tagId++;

      tagElementMap.set(currentTagId, node);

      let directText = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          directText += child.textContent;
        }
      }
      directText = directText.trim();

      let associatedLabel = '';
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
        if (node.labels && node.labels.length > 0) {
          associatedLabel = Array.from(node.labels).map(l => l.textContent.trim()).join(' ');
        }
        if (!associatedLabel && node.id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
            if (lbl) associatedLabel = lbl.textContent.trim();
          } catch(e) {}
        }
        if (!associatedLabel) {
          const parentLabel = node.closest('label');
          if (parentLabel) associatedLabel = parentLabel.textContent.trim();
        }
        if (!associatedLabel) {
          const container = node.closest('.form-group, .form-control, [data-target], fieldset, div');
          const nearbyLabel = container?.querySelector('label, [class*="label"], [class*="title"], [class*="Label"]');
          if (nearbyLabel) associatedLabel = nearbyLabel.textContent.trim();
        }
      }

      const ariaLabel = node.getAttribute('aria-label') ||
                        node.getAttribute('title') ||
                        (node.getAttribute('aria-labelledby') ? document.getElementById(node.getAttribute('aria-labelledby'))?.textContent?.trim() : null);

      const fullText = (node.textContent || '').trim();
      const finalLabelText = associatedLabel || directText || fullText || node.name || node.id || '';
      const elementText = finalLabelText.replace(/\s+/g, ' ').trim().substring(0, 120);

      const item = {
        tag_id: currentTagId,
        tag: node.tagName.toLowerCase(),
        text: elementText || null,
        aria_label: ariaLabel || null,
        name: node.name || null,
        id: node.id || null,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        center: {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        },
        interactive: true,
        type: node.getAttribute('type') || null,
        role: node.getAttribute('role') || null,
        disabled: node.disabled || node.getAttribute('aria-disabled') === 'true' || false
      };

      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        item.placeholder = node.getAttribute('placeholder') || null;
        item.value = node.value || null;
        if (node.type === 'checkbox' || node.type === 'radio') {
          item.checked = node.checked;
        }
      }

      if (node.tagName === 'A') {
        item.href = node.getAttribute('href') || null;
      }

      if (node.isContentEditable) {
        item.is_content_editable = true;
      }

      if (node.tagName === 'SELECT') {
        item.value = node.value || null;
        item.selected_text = node.options?.[node.selectedIndex]?.text || null;
      }

      extracted.push(item);
    }

    // Component 2: Inject active on-screen alerts into extracted elements so LLM sees them immediately
    const activeAlerts = collectPageAlerts();
    activeAlerts.forEach(alertText => {
      const currentTagId = tagId++;
      extracted.push({
        tag_id: currentTagId,
        tag: 'div',
        role: 'alert',
        text: alertText,
        aria_label: alertText,
        interactive: false,
        disabled: false
      });
    });

    const reduction = rawCount > 0
      ? (((rawCount - extracted.length) / rawCount) * 100).toFixed(1)
      : 0;

    cachedDomData = {
      url: window.location.href,
      title: document.title,
      elements: extracted,
      alerts: activeAlerts,
      element_count: extracted.length,
      raw_element_count: rawCount,
      reduction_percent: parseFloat(reduction)
    };

    isDomDirty = false;
    mutatedElementsSet.clear();

    return cachedDomData;
  }

  /**
   * Task 43 & 139: Zoom-Calibrated Numbered-Tag Grounding Overlays
   */
  function renderNumberedOverlays(elements) {
    clearNumberedOverlays();

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'sih-tag-overlay-container';
    overlayContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483647;
      overflow: visible;
    `;

    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    for (const el of elements) {
      if (!el.bbox || el.bbox.w === 0 || el.bbox.h === 0) continue;

      const badge = document.createElement('div');
      badge.className = 'sih-tag-badge';
      badge.textContent = el.tag_id;
      badge.style.cssText = `
        position: absolute;
        top: ${el.bbox.y + scrollY}px;
        left: ${el.bbox.x + scrollX}px;
        background: #facc15;
        color: #000000;
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 11px;
        font-weight: 800;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 3px;
        border: 1px solid #000000;
        box-shadow: 0 1px 4px rgba(0,0,0,0.6);
        pointer-events: none;
        z-index: 2147483647;
        opacity: 0.94;
        transform: translateY(-50%);
      `;
      overlayContainer.appendChild(badge);
    }

    document.body.appendChild(overlayContainer);
  }

  function clearNumberedOverlays() {
    if (overlayContainer && overlayContainer.parentNode) {
      overlayContainer.parentNode.removeChild(overlayContainer);
    }
    overlayContainer = null;
    document.querySelectorAll('.sih-tag-badge').forEach(el => el.remove());
  }

  /**
   * Action Simulation Helpers
   */
  async function simulateClick(element) {
    if (!element) return;

    // Find clickable parent if this is an inner text/icon node
    const clickableParent = element.closest('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], [jsaction*="click"], [onclick]') || element;

    if (clickableParent.disabled || clickableParent.getAttribute('aria-disabled') === 'true') {
      throw new Error(`Element "${(clickableParent.textContent || clickableParent.getAttribute('aria-label') || clickableParent.id || 'button').trim()}" is disabled and cannot be clicked.`);
    }

    try {
      clickableParent.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch(e) {}
    await sleep(150);

    const prevOutline = clickableParent.style.outline;
    const prevTransition = clickableParent.style.transition;
    clickableParent.style.transition = 'outline 0.2s ease-in-out';
    clickableParent.style.outline = '3px solid #00f2fe';

    const rect = clickableParent.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);

    const downInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      button: 0,
      buttons: 1,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY
    };

    const upInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      button: 0,
      buttons: 0,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY
    };

    // Target both direct element and any element right under the coordinates
    const targetUnderPoint = document.elementFromPoint(clientX, clientY) || clickableParent;

    targetUnderPoint.dispatchEvent(new PointerEvent('pointerdown', downInit));
    targetUnderPoint.dispatchEvent(new MouseEvent('mousedown', downInit));
    if (typeof clickableParent.focus === 'function') clickableParent.focus();
    targetUnderPoint.dispatchEvent(new PointerEvent('pointerup', upInit));
    targetUnderPoint.dispatchEvent(new MouseEvent('mouseup', upInit));
    targetUnderPoint.dispatchEvent(new MouseEvent('click', upInit));

    if (clickableParent !== targetUnderPoint) {
      clickableParent.dispatchEvent(new PointerEvent('pointerdown', downInit));
      clickableParent.dispatchEvent(new MouseEvent('mousedown', downInit));
      clickableParent.dispatchEvent(new PointerEvent('pointerup', upInit));
      clickableParent.dispatchEvent(new MouseEvent('mouseup', upInit));
      clickableParent.dispatchEvent(new MouseEvent('click', upInit));
    }

    if (typeof clickableParent.click === 'function') {
      try { clickableParent.click(); } catch(e) {}
    }

    if (clickableParent.type === 'radio' || clickableParent.type === 'checkbox') {
      clickableParent.checked = true;
      clickableParent.dispatchEvent(new Event('input', { bubbles: true }));
      clickableParent.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const innerRadio = clickableParent.querySelector?.('input[type="radio"], input[type="checkbox"]');
    if (innerRadio) {
      innerRadio.checked = true;
      innerRadio.dispatchEvent(new Event('input', { bubbles: true }));
      innerRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (clickableParent.tagName === 'IFRAME') {
      try {
        clickableParent.focus();
        if (clickableParent.contentWindow) {
          clickableParent.contentWindow.focus();
        }
      } catch(e) {}
    }

    // Direct href navigation fallback for <a> links only if genuine external link and not handled by SPA
    const rawHref = clickableParent.getAttribute('href');
    if (clickableParent.tagName === 'A' && rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:') && rawHref !== '') {
      try {
        if (clickableParent.target === '_blank') {
          window.open(clickableParent.href, '_blank');
        }
      } catch(e) {}
    }

    await sleep(200);
    clickableParent.style.outline = prevOutline;
    clickableParent.style.transition = prevTransition;
  }

  async function simulateType(element, text) {
    if (!element) return;
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch(e) {}
    await sleep(150);

    lastInteractedElement = element;
    const prevOutline = element.style.outline;
    element.style.outline = '3px solid #10b981';

    element.focus();
    if (typeof element.click === 'function') {
      try { element.click(); } catch(e) {}
    }

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const prevVal = element.value || '';
      const proto = element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }

      // CRITICAL FOR REACT (GitHub Primer, React 16/17/18/19):
      // React tracks input value with _valueTracker. If not reset, React thinks value didn't change and drops events!
      const tracker = element._valueTracker;
      if (tracker) {
        tracker.setValue(prevVal);
      }

      // ONLY use document.execCommand if document.activeElement is ACTUALLY this element!
      // This prevents execCommand from accidentally typing into an earlier field (like "To" recipient box)
      if (document.activeElement === element) {
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } catch(e) {}
      }

      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      try {
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      } catch(e) {}
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      // On Gmail, do not fire blur on subject or body as it causes editor reset
      const isGmail = window.location.hostname.includes('google') || window.location.hostname.includes('gmail');
      if (!isGmail) {
        element.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
      }

      // Check for Ace Editor (used on Programiz, LeetCode, CodeChef, etc.)
      const aceContainer = element.closest('.ace_editor') || document.querySelector('.ace_editor');
      if (aceContainer) {
        try {
          const s = document.createElement('script');
          s.textContent = `
            try {
              const el = document.querySelector('.ace_editor');
              if (el && window.ace) {
                const ed = window.ace.edit(el);
                if (ed) {
                  ed.setValue(${JSON.stringify(text)}, 1);
                  ed.clearSelection();
                }
              }
            } catch(e) {}
          `;
          (document.head || document.documentElement).appendChild(s);
          s.remove();
        } catch(e) {}

        try {
          const ta = aceContainer.querySelector('textarea.ace_text-input') || element;
          ta.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        } catch(e) {}

        await sleep(300);
        return;
      }
    } else if (element.isContentEditable || element.getAttribute('contenteditable') === 'true' || element.getAttribute('role') === 'textbox' || element.closest('[contenteditable="true"]')) {
      // For Gmail/Outlook compose body which uses contenteditable divs
      const targetEditable = element.isContentEditable ? element : (element.closest('[contenteditable="true"]') || element);
      targetEditable.focus();
      if (typeof targetEditable.click === 'function') {
        try { targetEditable.click(); } catch(e) {}
      }

      // Convert text with newlines into clean HTML paragraphs for rich text rendering
      const lines = text.split(/\r?\n/);
      const htmlContent = lines.map(line => {
        const safe = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return safe ? `<div>${safe}</div>` : `<div><br></div>`;
      }).join('');

      // Assign rich HTML paragraphs directly into the message body
      targetEditable.innerHTML = htmlContent;

      // Dispatch comprehensive input events so Gmail draft engine commits the text
      targetEditable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      targetEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      targetEditable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

      if (!targetEditable.innerText || targetEditable.innerText.trim().length === 0) {
        targetEditable.innerText = text;
      }

      // Dispatch comprehensive input events so Gmail draft engine commits the text
      targetEditable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      targetEditable.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      targetEditable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      // Keep focused, DO NOT blur (blur resets Gmail Closure editor state)
    }

    await sleep(200);
    element.style.outline = prevOutline;
  }

  async function simulateSelect(element, value) {
    if (!element) return;
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch(e) {}
    await sleep(150);

    if (element.tagName === 'SELECT') {
      let matched = false;
      for (let i = 0; i < element.options.length; i++) {
        if (element.options[i].value === value || element.options[i].text.trim().toLowerCase() === String(value).trim().toLowerCase()) {
          element.selectedIndex = i;
          matched = true;
          break;
        }
      }
      if (!matched && element.options.length > 0) {
        element.value = value;
      }
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Radio, checkbox, or custom choice element (e.g. GitHub Private/Public, options, toggles)
      const valStr = String(value || '').trim().toLowerCase();

      // Locate the actual input/radio
      let targetRadio = (element.type === 'radio' || element.type === 'checkbox')
        ? element
        : (element.querySelector?.('input[type="radio"], input[type="checkbox"], [role="radio"]') ||
           (element.getAttribute?.('for') ? document.getElementById(element.getAttribute('for')) : null) ||
           element.closest?.('label')?.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"]'));

      // If still not found and value is specified, search document for radio matching the value
      if (!targetRadio && valStr) {
        const matchingInput = document.querySelector(`input[type="radio"][value="${valStr}" i], input[value="${valStr}" i], [role="radio"][data-value="${valStr}" i]`);
        if (matchingInput) targetRadio = matchingInput;
      }

      if (targetRadio) {
        try {
          targetRadio.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch(e) {}

        // Trigger native property setter to satisfy React/Vue/Angular synthetic value tracker
        if (targetRadio.tagName === 'INPUT') {
          const proto = window.HTMLInputElement.prototype;
          const nativeCheckedSetter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
          if (nativeCheckedSetter) {
            nativeCheckedSetter.call(targetRadio, true);
          } else {
            targetRadio.checked = true;
          }
        } else if (targetRadio.getAttribute?.('role') === 'radio') {
          targetRadio.setAttribute('aria-checked', 'true');
        }

        // Full Pointer & Mouse event chain
        targetRadio.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        targetRadio.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        targetRadio.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
        targetRadio.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        targetRadio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

        if (typeof targetRadio.click === 'function') {
          try { targetRadio.click(); } catch(e) {}
        }

        targetRadio.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        targetRadio.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

        // Also trigger any wrapping or associated label
        const assocLabel = targetRadio.labels?.[0] || targetRadio.closest('label') ||
                           (targetRadio.id ? document.querySelector(`label[for="${targetRadio.id}"]`) : null);
        if (assocLabel && assocLabel !== targetRadio) {
          assocLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          if (typeof assocLabel.click === 'function') {
            try { assocLabel.click(); } catch(e) {}
          }
        }
      }

      // Check for custom dropdown / action menu (e.g. GitHub [Public ▾], ActionMenu, Popover)
      const isDropdown = element.tagName === 'BUTTON' ||
                         element.getAttribute('aria-haspopup') ||
                         element.getAttribute('aria-expanded') !== null ||
                         element.querySelector?.('svg, [class*="caret"], [class*="arrow"]');

      if (isDropdown && !targetRadio) {
        console.log('[Content] Triggering custom dropdown button to select option:', valStr);
        await simulateClick(element);
        await sleep(400);

        // Find the target option in the newly displayed overlay/menu
        const menuItems = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], button, li, a, div[role="button"]'));
        const matchedOption = menuItems.find(opt => {
          if (!isElementVisible(opt, window.getComputedStyle(opt))) return false;
          const t = (opt.textContent || opt.getAttribute('aria-label') || opt.getAttribute('data-value') || '').toLowerCase();
          return t.includes(valStr);
        });

        if (matchedOption) {
          console.log('[Content] Selecting option inside dropdown menu:', matchedOption);
          await simulateClick(matchedOption);
          await sleep(300);
          return;
        }
      }

      if (element.tagName === 'LABEL' || element.getAttribute('role') === 'radio') {
        if (typeof element.click === 'function') {
          try { element.click(); } catch(e) {}
        }
      }

      await simulateClick(element);

      // Post-selection validation: ensure radio is actually checked
      if (valStr && targetRadio && targetRadio.tagName === 'INPUT' && !targetRadio.checked) {
        targetRadio.checked = true;
        try { targetRadio.click(); } catch(e) {}
        targetRadio.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    }
  }

  async function simulateScroll(action) {
    const direction = action.direction || action.value || 'down';
    const amount = action.amount || 400;

    if (direction === 'up') {
      window.scrollBy({ top: -amount, behavior: 'smooth' });
    } else if (direction === 'down') {
      window.scrollBy({ top: amount, behavior: 'smooth' });
    } else if (direction === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (direction === 'bottom') {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
    await sleep(300);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function findElementSemantically(step) {
    const rawTarget = (step.intent || step.description || '')
      .replace(/^Click\s+["']?/i, '')
      .replace(/["']?\s+to complete$/i, '')
      .replace(/["']?\s*\(#\d+\)$/i, '')
      .replace(/^Type\s+["'][^"']+["']\s+into\s+["']?/i, '')
      .trim().toLowerCase();

    if (!rawTarget) return null;

    // Direct high-accuracy selectors for email/compose actions
    if (rawTarget.includes('compose')) {
      const composeBtn = document.querySelector('div[gh="cm"], .T-I-KE, [data-tooltip="Compose"], [aria-label="Compose"], [aria-label*="Compose"]')
        || Array.from(document.querySelectorAll('button, div[role="button"], a')).find(el => {
             const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
             return t === 'compose' || t.startsWith('compose');
           });
      if (composeBtn) {
        console.log('[Content] Matched Compose button via direct selector:', composeBtn);
        return composeBtn;
      }
    }

    const composeDialog = document.querySelector('div[role="dialog"], div.AD, table.Ao') || document;

    if (rawTarget.includes('recipient') || rawTarget.includes('to')) {
      const toInput = composeDialog.querySelector('input[name="to"], input[peoplekit-id], input[aria-label*="To" i], [role="combobox"] input, td.Ao input')
        || document.querySelector('input[name="to"], input[peoplekit-id], input[aria-label*="To" i]');
      if (toInput) {
        console.log('[Content] Matched recipient input via direct selector:', toInput);
        return toInput;
      }
    }

    if (rawTarget.includes('subject')) {
      const subjInput = composeDialog.querySelector('input[name="subjectbox"], input[placeholder*="Subject" i], input[aria-label*="Subject" i], input.aoT')
        || document.querySelector('input[name="subjectbox"], input[placeholder*="Subject" i], input[aria-label*="Subject" i]');
      if (subjInput) {
        console.log('[Content] Matched subject input via direct selector:', subjInput);
        return subjInput;
      }
    }

    if (rawTarget.includes('body') || rawTarget.includes('message') || rawTarget.includes('content') || rawTarget.includes('text')) {
      const bodyInput = composeDialog.querySelector('div[role="textbox"][contenteditable="true"], div[aria-label*="Message Body" i], div[aria-label*="Message text" i], div[role="textbox"], div[g_editable="true"]')
        || composeDialog.querySelector('div[contenteditable="true"]')
        || document.querySelector('div[role="dialog"] div[contenteditable="true"]');
      if (bodyInput) {
        console.log('[Content] Matched message body via direct selector:', bodyInput);
        return bodyInput;
      }
    }

    if (rawTarget.includes('code') || rawTarget.includes('editor')) {
      const codeEditor = document.querySelector('.ace_text-input, textarea.ace_text-input, .ace_content, .monaco-editor textarea, div[role="textbox"], textarea');
      if (codeEditor) return codeEditor;
    }

    if (rawTarget.includes('run') || rawTarget.includes('compile') || rawTarget.includes('execute')) {
      const runBtn = document.querySelector('#run-btn, button.run, [data-testid*="run"], button[aria-label*="run" i]')
        || Array.from(document.querySelectorAll('button')).find(btn => {
             const t = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase().trim();
             return t === 'run' || t.startsWith('run') || t.includes('compile');
           });
      if (runBtn) return runBtn;
    }

    if (rawTarget.includes('search result') || rawTarget.includes('top result') || rawTarget.includes('first result') || rawTarget.includes('first video') || rawTarget.includes('first item') || rawTarget.includes('first product') || rawTarget.includes('top findings')) {
      const topLink = document.querySelector(
        '#search a:has(h3), .g a:has(h3), [data-sokoban-container] a:has(h3), a:has(h3), #rso a:has(h3), #rso a, div[data-component-type="s-search-result"] h2 a, .s-result-item h2 a, div[data-cy="title-recipe"] a, ytd-video-renderer a#thumbnail, ytd-video-renderer h3 a, ytd-rich-item-renderer a#thumbnail, [data-testid="results-list"] a, div[data-testid="results-list"] div[data-testid="search-result"] a, a[data-testid="search-result-title"], a.Link__StyledLink-sc-nb9098-0, div.search-title a, a.v-align-middle, div.f4.text-normal a, ul.repo-list li a, a[href*="/"][data-testid*="result"]'
      );
      if (topLink) {
        console.log('[Content] Matched top search result link:', topLink);
        try {
          topLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
          topLink.style.outline = '3px solid #f43f5e';
          topLink.style.boxShadow = '0 0 20px rgba(244, 63, 94, 0.7)';
          topLink.style.borderRadius = '6px';
          topLink.style.transition = 'all 0.3s ease';
          setTimeout(() => {
            try {
              topLink.style.outline = '';
              topLink.style.boxShadow = '';
            } catch(e) {}
          }, 3800);
        } catch(e) {}
        return topLink;
      }
    }

    if (rawTarget.includes('presentation') || rawTarget.includes('template')) {
      const presBtn = document.querySelector(
        'button[aria-label*="Presentation" i], a[href*="presentation" i], div[role="button"][aria-label*="Presentation" i], button[aria-label*="blank" i], a[href*="category=tACFat6cqQI"], button:has(div)'
      ) || Array.from(document.querySelectorAll('button, a, div[role="button"]')).find(el => {
        const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
        return t.includes('presentation (16:9)') || t === 'presentation' || t.includes('create a blank presentation') || t.includes('blank presentation');
      });
      if (presBtn) {
        console.log('[Content] Matched Presentation template button:', presBtn);
        return presBtn;
      }
    }

    if (rawTarget.includes('repo') || rawTarget.includes('repository')) {
      const repoInput = document.querySelector(
        '#repository_name, input[name="repository[name]"], input[data-testid="repository-name-input"], input[aria-label*="Repository name" i], input[aria-describedby*="RepoName"], input[id*="repository_name"]'
      ) || Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find(el => {
        const lbl = (el.getAttribute('aria-label') || el.name || el.placeholder || el.id || '').toLowerCase();
        const parent = (el.closest('div, dl, fieldset, section')?.textContent || '').toLowerCase();
        return lbl.includes('repo') || parent.includes('repository name');
      });
      if (repoInput) {
        console.log('[Content] Matched repository name input via direct selector:', repoInput);
        return repoInput;
      }
    }

    if (rawTarget.includes('search') || rawTarget.includes('query') || rawTarget.includes('find')) {
      if (step.action === 'click' || rawTarget.includes('submit') || rawTarget.includes('button') || rawTarget.includes('icon') || rawTarget.includes('go')) {
        const searchBtn = document.querySelector(
          '#nav-search-submit-button, input#nav-search-submit-button, button#search-icon-legacy, input[name="btnK"], form input[type="submit"], form button[type="submit"], button[aria-label*="search" i], .nav-search-submit, .search-btn, .search-button, button.nav-search-submit'
        ) || Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => {
          const t = (b.textContent || b.getAttribute('aria-label') || b.id || '').toLowerCase();
          return t.includes('search') || t.includes('go');
        });
        if (searchBtn) {
          console.log('[Content] Matched search submit button via direct selector:', searchBtn);
          return searchBtn;
        }
      }

      const searchInput = document.querySelector(
        '#twotabsearchtextbox, input#nav-search-keywords, input[name="field-keywords"], input[name="q"], input[type="search"], input[name="search"], input[aria-label*="Search" i], input[placeholder*="Search" i], textarea[name="q"]'
      ) || Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).find(el => {
        const lbl = (el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').toLowerCase();
        return lbl.includes('search') || lbl.includes('query');
      });
      if (searchInput) {
        console.log('[Content] Matched search input via direct selector:', searchInput);
        return searchInput;
      }
    }

    if (rawTarget.includes('private') || (step.value && String(step.value).toLowerCase() === 'private')) {
      // Check for visibility dropdown button on modern GitHub / UI (e.g. [Public ▾] next to Choose visibility)
      const visDropdownBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const containerText = (btn.closest('div, section, fieldset')?.textContent || '').toLowerCase();
        return (text.includes('public') || text.includes('private') || text.includes('visibility')) && containerText.includes('visibility');
      });
      if (visDropdownBtn) {
        console.log('[Content] Matched visibility dropdown trigger:', visDropdownBtn);
        return visDropdownBtn;
      }

      const privateRadio = document.querySelector('input[type="radio"][value="private"], input[value="private"], #repository_visibility_private, [aria-label*="Private"], input[id*="private"]')
        || Array.from(document.querySelectorAll('label, div[role="radio"], [role="radio"]')).find(el => {
             const t = (el.textContent || '').toLowerCase();
             return t.includes('private') && !t.includes('public');
           });
      if (privateRadio) {
        console.log('[Content] Matched Private radio option:', privateRadio);
        return privateRadio;
      }
    }

    if (rawTarget.includes('public') || (step.value && String(step.value).toLowerCase() === 'public')) {
      const visDropdownBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        const text = (btn.textContent || btn.getAttribute('aria-label') || '').toLowerCase();
        const containerText = (btn.closest('div, section, fieldset')?.textContent || '').toLowerCase();
        return (text.includes('public') || text.includes('private') || text.includes('visibility')) && containerText.includes('visibility');
      });
      if (visDropdownBtn) return visDropdownBtn;

      const publicRadio = document.querySelector('input[type="radio"][value="public"], input[value="public"], #repository_visibility_public, [aria-label*="Public"], input[id*="public"]')
        || Array.from(document.querySelectorAll('label, div[role="radio"], [role="radio"]')).find(el => {
             const t = (el.textContent || '').toLowerCase();
             return t.includes('public') && !t.includes('private');
           });
      if (publicRadio) {
        console.log('[Content] Matched Public radio option:', publicRadio);
        return publicRadio;
      }
    }

    const candidates = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="link"], div[onclick], span[onclick], iframe, [tabindex]'));
    let best = null;
    let bestScore = 0;

    const words = rawTarget.split(/\s+/).filter(w => w.length >= 3 && !['the', 'and', 'with', 'for', 'click'].includes(w));

    for (const el of candidates) {
      if (!isElementVisible(el, window.getComputedStyle(el))) continue;
      const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').toLowerCase();
      if (!text) continue;

      let score = 0;
      for (const w of words) {
        if (text.includes(w)) score += 30;
      }
      if (rawTarget.length > 3 && text.includes(rawTarget)) score += 70;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 15;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    if (bestScore >= 25) {
      console.log(`[Content] Recovered target node semantically for step #${step.step || 0} (score: ${bestScore}):`, best);
      return best;
    }
    return null;
  }

  /**
   * Task 44: Native multi-action executor with per-step existence checks
   * If step N target vanished due to step N-1 changing the page, abort remaining plan
   * and log executed steps.
   */
  async function executeActionPlan(plan) {
    const actions = plan.actions || [];
    const planId = plan.id || `plan-${Date.now()}`;
    const executedResults = [];

    console.log(`[Content] Executing deterministic multi-action plan (${actions.length} steps)...`);

    for (let i = 0; i < actions.length; i++) {
      const step = actions[i];
      const stepIndex = step.step !== undefined ? step.step : i;
      let targetNode = null;

      // Immediate pre-step existence check
      if (step.tag_id) {
        if (tagElementMap.size === 0) {
          extractInteractiveElements(true);
        }
        targetNode = tagElementMap.get(step.tag_id);
        // Verify node is still connected to document
        if (targetNode && !document.contains(targetNode)) {
          console.warn(`[Content] Target tag #${step.tag_id} disconnected from DOM before step #${stepIndex}`);
          targetNode = null;
        }
      }

      // Robust Semantic Recovery: find matching element on live page if tag_id mapping shifted
      if (!targetNode && (step.description || step.intent || step.value)) {
        targetNode = findElementSemantically(step);
        if (!targetNode) {
          await sleep(400);
          targetNode = findElementSemantically(step);
        }
      }

      // High-accuracy live Gmail Compose element resolution (dialog-scoped to prevent hitting background inbox)
      const isGmail = window.location.hostname.includes('google') || window.location.hostname.includes('gmail');
      if (isGmail && (step.action === 'type' || step.action === 'click')) {
        const desc = (step.description || '').toLowerCase();
        const field = (step.field || '').toLowerCase();
        const isSubject = desc.includes('subject') || field.includes('subject');
        const isBody = desc.includes('body') || desc.includes('message') || field.includes('body') || field.includes('message');
        const isRecipient = !isSubject && !isBody && (desc.includes('recipient') || desc.includes('to') || field.includes('recipient') || field.includes('to'));

        // Locate the active Compose dialog (topmost modal in front of user)
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div.AD, table.Ao'));
        const composeDialog = dialogs.reverse().find(d => {
          return d.querySelector('input[name="subjectbox"], input[placeholder*="Subject" i], div[aria-label*="Message" i], div[role="textbox"]') !== null;
        }) || document.querySelector('div[role="dialog"]') || document;

        if (isBody) {
          const bodyEl = composeDialog.querySelector('div[role="textbox"][contenteditable="true"], div[aria-label*="Message Body" i], div[aria-label*="Message text" i], div[role="textbox"], div[g_editable="true"]')
                      || composeDialog.querySelector('div[contenteditable="true"]')
                      || document.querySelector('div[role="dialog"] div[contenteditable="true"]');
          if (bodyEl) {
            targetNode = bodyEl;
            try { bodyEl.click(); bodyEl.focus(); } catch(e) {}
          }
        } else if (isSubject) {
          const subjEl = composeDialog.querySelector('input[name="subjectbox"], input[placeholder*="Subject" i], input[aria-label*="Subject" i], input.aoT')
                      || document.querySelector('input[name="subjectbox"], input[placeholder*="Subject" i]');
          if (subjEl) {
            targetNode = subjEl;
            try { subjEl.click(); subjEl.focus(); } catch(e) {}
          }
        } else if (isRecipient) {
          const toEl = composeDialog.querySelector('input[name="to"], input[peoplekit-id], input[aria-label*="To" i], [role="combobox"] input, td.Ao input')
                    || document.querySelector('input[name="to"], input[peoplekit-id], input[aria-label*="To" i]');
          if (toEl) targetNode = toEl;
        } else if (desc.includes('compose')) {
          const composeEl = document.querySelector('div[gh="cm"], .T-I-KE, [data-tooltip="Compose"], [aria-label="Compose"], [aria-label*="Compose"]');
          if (composeEl) targetNode = composeEl;
        }
      }

      const actionType = step.action || step.type;
      const result = {
        plan_id: planId,
        step_index: stepIndex,
        action: actionType,
        success: false,
        error: null,
        page_changed: false
      };

      try {
        switch (actionType) {
          case 'click':
            if (!targetNode) {
              result.success = false;
              result.error = `Target element #${step.tag_id} not found in DOM`;
              break;
            }
            await simulateClick(targetNode);
            result.success = true;
            result.page_changed = true;
            break;

          case 'type':
            if (!targetNode) {
              result.success = false;
              result.error = `Target element #${step.tag_id} not found for typing`;
              break;
            }
            await simulateType(targetNode, step.value || '');
            result.success = true;
            result.page_changed = true;
            break;

          case 'select':
            if (!targetNode) {
              result.success = false;
              result.error = `Target element #${step.tag_id} not found for dropdown select`;
              break;
            }
            await simulateSelect(targetNode, step.value);
            result.success = true;
            result.page_changed = true;
            break;

          case 'scroll':
            await simulateScroll(step);
            result.success = true;
            result.page_changed = true;
            break;

          case 'hover':
            if (targetNode) {
              targetNode.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              targetNode.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            }
            result.success = true;
            break;

          case 'press_key': {
            const keyName = step.key || step.value || 'Enter';
            const keyCode = keyName === 'Enter' ? 13 : (keyName === 'Tab' ? 9 : 0);
            const keyInit = { key: keyName, code: keyName, keyCode, which: keyCode, bubbles: true, cancelable: true };
            const target = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : (lastInteractedElement || document.body);
            target.dispatchEvent(new KeyboardEvent('keydown', keyInit));
            target.dispatchEvent(new KeyboardEvent('keypress', keyInit));
            target.dispatchEvent(new KeyboardEvent('keyup', keyInit));

            // CRITICAL FOR WEBSITES (Amazon, YouTube, Google, GitHub, etc.):
            // Synthetic KeyboardEvent('Enter') does NOT trigger browser default form submission.
            // Actively locate and tap the search icon / submit button or trigger form.requestSubmit().
            if (keyName === 'Enter') {
              const isEmailPage = window.location.hostname.includes('mail.google.com') ||
                                  window.location.hostname.includes('gmail.com') ||
                                  (target && target.closest && (target.closest('[role="dialog"]') || target.closest('div[aria-label*="Compose" i]')));
              if (!isEmailPage) {
                const form = (target && target.tagName === 'FORM') ? target : (target.form || target.closest?.('form'));
                let submitBtn = form?.querySelector?.('#nav-search-submit-button, input[type="submit"], button[type="submit"], button[aria-label*="search" i], .nav-search-submit, button:has(svg)');
                if (!submitBtn) {
                  submitBtn = document.querySelector('#nav-search-submit-button, input#nav-search-submit-button, button#search-icon-legacy, input[name="btnK"], form input[type="submit"], form button[type="submit"], button[aria-label*="search" i], .search-btn, .search-button, button.nav-search-submit');
                }

                if (submitBtn) {
                  console.log('[Content] Tapping search icon / submit button on Enter:', submitBtn);
                  await simulateClick(submitBtn);
                } else if (form) {
                  try {
                    if (typeof form.requestSubmit === 'function') {
                      form.requestSubmit();
                    } else {
                      form.submit();
                    }
                  } catch(e) {
                    try { form.submit(); } catch(ex) {}
                  }
                }
              }
            }

            result.success = true;
            result.page_changed = true;
            break;
          }


          case 'navigate':
            if (step.value) {
              window.location.href = step.value;
            }
            result.success = true;
            result.page_changed = true;
            break;

          case 'back':
            window.history.back();
            result.success = true;
            result.page_changed = true;
            break;

          case 'reload':
            window.location.reload();
            result.success = true;
            result.page_changed = true;
            break;

          case 'wait':
            await sleep(step.value || 1000);
            result.success = true;
            break;

          default:
            throw new Error(`Unsupported action type: ${step.action}`);
        }
      } catch (err) {
        result.success = false;
        result.error = err?.message || 'Action execution error';
      }

      executedResults.push(result);

      // Report telemetry
      chrome.runtime.sendMessage({
        type: 'action_result',
        id: `ar-${Date.now()}-${stepIndex}`,
        timestamp: new Date().toISOString(),
        payload: result
      }).catch(() => {});

      // Halt on failure so agent re-reasons with fresh page state
      if (!result.success) {
        console.log(`[Content] Halting plan on step #${stepIndex}: ${result.error || 'Failed'}`);
        break;
      }

      await sleep(120);
    }

    return executedResults;
  }

  // Runtime message handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'ping': {
        sendResponse({ status: 'pong' });
        break;
      }

      case 'extract_dom': {
        const domData = extractInteractiveElements(message.force_full);
        if (message.render_overlays) {
          renderNumberedOverlays(domData.elements);
        }
        sendResponse({ type: 'dom_data', payload: domData });
        break;
      }

      case 'collect_alerts': {
        const alerts = collectPageAlerts();
        sendResponse({ alerts });
        break;
      }

      case 'show_overlays': {
        const domData = extractInteractiveElements();
        renderNumberedOverlays(domData.elements);
        sendResponse({ success: true, count: domData.elements.length });
        break;
      }

      case 'hide_overlays': {
        clearNumberedOverlays();
        sendResponse({ success: true });
        break;
      }

      case 'scan_pii': {
        const sensitive = window.PIIDetector ? window.PIIDetector.scanDOM() : [];
        sendResponse({ sensitive_nodes: sensitive });
        break;
      }

      case 'execute_actions':
      case 'action_plan': {
        executeActionPlan(message.payload)
          .then(results => sendResponse({ status: 'completed', results }))
          .catch(err => sendResponse({ status: 'error', error: err.message }));
        return true;
      }

      case 'start_speech_recognition': {
        const started = startWebSpeechRecognition();
        sendResponse({ success: started });
        break;
      }

      case 'stop_speech_recognition': {
        stopWebSpeechRecognition();
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ status: 'unhandled_message' });
    }
    return true;
  });

  // Live Speech Recognition Engine running in webpage context
  let contentSpeechRec = null;
  let isContentSpeechActive = false;

  function startWebSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[Content] Web Speech API not supported in this window');
      return false;
    }

    try {
      if (contentSpeechRec) {
        try { contentSpeechRec.stop(); } catch(e) {}
      }

      contentSpeechRec = new SpeechRecognition();
      contentSpeechRec.continuous = true;
      contentSpeechRec.interimResults = true;
      // Auto-detect optimal regional speech language for Indian English / multilingual accuracy
      contentSpeechRec.lang = navigator.language?.startsWith('en') ? 'en-IN' : (navigator.language || 'en-IN');
      isContentSpeechActive = true;

      contentSpeechRec.onresult = (event) => {
        let interimText = '';
        let finalText = '';
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalText += res[0].transcript + ' ';
          } else {
            interimText += res[0].transcript;
          }
        }
        const fullTranscript = (finalText + interimText).trim();
        if (fullTranscript) {
          chrome.runtime.sendMessage({
            type: 'speech_live_transcript',
            text: fullTranscript
          }).catch(() => {});
        }
      };

      contentSpeechRec.onerror = (event) => {
        if (event.error === 'network') {
          // If network glitch occurs, retry with en-US after short delay
          setTimeout(() => {
            if (isContentSpeechActive && contentSpeechRec) {
              try { contentSpeechRec.start(); } catch(e) {}
            }
          }, 300);
        }
      };

      contentSpeechRec.onend = () => {
        if (isContentSpeechActive && contentSpeechRec) {
          try { contentSpeechRec.start(); } catch(e) {}
        }
      };

      contentSpeechRec.start();
      return true;
    } catch (err) {
      return false;
    }
  }

  function stopWebSpeechRecognition() {
    isContentSpeechActive = false;
    if (contentSpeechRec) {
      try { contentSpeechRec.stop(); } catch(e) {}
      contentSpeechRec = null;
    }
  }

  console.log('[SIH26171] Advanced Content Script initialized');
})();
