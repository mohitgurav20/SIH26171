function getLabel(el) {
  return (el.text || el.aria_label || el.placeholder || el.name || el.id || el.value || '').toLowerCase();
}
const isInputEl = (el) =>
  el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'searchbox';

function resolveStepToActions(step, elements) {
  const actions = [];
  if (step.type === 'click') {
    const rawTarget = step.target.toLowerCase();
    const clickableEls = elements.filter(el => !isInputEl(el) || el.type === 'radio' || el.type === 'button' || el.type === 'submit');

    const targetWords = rawTarget.split(/\s+/).filter(w => w.length >= 3);
    let bestEl = null, bestScore = 0;
    for (const el of clickableEls) {
      const lbl = getLabel(el);
      if (!lbl) continue;
      let score = 0;
      for (const w of targetWords) {
        if (lbl.includes(w)) score += 35;
      }
      if (rawTarget.includes(lbl) || lbl.includes(rawTarget)) score += 60;
      if (rawTarget.includes('compose') && (lbl.includes('compose') || el.aria_label?.toLowerCase().includes('compose'))) score += 120;
      if (el.tag === 'button' || el.role === 'button' || el.type === 'submit') score += 20;
      if (el.tag === 'a' || el.role === 'link') score += 15;
      if (score > bestScore) { bestScore = score; bestEl = el; }
    }
    if (bestEl && bestScore >= 20) {
      actions.push({ step: 0, tag_id: bestEl.tag_id, action: 'click', description: step.label });
    }
  }
  return actions;
}

const mockGmailElements = [
  { tag_id: 1, tag: 'button', aria_label: 'Main menu', text: '' },
  { tag_id: 2, tag: 'a', aria_label: 'Gmail', text: 'Gmail' },
  { tag_id: 3, tag: 'input', role: 'searchbox', placeholder: 'Search mail' },
  { tag_id: 4, tag: 'div', role: 'button', text: 'Compose', aria_label: 'Compose' },
  { tag_id: 5, tag: 'a', text: 'Inbox' }
];

const res = resolveStepToActions({ type: 'click', target: 'Compose', label: 'Click Compose' }, mockGmailElements);
console.log("MATCH RESULT:", JSON.stringify(res, null, 2));
