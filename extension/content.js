/**
 * SIH26171 — Content Script — Semantic DOM Filter
 * Two-pass DOM filtering to extract interactive elements with ~90% payload reduction.
 * Owner: Mohit
 * 
 * Pass 1: Remove non-visible, non-interactive nodes (display:none, zero-dimension, tracking pixels)
 * Pass 2: Extract semantic attributes (tag type, visible text, ARIA label, bounding box)
 * Output: Minified JSON tree matching the message contract format
 */

(function() {
  'use strict';

  /**
   * Extract interactive elements from the current page.
   * Returns a compact JSON structure for the native host.
   */
  function extractInteractiveElements() {
    const INTERACTIVE_TAGS = new Set([
      'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA',
      'DETAILS', 'SUMMARY', 'LABEL', 'OPTION'
    ]);

    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio',
      'combobox', 'listbox', 'menuitem', 'tab', 'switch',
      'slider', 'spinbutton', 'searchbox'
    ]);

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HR']);

    const elements = [];
    let tagId = 1;

    // Walk the DOM
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Pass 1: Skip non-visible and non-interactive
          if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;

          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }

          const rect = node.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return NodeFilter.FILTER_REJECT;

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while (node = walker.nextNode()) {
      const isInteractive = INTERACTIVE_TAGS.has(node.tagName) ||
                             node.hasAttribute('onclick') ||
                             node.hasAttribute('role') && INTERACTIVE_ROLES.has(node.getAttribute('role')) ||
                             node.getAttribute('tabindex') !== null ||
                             node.isContentEditable;

      if (!isInteractive) continue;

      // Pass 2: Extract semantic attributes
      const rect = node.getBoundingClientRect();
      const element = {
        tag_id: tagId++,
        tag: node.tagName.toLowerCase(),
        text: (node.textContent || '').trim().substring(0, 100),
        aria_label: node.getAttribute('aria-label') || null,
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        },
        interactive: true,
        type: node.getAttribute('type') || null
      };

      // Add placeholder/value for inputs
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        element.placeholder = node.getAttribute('placeholder') || null;
        element.value = node.value || null;
      }

      // Add href for links
      if (node.tagName === 'A') {
        element.href = node.getAttribute('href') || null;
      }

      elements.push(element);
    }

    return {
      url: window.location.href,
      title: document.title,
      elements: elements,
      element_count: elements.length,
      raw_element_count: document.querySelectorAll('*').length,
      reduction_percent: elements.length > 0
        ? ((1 - elements.length / document.querySelectorAll('*').length) * 100).toFixed(1)
        : 0
    };
  }

  // Listen for extraction requests from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'extract_dom') {
      const data = extractInteractiveElements();
      sendResponse({ type: 'dom_data', payload: data });
    } else if (message.type === 'action_plan') {
      // TODO: Mohit — implement multi-action executor here
      console.log('[Content] Received action plan:', message.payload);
      sendResponse({ status: 'received' });
    }
    return true;
  });

  console.log('[SIH26171] Content script loaded on:', window.location.href);
})();
