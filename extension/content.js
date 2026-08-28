/**
 * SIH26171 — Content Script
 * Semantic DOM Filter (2-pass), Numbered-Tag Grounding Overlays & Deterministic Multi-Action Executor.
 * Owner: Mohit
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__SIH26171_CONTENT_INITIALIZED__) return;
  window.__SIH26171_CONTENT_INITIALIZED__ = true;

  // Cache of current interactive elements: tag_id -> DOM Element
  const tagElementMap = new Map();
  let overlayContainer = null;

  /**
   * Check if an element is genuinely visible in the DOM
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

    // Check if scrolled completely out of crazy coordinates
    if (rect.bottom < -500 || rect.top > (window.innerHeight + 500)) return false;

    return true;
  }

  /**
   * Determine if an element is interactive
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
   * Two-Pass Semantic DOM Filter
   * Pass 1: Tree Walker with visibility filter
   * Pass 2: Semantic attribute extraction & coordinate calculation
   */
  function extractInteractiveElements() {
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
          if (node.id === 'sih-tag-overlay-container' || node.classList.contains('sih-tag-badge')) {
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

      // Cache mapping for action execution
      tagElementMap.set(currentTagId, node);

      // Extract visible text
      let directText = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          directText += child.textContent;
        }
      }
      directText = directText.trim();
      const fullText = (node.textContent || '').trim().replace(/\s+/g, ' ');
      const elementText = (directText || fullText).substring(0, 120);

      const ariaLabel = node.getAttribute('aria-label') ||
                        node.getAttribute('title') ||
                        (node.getAttribute('aria-labelledby') ? document.getElementById(node.getAttribute('aria-labelledby'))?.textContent?.trim() : null);

      const item = {
        tag_id: currentTagId,
        tag: node.tagName.toLowerCase(),
        text: elementText || null,
        aria_label: ariaLabel || null,
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

    return {
      url: window.location.href,
      title: document.title,
      elements: extracted,
      element_count: extracted.length,
      raw_element_count: rawCount,
      reduction_percent: parseFloat(reduction)
    };
  }

  /**
   * Render Numbered-Tag Grounding Overlays (Set-of-Marks badges)
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
        opacity: 0.92;
        transform: translateY(-50%);
      `;
      overlayContainer.appendChild(badge);
    }

    document.body.appendChild(overlayContainer);
  }

  /**
   * Remove all tag overlays
   */
  function clearNumberedOverlays() {
    if (overlayContainer && overlayContainer.parentNode) {
      overlayContainer.parentNode.removeChild(overlayContainer);
    }
    overlayContainer = null;
    document.querySelectorAll('.sih-tag-badge').forEach(el => el.remove());
  }

  /**
   * Helper: Dispatch human-like synthetic click
   */
  async function simulateClick(element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(150);

    // Highlight border during execution
    const prevOutline = element.style.outline;
    const prevTransition = element.style.transition;
    element.style.transition = 'outline 0.2s ease-in-out';
    element.style.outline = '3px solid #00f2fe';

    const rect = element.getBoundingClientRect();
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

    element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    element.dispatchEvent(new MouseEvent('mousedown', eventInit));
    element.focus();
    element.dispatchEvent(new PointerEvent('pointerup', eventInit));
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));
    element.dispatchEvent(new MouseEvent('click', eventInit));

    if (typeof element.click === 'function') {
      element.click();
    }

    await sleep(200);
    element.style.outline = prevOutline;
    element.style.transition = prevTransition;
  }

  /**
   * Helper: Dispatch human-like synthetic input with React/Vue/Angular compatibility
   */
  async function simulateType(element, text) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await sleep(150);

    const prevOutline = element.style.outline;
    element.style.outline = '3px solid #10b981';

    element.focus();

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      // Prototype setter bypass for React/Vue reactive property overrides
      const proto = element.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (element.isContentEditable) {
      element.textContent = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Trigger key events for listeners
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));

    await sleep(200);
    element.style.outline = prevOutline;
  }

  /**
   * Helper: Select option in dropdown
   */
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

  /**
   * Helper: Scroll action
   */
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

  /**
   * Helper: Sleep promise
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute a full multi-action plan sequentially
   */
  async function executeActionPlan(plan) {
    const actions = plan.actions || [];
    const planId = plan.id || `plan-${Date.now()}`;
    const results = [];

    console.log(`[Content] Executing multi-action plan (${actions.length} steps)...`);

    for (let i = 0; i < actions.length; i++) {
      const step = actions[i];
      const stepIndex = step.step !== undefined ? step.step : i;
      let targetNode = null;

      if (step.tag_id) {
        targetNode = tagElementMap.get(step.tag_id);
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
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} not found in current page DOM`);
            await simulateClick(targetNode);
            result.success = true;
            result.page_changed = true;
            break;

          case 'type':
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} not found in current page DOM`);
            await simulateType(targetNode, step.value || '');
            result.success = true;
            result.page_changed = true;
            break;

          case 'select':
            if (!targetNode) throw new Error(`Target tag_id #${step.tag_id} not found for select`);
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
        console.error(`[Content] Step #${stepIndex} failed:`, err);
        result.success = false;
        result.error = err.message;
      }

      results.push(result);

      // Report step result back through background to native host
      chrome.runtime.sendMessage({
        type: 'action_result',
        id: `ar-${Date.now()}-${stepIndex}`,
        timestamp: new Date().toISOString(),
        payload: result
      }).catch(() => {});

      if (!result.success) {
        console.warn(`[Content] Halting plan execution at failed step #${stepIndex}`);
        break;
      }

      await sleep(100);
    }

    return results;
  }

  // Runtime message dispatcher
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'extract_dom': {
        const domData = extractInteractiveElements();
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

      case 'action_plan': {
        executeActionPlan(message.payload)
          .then(results => sendResponse({ status: 'completed', results }))
          .catch(err => sendResponse({ status: 'error', error: err.message }));
        return true; // Keep response open
      }

      default:
        sendResponse({ status: 'unhandled_message' });
    }
    return true;
  });

  console.log('[SIH26171] Content script ready with 2-pass DOM filter & action executor');
})();
