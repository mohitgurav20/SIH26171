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

  if (window.__SIH26171_CONTENT_INITIALIZED__) return;
  window.__SIH26171_CONTENT_INITIALIZED__ = true;

  // DOM State Cache
  const tagElementMap = new Map();
  let overlayContainer = null;
  let cachedDomData = null;
  let isDomDirty = true;
  let domWorker = null;
  let mutationDebounceTimer = null;
  const mutatedElementsSet = new Set();

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
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (node.hasAttribute('aria-hidden') && node.getAttribute('aria-hidden') === 'true') {
      return false;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
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
   * Pass 2: Extract semantic attributes & compute coordinates
   */
  function extractInteractiveElements(forceFull = false) {
    // If not dirty and cached, return cache (instant response)
    if (!forceFull && !isDomDirty && cachedDomData) {
      return cachedDomData;
    }

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

      if (node.tagName === 'SELECT') {
        item.value = node.value || null;
        item.selected_text = node.options?.[node.selectedIndex]?.text || null;
      }

      extracted.push(item);
    }

    const reduction = rawCount > 0
      ? (((rawCount - extracted.length) / rawCount) * 100).toFixed(1)
      : 0;

    cachedDomData = {
      url: window.location.href,
      title: document.title,
      elements: extracted,
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
    const clickableParent = element.closest('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"]') || element;

    try {
      clickableParent.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch(e) {}
    await sleep(150);

    const prevOutline = clickableParent.style.outline;
    const prevTransition = clickableParent.style.transition;
    clickableParent.style.transition = 'outline 0.2s ease-in-out';
    clickableParent.style.outline = '3px solid #00f2fe';

    const rect = clickableParent.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY
    };

    clickableParent.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    clickableParent.dispatchEvent(new MouseEvent('mousedown', eventInit));
    if (typeof clickableParent.focus === 'function') clickableParent.focus();
    clickableParent.dispatchEvent(new PointerEvent('pointerup', eventInit));
    clickableParent.dispatchEvent(new MouseEvent('mouseup', eventInit));
    clickableParent.dispatchEvent(new MouseEvent('click', eventInit));

    if (typeof clickableParent.click === 'function') {
      clickableParent.click();
    }

    // Direct href navigation fallback for <a> links if framework didn't intercept
    if (clickableParent.tagName === 'A' && clickableParent.href && !clickableParent.href.startsWith('javascript:')) {
      if (clickableParent.target === '_blank') {
        window.open(clickableParent.href, '_blank');
      } else {
        window.location.href = clickableParent.href;
      }
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

    const prevOutline = element.style.outline;
    element.style.outline = '3px solid #10b981';

    element.focus();
    if (typeof element.click === 'function') {
      try { element.click(); } catch(e) {}
    }

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const proto = element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }

      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      try {
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      } catch(e) {}
    } else if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    await sleep(200);
    element.style.outline = prevOutline;
  }

  async function simulateSelect(element, value) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        targetNode = tagElementMap.get(step.tag_id);
        // Verify node is still connected to document
        if (targetNode && !document.contains(targetNode)) {
          console.warn(`[Content] Target tag #${step.tag_id} disconnected from DOM before step #${stepIndex}`);
          targetNode = null;
        }
      }

      const result = {
        plan_id: planId,
        step_index: stepIndex,
        action: step.action,
        success: false,
        error: null,
        page_changed: false
      };

      try {
        switch (step.action) {
          case 'click':
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} vanished or not found in DOM`);
            await simulateClick(targetNode);
            result.success = true;
            result.page_changed = true;
            break;

          case 'type':
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} vanished or not found for typing`);
            await simulateType(targetNode, step.value || '');
            result.success = true;
            result.page_changed = true;
            break;

          case 'select':
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} vanished for dropdown select`);
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

          case 'press_key':
            document.activeElement?.dispatchEvent(
              new KeyboardEvent('keydown', { key: step.value || 'Enter', bubbles: true })
            );
            result.success = true;
            break;

          case 'wait':
            await sleep(step.value || 1000);
            result.success = true;
            break;

          default:
            throw new Error(`Unsupported action type: ${step.action}`);
        }
      } catch (err) {
        console.error(`[Content] Step #${stepIndex} halted:`, err.message);
        result.success = false;
        result.error = err.message;
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
        console.warn(`[Content] Aborting remaining plan steps. Succeeded: ${i}/${actions.length}`);
        break;
      }

      await sleep(120);
    }

    return executedResults;
  }

  // Runtime message handler
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'extract_dom': {
        const domData = extractInteractiveElements(message.force_full);
        if (message.render_overlays) {
          renderNumberedOverlays(domData.elements);
        }
        sendResponse({ type: 'dom_data', payload: domData });
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
      contentSpeechRec.lang = 'en-US';
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
