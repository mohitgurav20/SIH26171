/**
 * SIH26171 — DOM Compression Web Worker
 * Task 106: Moves structural JSON compression and filtering off the main thread.
 * Owner: Mohit
 */

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'compress_dom') {
    const { rawNodes, url, title, rawCount } = payload;
    const compressedElements = [];

    for (let i = 0; i < rawNodes.length; i++) {
      const node = rawNodes[i];
      // Build lightweight structured element
      const cleanElement = {
        tag_id: node.tag_id,
        tag: node.tag,
        text: node.text ? node.text.trim().substring(0, 120) : null,
        aria_label: node.aria_label || null,
        bbox: node.bbox,
        center: node.center,
        interactive: true,
        type: node.type || null,
        role: node.role || null,
        disabled: node.disabled || false
      };

      if (node.placeholder) cleanElement.placeholder = node.placeholder;
      if (node.value !== undefined && node.value !== null) cleanElement.value = node.value;
      if (node.checked !== undefined) cleanElement.checked = node.checked;
      if (node.href) cleanElement.href = node.href;
      if (node.selected_text) cleanElement.selected_text = node.selected_text;

      compressedElements.push(cleanElement);
    }

    const reductionPercent = rawCount > 0
      ? (((rawCount - compressedElements.length) / rawCount) * 100).toFixed(1)
      : 0;

    self.postMessage({
      type: 'compress_dom_result',
      payload: {
        url,
        title,
        elements: compressedElements,
        element_count: compressedElements.length,
        raw_element_count: rawCount,
        reduction_percent: parseFloat(reductionPercent)
      }
    });
  }
};
