function getLabel(el) {
  return (el.text || el.aria_label || el.placeholder || el.name || el.id || el.value || '').toLowerCase();
}
const isInputEl = (el) =>
  el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'searchbox';

function resolveStepToActions(step, elements) {
  const actions = [];
  if (step.type === 'type') {
    const fieldWords = step.field.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const inputEls = elements.filter(isInputEl).filter(el => el.type !== 'radio' && el.type !== 'checkbox');
    let bestEl = null, bestScore = 0;
    for (const el of inputEls) {
      const lbl = getLabel(el);
      let score = fieldWords.reduce((s, w) => s + (lbl.includes(w) ? 40 : 0), 0);
      if (lbl.includes(step.field.toLowerCase())) score += 60;
      if (step.field.includes('subject') && (lbl.includes('subject') || el.name?.includes('subject') || el.placeholder?.toLowerCase().includes('subject'))) score += 150;
      if (step.field.includes('recipient') && (lbl.includes('recipient') || lbl.includes('to') || el.aria_label?.toLowerCase().includes('to') || el.name?.includes('to'))) score += 150;
      if (score > bestScore) { bestScore = score; bestEl = el; }
    }
    if (!bestEl && inputEls.length > 0) bestEl = inputEls[0];
    if (bestEl) {
      actions.push({ step: 0, tag_id: bestEl.tag_id, action: 'type', value: step.value, description: step.label });
    }
  }
  return actions;
}

const mockComposeElements = [
  { tag_id: 1, tag: 'input', role: 'searchbox', placeholder: 'Search mail' },
  { tag_id: 10, tag: 'input', role: 'textbox', aria_label: 'To recipients', text: '' },
  { tag_id: 11, tag: 'input', role: 'textbox', name: 'subjectbox', placeholder: 'Subject', text: '' },
  { tag_id: 12, tag: 'div', role: 'textbox', aria_label: 'Message Body', text: '' }
];

const toRes = resolveStepToActions({ type: 'type', field: 'to recipients', value: 'siddubakka', label: 'Enter recipient "siddubakka"' }, mockComposeElements);
console.log("TO FIELD MATCH:", JSON.stringify(toRes));

const subjRes = resolveStepToActions({ type: 'type', field: 'subject', value: '2 weeks holiday', label: 'Enter subject "2 weeks holiday"' }, mockComposeElements);
console.log("SUBJECT FIELD MATCH:", JSON.stringify(subjRes));
