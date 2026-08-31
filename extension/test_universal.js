const KNOWN_SITE_DOMAINS = {
  github: 'https://github.com',
  'my github': 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  spotify: 'https://open.spotify.com',
  instagram: 'https://www.instagram.com',
  twitter: 'https://www.twitter.com',
  reddit: 'https://www.reddit.com',
  chatgpt: 'https://chat.openai.com',
  canva: 'https://www.canva.com',
  figma: 'https://www.figma.com',
  notion: 'https://www.notion.so',
  amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com',
  netflix: 'https://www.netflix.com',
  udemy: 'https://www.udemy.com',
  kaggle: 'https://www.kaggle.com',
  leetcode: 'https://leetcode.com',
};

function decomposeGoalIntoSteps(query, currentUrl = '') {
  let q = query.toLowerCase().trim();
  const steps = [];

  // Phonetic correction
  const PHONETIC = [
    [/\bcontinue\s+has\b/gi, 'continue as'],
    [/\bguitar\b/gi, 'github'], [/\bget hub\b/gi, 'github'], [/\bgit hub\b/gi, 'github'],
    [/\byou\s*tube\b/gi, 'youtube'], [/\blinked\s+in\b/gi, 'linkedin'],
    [/\binsta\s*gram\b/gi, 'instagram'], [/\bchat\s+g\s*p\s*t\b/gi, 'chatgpt'],
    [/\blead\s*code\b/gi, 'leetcode'], [/\bleet\s*code\b/gi, 'leetcode'],
  ];
  for (const [p, r] of PHONETIC) q = q.replace(p, r);

  // ── 1. GITHUB REPO CREATION ───────────────────────────────────────────────
  const isGithubRepoGoal = /\b(?:create|new|make)\s+(?:a\s+)?(?:new\s+)?(?:repo|repository)\b/i.test(q) ||
                           (/\bgithub\b/i.test(q) && /\b(?:repo|repository)\b/i.test(q));

  if (isGithubRepoGoal) {
    steps.push({ type: 'navigate', url: 'https://github.com/new', label: 'Go to GitHub New Repository page' });

    const nameMatch = q.match(/(?:name\s+it|named|name|call\s+it|called|repo\s+name|repository\s+name)\s+([a-zA-Z0-9_\-\.]+)/i)
                   || q.match(/(?:create\s+(?:a\s+)?(?:new\s+)?(?:repo|repository)\s+(?:called\s+|named\s+)?)([a-zA-Z0-9_\-\.]+)/i);
    let repoName = nameMatch ? nameMatch[1].trim() : null;
    const reservedWords = ['and', 'make', 'it', 'private', 'public', 'a', 'the', 'new', 'repo', 'repository', 'this'];
    if (reservedWords.includes(repoName)) repoName = null;

    if (repoName) {
      steps.push({ type: 'type', field: 'repository name', value: repoName, label: `Set repo name to "${repoName}"` });
    }

    if (/\bprivate\b/i.test(q)) {
      steps.push({ type: 'select', field: 'visibility', value: 'private', label: 'Set repository to private' });
    } else if (/\bpublic\b/i.test(q)) {
      steps.push({ type: 'select', field: 'visibility', value: 'public', label: 'Set repository to public' });
    }

    steps.push({ type: 'click', target: 'Create repository', label: 'Submit — Create repository' });
    return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
  }

  // ── 2. EXTRACT SITE NAVIGATION FIRST IF PRESENT ───────────────────────────
  let siteUrl = null;
  let remainingQuery = q;

  const siteMatch = q.match(/^(?:open|go\s+to|navigate\s+to|visit|launch)\s+([a-zA-Z0-9_\-\.]+)(?:\s+(?:website|app|page))?\b\s*(.*)$/i);
  if (siteMatch) {
    const rawSite = siteMatch[1].toLowerCase();
    remainingQuery = siteMatch[2]?.trim() || '';

    if (KNOWN_SITE_DOMAINS[rawSite]) {
      siteUrl = KNOWN_SITE_DOMAINS[rawSite];
    } else if (rawSite.includes('.')) {
      siteUrl = `https://${rawSite}`;
    } else {
      siteUrl = `https://${rawSite}.com`;
    }
    steps.push({ type: 'navigate', url: siteUrl, label: `Open ${rawSite}` });
  }

  // ── 3. LOGIN / SIGN IN WORKFLOW ON ANY SITE ────────────────────────────────
  const isLoginGoal = /\b(?:log\s*in|sign\s*in|login|signin|enter\s*(?:my\s*)?account)\b/i.test(remainingQuery || q);
  if (isLoginGoal) {
    // Extract username/email identifier from speech (e.g. 'as mohit', 'with email mohit@gmail.com')
    const userMatch = (remainingQuery || q).match(/\b(?:as|user(?:name)?|email|id)\s+([a-zA-Z0-9@._\-]+)$/i)
                   || (remainingQuery || q).match(/\b(?:as|user(?:name)?|email|id)\s+([a-zA-Z0-9@._\-]+)\b/i);
    let username = userMatch ? userMatch[1].trim() : null;
    const reservedUsers = ['login', 'signin', 'my', 'first', 'account', 'email', 'user', 'the', 'a', 'it', 'password'];
    if (reservedUsers.includes(username?.toLowerCase())) username = null;

    // Step: Click Sign In / Login button
    steps.push({ type: 'click', target: 'Sign in Log in Login', label: 'Click Sign in / Login' });

    // Step: Type username/email if mentioned
    if (username) {
      steps.push({ type: 'type', field: 'username email login identifier', value: username, label: `Enter username/email "${username}"` });
    }

    return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
  }


  // ── 4. SEARCH WORKFLOW ON ANY SITE ─────────────────────────────────────────
  const isSearchGoal = /\b(?:search(?:\s+for)?|find|look\s+for|query)\b/i.test(remainingQuery || q);
  if (isSearchGoal) {
    const searchMatch = (remainingQuery || q).match(/(?:search(?:\s+for)?|find|look\s+for|query)\s+(.+)$/i);
    let queryTerm = searchMatch ? searchMatch[1].trim() : '';
    queryTerm = queryTerm.replace(/\s+(?:on|in)\s+[a-zA-Z0-9_\-\.]+$/i, '').trim();

    if (queryTerm) {
      steps.push({ type: 'type', field: 'search query input', value: queryTerm, label: `Search for "${queryTerm}"` });
      steps.push({ type: 'click', target: 'Search submit button', label: 'Submit search' });
      return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
    }
  }

  // ── 5. GENERAL CLAUSE-BY-CLAUSE DECOMPOSITION ─────────────────────────────
  if (remainingQuery) {
    const clauses = remainingQuery.split(/\s+(?:and\s+then|then|after\s+that|and\s+also|also|and|,|;)\s+|\s+(?=(?:make|set|change|switch|turn|select|choose|click|press|tap|submit|create|save|fill|type|enter)\s+)/i);
    for (const c of clauses) {
      const clause = c.trim();
      if (!clause) continue;

      const clickM = clause.match(/^(?:click|press|tap|hit|submit)\s+(.+)$/i);
      if (clickM) {
        steps.push({ type: 'click', target: clickM[1].trim(), label: `Click "${clickM[1].trim()}"` });
        continue;
      }

      const typeM = clause.match(/^(?:type|enter|write|fill)\s+(.+?)(?:\s+in(?:to)?\s+(.+))?$/i);
      if (typeM) {
        steps.push({ type: 'type', field: typeM[2]?.trim() || 'input', value: typeM[1].trim(), label: `Type "${typeM[1].trim()}"` });
        continue;
      }

      if (/^scroll\s+(down|up|top|bottom)/i.test(clause)) {
        steps.push({ type: 'scroll', direction: /down|bottom/i.test(clause) ? 'down' : 'up', label: `Scroll ${clause}` });
        continue;
      }
    }
  }

  return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
}

console.log('Test LeetCode Login:', JSON.stringify(decomposeGoalIntoSteps('open leetcode and login with my first email account as mohit'), null, 2));
console.log('Test Amazon Search:', JSON.stringify(decomposeGoalIntoSteps('open amazon and search for wireless headphones'), null, 2));
console.log('Test GitHub Repo:', JSON.stringify(decomposeGoalIntoSteps('open github create new repo and name it sheru_bhai make it private'), null, 2));
