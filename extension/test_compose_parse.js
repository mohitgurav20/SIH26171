const KNOWN_SITE_DOMAINS = {
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  twitter: 'https://twitter.com',
  x: 'https://x.com',
  youtube: 'https://www.youtube.com'
};

function decomposeGoalIntoSteps(query, currentUrl) {
  let q = query.toLowerCase().trim();
  const steps = [];

  // ── EMAIL / GMAIL COMPOSE WORKFLOW ───────────────────────────────────────
  const isComposeGoal = /\b(?:compose|write|send|draft)\b.*\b(?:mail|email|message|to)\b|\bto\s+[a-zA-Z0-9._\-]+.*subject\b|\bcompose\s+to\b/i.test(q);
  if (isComposeGoal) {
    if (!q.includes('mail.google.com') && !steps.some(s => s.type === 'navigate')) {
      steps.push({ type: 'navigate', url: 'https://mail.google.com', label: 'Open Gmail' });
    }
    steps.push({ type: 'click', target: 'Compose', label: 'Click Compose' });

    // Extract recipient
    const toMatch = q.match(/\b(?:to|recipient)\s+([a-zA-Z0-9._\-@]+)/i);
    const recipient = toMatch ? toMatch[1].trim() : null;
    if (recipient && !['a', 'an', 'the', 'my'].includes(recipient.toLowerCase())) {
      steps.push({ type: 'type', field: 'to recipients', value: recipient, label: `Enter recipient "${recipient}"` });
      steps.push({ type: 'press_key', key: 'Enter', label: 'Confirm recipient' });
    }

    // Extract subject
    const subjMatch = q.match(/\bsubject\s+(.+)$/i);
    const subject = subjMatch ? subjMatch[1].trim() : null;
    if (subject) {
      steps.push({ type: 'type', field: 'subject', value: subject, label: `Enter subject "${subject}"` });
    }

    return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
  }

  return steps;
}

const res = decomposeGoalIntoSteps("open gmail and compose to siddubakka subject 2 weeks holiday");
console.log("DECOMPOSED STEPS FOR GMAIL COMPOSE:");
console.log(JSON.stringify(res, null, 2));
