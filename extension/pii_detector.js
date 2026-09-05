/**
 * SIH26171 — Client-Side Privacy-Preserving PII Detector (ISRO PS Requirement)
 * Detects sensitive personal identifiable information (PII) before any visual
 * or DOM data leaves the browser.
 */
(function(window) {
  'use strict';

  const PII_REGEX = {
    AADHAAR: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
    PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g,
    PHONE: /(?:(?:\+91|0091|0)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
    EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    CREDIT_CARD: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|6(?:011|5[0-9][0-9])[0-9]{12}|3[47][0-9]{13})\b/g,
    CVV: /\b\d{3,4}\b/g
  };

  class PIIDetector {
    /**
     * Scans DOM elements for password inputs, sensitive names, and PII patterns.
     * Returns an array of sensitive element descriptor objects with bounding boxes.
     */
    static scanDOM(root = document) {
      const sensitiveNodes = [];

      // 1. Password and credential inputs
      const passwordInputs = root.querySelectorAll('input[type="password"]');
      passwordInputs.forEach(input => {
        const rect = input.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          sensitiveNodes.push({
            type: 'PASSWORD',
            category: 'CREDENTIALS',
            element: input,
            bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            value: input.value || '●●●●●●',
            mask: '●●●●●●'
          });
        }
      });

      // 2. Form fields by sensitive names/attributes
      const allInputs = root.querySelectorAll('input:not([type="password"]), textarea, [contenteditable="true"]');
      allInputs.forEach(input => {
        const name = (input.name || input.id || input.getAttribute('aria-label') || '').toLowerCase();
        let piiType = null;

        if (name.includes('aadhaar') || name.includes('aadhar') || name.includes('uidai')) piiType = 'AADHAAR';
        else if (name.includes('pan') || name.includes('pan_card')) piiType = 'PAN';
        else if (name.includes('card') || name.includes('cvv') || name.includes('expiry') || name.includes('cc-num')) piiType = 'CREDIT_CARD';
        else if (name.includes('phone') || name.includes('mobile') || name.includes('contact')) piiType = 'PHONE';
        else if (name.includes('email') || name.includes('mail')) piiType = 'EMAIL';

        if (piiType) {
          const rect = input.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            sensitiveNodes.push({
              type: piiType,
              category: 'FORM_PII',
              element: input,
              bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
              value: input.value || input.textContent || '',
              mask: `[REDACTED_${piiType}]`
            });
          }
        }
      });

      // 3. Fast bounded scan on visible text nodes (capped at 100 to prevent SPA freeze)
      const textContainers = root.querySelectorAll('p, span, div, td, label');
      let scannedCount = 0;
      for (let i = 0; i < textContainers.length && scannedCount < 80; i++) {
        const el = textContainers[i];
        if (el.children.length > 2) continue; // Skip complex container trees
        const text = el.textContent?.trim();
        if (!text || text.length < 5 || text.length > 200) continue;

        for (const [piiType, regex] of Object.entries(PII_REGEX)) {
          regex.lastIndex = 0;
          if (regex.test(text)) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              sensitiveNodes.push({
                type: piiType,
                category: 'TEXT_PII',
                element: el,
                bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                value: text.slice(0, 50),
                mask: `[REDACTED_${piiType}]`
              });
              break;
            }
          }
        }
        scannedCount++;
      }

      return sensitiveNodes;
    }

    /**
     * Sanitizes DOM elements array before sending to the model.
     */
    static sanitizeElements(elements) {
      if (!Array.isArray(elements)) return [];
      return elements.map(el => {
        const clean = { ...el };
        const label = `${el.text || ''} ${el.aria_label || ''} ${el.placeholder || ''} ${el.value || ''}`;

        for (const [piiType, regex] of Object.entries(PII_REGEX)) {
          regex.lastIndex = 0;
          if (regex.test(label)) {
            if (clean.text) clean.text = clean.text.replace(regex, `[REDACTED_${piiType}]`);
            if (clean.value) clean.value = clean.value.replace(regex, `[REDACTED_${piiType}]`);
            if (clean.aria_label) clean.aria_label = clean.aria_label.replace(regex, `[REDACTED_${piiType}]`);
          }
        }

        if (el.tag === 'input' && (el.type === 'password' || el.name?.includes('pass'))) {
          clean.value = '●●●●●●';
        }

        return clean;
      });
    }
  }

  window.PIIDetector = PIIDetector;
})(typeof window !== 'undefined' ? window : this);
