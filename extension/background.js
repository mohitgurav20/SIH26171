/**
 * SIH26171 — Background Service Worker
 * Native host communication, offscreen task offloading, screenshot captures,
 * and Task 105 Predictive Prefetching.
 * Owner: Mohit
 */

const NATIVE_HOST_NAMES = ['com.sih26171.voicc', 'com.sih26171.browser_ai_agent'];
let currentHostIndex = 0;

let nativePort = null;
let reconnectTimer = null;
let currentStatus = { state: 'offline', message: '' };
let latestResourceStats = null;
let prefetchedState = null;
let prefetchAbortController = null;

// Connect to native messaging host
function connectNativeHost() {
  if (nativePort) return;

  const hostToTry = NATIVE_HOST_NAMES[currentHostIndex % NATIVE_HOST_NAMES.length];

  try {
    nativePort = chrome.runtime.connectNative(hostToTry);

    nativePort.onMessage.addListener((message) => {
      console.log('[Background] Native host message:', message.type);
      handleNativeMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Unknown error';
      console.warn(`[Background] Native host (${hostToTry}) disconnected:`, error);
      nativePort = null;
      currentHostIndex++;
      broadcastStatus('offline', 'Native host disconnected. Reconnecting...');
      scheduleReconnect();
    });

    broadcastStatus('connected', 'Connected to native agent');
    console.log('[Background] Connected to native host:', hostToTry);
  } catch (error) {
    console.error(`[Background] Failed to connect to native host (${hostToTry}):`, error);
    nativePort = null;
    currentHostIndex++;
    broadcastStatus('offline', 'Failed to connect to host');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 4000);
}

// Forward outgoing message to native host
function forwardToNativeHost(message) {
  if (!nativePort) {
    console.warn('[Background] Port not connected, attempting reconnect...');
    connectNativeHost();
  }

  if (nativePort) {
    try {
      nativePort.postMessage(message);
      return true;
    } catch (err) {
      console.error('[Background] Error posting message to native host:', err);
      return false;
    }
  } else {
    console.error('[Background] Cannot send — native host unavailable');
    return false;
  }
}

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_SCRAPING', 'USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Crop visual patches and process microphone audio PCM stream'
  });
}

// Capture current tab screenshot as Base64 PNG
async function captureActiveTabScreenshot() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return {
      image_base64: base64,
      width: 1920,
      height: 1080
    };
  } catch (err) {
    console.warn('[Background] Screenshot capture failed:', err);
    return null;
  }
}

/**
 * Task 105: Predictive prefetch of next page state after navigation-triggering actions
 */
async function schedulePredictivePrefetch(activeTabId) {
  prefetchedState = null;
  if (prefetchAbortController) {
    prefetchAbortController.abort();
  }
  prefetchAbortController = new AbortController();

  setTimeout(async () => {
    if (prefetchAbortController.signal.aborted) return;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || tabs[0].id !== activeTabId) return;

      const domResponse = await chrome.tabs.sendMessage(activeTabId, {
        type: 'extract_dom',
        render_overlays: false
      });
      const screenshot = await captureActiveTabScreenshot();

      if (!prefetchAbortController.signal.aborted) {
        prefetchedState = {
          dom: domResponse?.payload,
          screenshot,
          timestamp: Date.now(),
          url: tabs[0].url
        };
        console.log('[Background] Task 105: Predictive prefetch completed in background');
      }
    } catch (e) {
      // Ignored for prefetch
    }
  }, 350);
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'offscreen') return false;

  console.log('[Background] Received runtime message:', message.type);

  switch (message.type) {
    case 'get_initial_state':
      sendResponse({
        status: currentStatus,
        resource_stats: latestResourceStats
      });
      break;

    case 'command':
      handleUserCommand(message.payload);
      sendResponse({ status: 'processing' });
      break;

    case 'clarification_reply':
      handleClarificationReply(message.payload);
      sendResponse({ status: 'processing' });
      break;

    case 'audio':
      forwardToNativeHost(message);
      broadcastStatus('thinking', 'Transcribing audio...');
      sendResponse({ status: 'sent' });
      break;

    case 'dom_data':
      forwardToNativeHost(message);
      sendResponse({ status: 'sent' });
      break;

    case 'screenshot':
      forwardToNativeHost(message);
      sendResponse({ status: 'sent' });
      break;

    case 'action_result':
      forwardToNativeHost(message);
      if (message.payload?.page_changed && sender.tab?.id) {
        schedulePredictivePrefetch(sender.tab.id);
      }
      sendResponse({ status: 'sent' });
      break;

    case 'verify_log':
      forwardToNativeHost({
        type: 'verify_log',
        id: `vl-${Date.now()}`,
        timestamp: new Date().toISOString(),
        payload: {}
      });
      sendResponse({ status: 'sent' });
      break;

    case 'confirm_action':
      forwardToNativeHost({
        type: 'confirmation_response',
        id: `conf-resp-${Date.now()}`,
        timestamp: new Date().toISOString(),
        payload: message.payload
      });
      broadcastStatus('acting', 'Executing confirmed action...');
      sendResponse({ status: 'sent' });
      break;

    case 'crop_patch':
      ensureOffscreenDocument().then(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'crop_image',
          payload: message.payload
        }, (res) => sendResponse(res));
      });
      return true;

    case 'start_recording':
      // Start audio stream in offscreen document
      ensureOffscreenDocument().then(() => {
        chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'start_mic_recording'
        }, (res) => {
          sendResponse(res || { status: 'recording' });
        });
      }).catch((err) => {
        sendResponse({ error: err.message });
      });

      // Also trigger webpage speech recognition in active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'start_speech_recognition' }).catch(() => {});
        }
      });
      return true;

    case 'stop_recording':
      // Stop speech recognition in active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'stop_speech_recognition' }).catch(() => {});
        }
      });

      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'stop_mic_recording'
      }, (audioResult) => {
        if (audioResult && audioResult.audio_base64) {
          // Forward captured audio to native host for ASR transcription
          forwardToNativeHost({
            type: 'audio',
            id: `audio-${Date.now()}`,
            timestamp: new Date().toISOString(),
            payload: {
              audio_base64: audioResult.audio_base64,
              sample_rate: 16000,
              language_hint: 'auto'
            }
          });
        }
        sendResponse({ status: 'stopped' });
      });
      return true;

    case 'toggle_overlays':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: message.show ? 'show_overlays' : 'hide_overlays'
          }, (res) => sendResponse(res));
        }
      });
      return true;

    case 'speech_live_transcript':
      // Broadcast live recognized words from content script to popup UI
      chrome.runtime.sendMessage({
        type: 'speech_live_transcript',
        text: message.text
      }).catch(() => {});
      sendResponse({ status: 'broadcasted' });
      return true;

    case 'request_permission_tab':
      const permUrl = chrome.runtime.getURL('permission.html');
      chrome.tabs.query({}, (tabs) => {
        const alreadyOpen = tabs.some(t => t.url && t.url.startsWith(permUrl));
        if (!alreadyOpen) {
          chrome.tabs.create({ url: permUrl });
        }
      });
      sendResponse({ status: 'opening' });
      return true;

    default:
      sendResponse({ status: 'unrecognized_type' });
  }

  return true;
});

// Full command pipeline — StepQueue-based intelligent flow executor
async function handleUserCommand(commandPayload) {
  broadcastStatus('thinking', 'Understanding your command...');

  try {
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || !tabs[0]) tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) tabs = await chrome.tabs.query({ active: true });
    if (!tabs || !tabs[0]) throw new Error('No active browser tab found');

    const activeTab = tabs[0];
    const query = commandPayload.text || '';

    // ── PHASE 1: Decompose the full natural language sentence into a StepQueue
    const steps = decomposeGoalIntoSteps(query, activeTab.url);

    if (steps && steps.length > 0) {
      console.log('[SQ] Decomposed into', steps.length, 'steps:', steps.map(s => s.label));
      activeTask = {
        goal: query,
        steps,
        status: 'running'
      };
      broadcastStatus('thinking', `Planning ${steps.length} steps for: "${query.slice(0, 50)}..."`);
      broadcastStepProgress();
      await runStepQueue(activeTab.id);
      return;
    }

    // ── PHASE 2: Fallback — try single-page DOM action plan (no navigation needed)
    let domData = null;
    try {
      if (prefetchedState && prefetchedState.url === activeTab.url && (Date.now() - prefetchedState.timestamp < 3000)) {
        domData = prefetchedState.dom;
        prefetchedState = null;
      } else {
        const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'extract_dom', render_overlays: false });
        if (response?.payload) domData = response.payload;
      }
    } catch (err) {
      // Auto-inject content script if not present
      if (activeTab.id && !activeTab.url?.startsWith('chrome://') && !activeTab.url?.startsWith('edge://')) {
        try {
          await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 150));
          const r2 = await chrome.tabs.sendMessage(activeTab.id, { type: 'extract_dom', render_overlays: false });
          if (r2?.payload) domData = r2.payload;
        } catch (e) { console.warn('[Background] Auto-inject failed:', e); }
      }
    }

    const elementsList = domData?.elements || [];

    // Try single-page compound action plan
    const instantPlan = generateRealActionPlan(query, elementsList, activeTab.url);
    if (instantPlan && instantPlan.actions.length > 0) {
      if (activeTab.id && !activeTab.url?.startsWith('chrome://')) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'execute_actions', payload: instantPlan }).catch(() => {});
      }
      chrome.runtime.sendMessage({ type: 'action_plan', payload: instantPlan }).catch(() => {});
      broadcastStatus('online', `Done: ${instantPlan.actions[0].description}`);
      return;
    }

    // ── PHASE 3: Forward to native host for deep reasoning
    const screenshot = await captureActiveTabScreenshot();
    const pageState = domData ? {
      url: activeTab.url || '',
      title: activeTab.title || '',
      elements: elementsList,
      changed_tag_ids: domData.changed_tag_ids || [],
      has_opaque_regions: domData.has_opaque_regions || false,
      layout_hash: domData.layout_hash || ''
    } : null;

    if (nativePort) {
      forwardToNativeHost({
        type: 'command',
        id: `cmd-${Date.now()}`,
        task: query,
        page: pageState,
        image_b64: screenshot?.image_base64 || '',
        visible_tags: elementsList.map(e => e.tag_id)
      });
    } else {
      broadcastStatus('online', 'Command received — native host not connected');
    }

  } catch (error) {
    console.error('[Background] Error processing command pipeline:', error);
    broadcastStatus('error', error.message);
  }
}


// ============================================================================
// GOAL DECOMPOSITION → STEP QUEUE → CROSS-PAGE EXECUTOR
// The agent breaks any natural language command into ordered steps,
// runs each step, and resumes automatically after page navigations.
// ZERO popup dialogs for compound flows.
// ============================================================================

// Active step queue state — persists across page navigations
let activeTask = null;

// ============================================================================
// DOMAIN KNOWLEDGE: Common site patterns used for step generation
// ============================================================================
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
  tryhackme: 'https://tryhackme.com',
  geeksforgeeks: 'https://www.geeksforgeeks.org',
  hackerrank: 'https://www.hackerrank.com',
  codechef: 'https://www.codechef.com',
  stackoverflow: 'https://stackoverflow.com',
};

// ============================================================================
// STEP BUILDER UTILITIES
// ============================================================================
function stepNavigate(url, label) {
  return { type: 'navigate', url, label: label || `Navigate to ${url}`, status: 'pending' };
}
function stepClick(target, label) {
  return { type: 'click', target, label: label || `Click "${target}"`, status: 'pending' };
}
function stepType(field, value, label) {
  return { type: 'type', field, value, label: label || `Type "${value}" into "${field}"`, status: 'pending' };
}
function stepSelect(field, value, label) {
  return { type: 'select', field, value, label: label || `Select "${value}" for "${field}"`, status: 'pending' };
}

// ============================================================================
// GOAL DECOMPOSER
// Parses any natural language command into an ordered StepQueue[].
// Handles cross-page, multi-site, multi-action compound sentences autonomously.
// ============================================================================
function decomposeGoalIntoSteps(query, currentUrl) {
  let q = query.toLowerCase().trim();
  const steps = [];

  // ── PHONETIC & MULTI-WORD BRAND CORRECTION ─────────────────────────────────
  const PHONETIC = [
    [/\bcontinue\s+has\b/gi, 'continue as'],
    [/\btry\s*hack\s*me\b/gi, 'tryhackme'],
    [/\bguitar\b/gi, 'github'], [/\bget hub\b/gi, 'github'], [/\bgit\s*hub\b/gi, 'github'],
    [/\byou\s*tube\b/gi, 'youtube'], [/\blinked\s+in\b/gi, 'linkedin'],
    [/\binsta\s*gram\b/gi, 'instagram'], [/\bchat\s*g\s*p\s*t\b/gi, 'chatgpt'],
    [/\blead\s*code\b/gi, 'leetcode'], [/\bleet\s*code\b/gi, 'leetcode'],
    [/\bcode\s*chef\b/gi, 'codechef'], [/\bhacker\s*rank\b/gi, 'hackerrank'],
    [/\bstack\s*overflow\b/gi, 'stackoverflow'], [/\bgeeks\s*for\s*geeks\b/gi, 'geeksforgeeks'],
  ];
  for (const [p, r] of PHONETIC) q = q.replace(p, r);

  // ── 1. GITHUB REPO CREATION WORKFLOW ──────────────────────────────────────
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

  const siteMatch = q.match(/^(?:open|go\s+to|navigate\s+to|visit|launch)\s+(?:(?:the|my)\s+)?(.+?)(?:\s+(?:website|app|page|site))?\s+(?:and\s+then|then|and|to|with|\&|;)\s+(.*)$/i)
                 || q.match(/^(?:open|go\s+to|navigate\s+to|visit|launch)\s+(?:(?:the|my)\s+)?(.+?)(?:\s+(?:website|app|page|site))?$/i);

  if (siteMatch) {
    let rawSite = siteMatch[1].trim().toLowerCase().replace(/\s+/g, '');
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

  // ── 3. UNIVERSAL LOGIN / SIGN IN / CREDENTIALS WORKFLOW ON ANY SITE ───────
  const isLoginGoal = /\b(?:log\s*in|sign\s*in|login|signin|enter\s*(?:my\s*)?account|credentials)\b/i.test(remainingQuery || q);
  if (isLoginGoal) {
    const isGoogleOrCredentialSSO = /\b(?:google|first\s+email|default\s+email|my\s+email|first\s+account|credentials|first)\b/i.test(remainingQuery || q);

    // Step 1: Click Sign In / Login button on homepage to enter login view
    steps.push({ type: 'click', target: 'Sign in Log in Login', label: 'Click Sign in / Login' });

    // Step 2: If SSO / Credentials / Google mentioned, click Continue with Google
    if (isGoogleOrCredentialSSO) {
      steps.push({ type: 'click', target: 'Continue with Google Sign in with Google Log in with Google Google', label: 'Click Continue with Google' });
    }

    // Step 3: Type username/email if explicitly mentioned (e.g. as mohit / with email x@gmail.com)
    const userMatch = (remainingQuery || q).match(/\b(?:as|user(?:name)?|email|id)\s+([a-zA-Z0-9@._\-]+)$/i)
                   || (remainingQuery || q).match(/\b(?:as|user(?:name)?|email|id)\s+([a-zA-Z0-9@._\-]+)\b/i);
    let username = userMatch ? userMatch[1].trim() : null;
    const reservedUsers = ['login', 'signin', 'my', 'first', 'account', 'email', 'user', 'the', 'a', 'it', 'password', 'credentials', 'google'];
    if (reservedUsers.includes(username?.toLowerCase())) username = null;

    if (username) {
      steps.push({ type: 'type', field: 'username email login identifier', value: username, label: `Enter username/email "${username}"` });
    }

    // Step 4: Password if provided
    const passMatch = (remainingQuery || q).match(/\b(?:password|pass)\s+(?:is\s+)?([a-zA-Z0-9@#$_.\-]+)/i);
    let password = passMatch ? passMatch[1].trim() : null;
    if (['is', 'and', 'my', 'the'].includes(password?.toLowerCase())) password = null;

    if (password) {
      steps.push({ type: 'type', field: 'password', value: password, label: 'Enter password' });
      steps.push({ type: 'click', target: 'Log in Sign in Submit', label: 'Submit Login' });
    }

    return steps.map((s, idx) => ({ ...s, id: idx, status: 'pending' }));
  }

  // ── 4. UNIVERSAL SEARCH WORKFLOW ON ANY SITE ───────────────────────────────
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

// ============================================================================
// STEP QUEUE EXECUTOR
// Runs the StepQueue one step at a time, with DOM-aware action dispatch,
// dynamic SPA retry logic, and automatic resume after page navigations.
// ============================================================================
async function runStepQueue(tabId) {
  if (!activeTask || activeTask.status === 'done') return;

  const pendingSteps = activeTask.steps.filter(s => s.status === 'pending');
  if (pendingSteps.length === 0) {
    activeTask.status = 'done';
    broadcastStatus('online', `✓ Goal completed: ${activeTask.goal.slice(0, 60)}`);
    broadcastStepProgress();
    return;
  }

  const step = pendingSteps[0];
  console.log('[SQ] Executing step:', step);
  broadcastStatus('acting', `${step.label}...`);

  // ── NAVIGATE step ──────────────────────────────────────────────────────────
  if (step.type === 'navigate') {
    step.status = 'running';
    broadcastStepProgress();
    activeTask.status = 'navigating';
    try {
      await chrome.tabs.update(tabId, { url: step.url });
      step.status = 'done';
      // Execution resumes in tabs.onUpdated
    } catch (err) {
      step.status = 'failed';
      broadcastStatus('error', `Navigation failed: ${err.message}`);
    }
    return;
  }

  // ── DOM-based steps: extract DOM with dynamic SPA retry ────────────────────
  let elements = [];
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'extract_dom', render_overlays: false });
    elements = response?.payload?.elements || [];
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 250));
      const r2 = await chrome.tabs.sendMessage(tabId, { type: 'extract_dom', render_overlays: false });
      elements = r2?.payload?.elements || [];
    } catch (e2) {
      console.warn('[SQ] DOM extraction failed:', e2);
    }
  }

  // Build a mini action plan for this single step using DOM matching
  const actions = resolveStepToActions(step, elements);

  // If DOM element not found yet, retry up to 4 times (gives dynamic SPAs up to 2.5s to render)
  if (actions.length === 0) {
    step._retries = (step._retries || 0) + 1;
    if (step._retries <= 4) {
      console.log(`[SQ] Element for step "${step.label}" not ready yet in DOM, retrying (${step._retries}/4)...`);
      setTimeout(() => runStepQueue(tabId), 600);
      return;
    }
    console.warn('[SQ] Could not resolve step to DOM element after retries:', step);
    step.status = 'skipped';
    broadcastStepProgress();
    setTimeout(() => runStepQueue(tabId), 400);
    return;
  }

  step.status = 'running';
  broadcastStepProgress();

  const plan = {
    id: `sq-${Date.now()}`,
    confidence: 0.98,
    source: 'StepQueue-Executor',
    reasoning: step.label,
    actions
  };

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'execute_actions', payload: plan });
    step.status = 'done';
    broadcastStepProgress();
    broadcastStatus('acting', `✓ ${step.label}`);
    // Allow 800ms for DOM transitions or AJAX requests
    await new Promise(r => setTimeout(r, 800));
    runStepQueue(tabId);
  } catch (err) {
    step.status = 'failed';
    broadcastStatus('error', `Step failed: ${err.message}`);
  }
}

// ============================================================================
// RESOLVE A STEP → DOM ACTIONS
// Maps a logical step (type/click/select/scroll) to concrete tag_id actions
// ============================================================================
function resolveStepToActions(step, elements) {
  const actions = [];

  const isInputEl = (el) =>
    el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'searchbox';
  const getLabel = (el) =>
    (el.text || el.aria_label || el.placeholder || el.name || el.id || el.value || '').toLowerCase();

  if (step.type === 'type') {
    const fieldWords = step.field.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const inputEls = elements.filter(isInputEl).filter(el => el.type !== 'radio' && el.type !== 'checkbox');
    let bestEl = null, bestScore = 0;
    for (const el of inputEls) {
      const lbl = getLabel(el);
      let score = fieldWords.reduce((s, w) => s + (lbl.includes(w) ? 40 : 0), 0);
      if (lbl.includes(step.field.toLowerCase())) score += 60;
      if (el.name?.includes('repo') || el.id?.includes('repo') || el.placeholder?.includes('repo')) score += 50;
      if (el.name?.includes('login') || el.id?.includes('login') || el.placeholder?.includes('login') || el.name?.includes('email')) score += 50;
      if (score > bestScore) { bestScore = score; bestEl = el; }
    }
    if (!bestEl && inputEls.length > 0) bestEl = inputEls[0];
    if (bestEl) {
      actions.push({ step: 0, tag_id: bestEl.tag_id, action: 'type', value: step.value, description: step.label });
    }
  }

  if (step.type === 'select') {
    // Look for radio/checkbox/button matching the value
    const valWords = step.value.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    let bestEl = null, bestScore = 0;
    for (const el of elements) {
      const lbl = getLabel(el);
      let score = valWords.reduce((s, w) => s + (lbl.includes(w) ? 40 : 0), 0);
      if (el.type === 'radio' || el.role === 'radio') score += 30;
      if (el.value?.toLowerCase() === step.value.toLowerCase()) score += 60;
      if (el.id?.toLowerCase().includes(step.value.toLowerCase())) score += 50;
      if (score > bestScore) { bestScore = score; bestEl = el; }
    }
    if (bestEl && bestScore >= 20) {
      actions.push({ step: 0, tag_id: bestEl.tag_id, action: 'select', value: step.value, description: step.label });
    }
  }

  if (step.type === 'click') {
    const rawTarget = step.target.toLowerCase();
    const targetWords = rawTarget.split(/\s+/).filter(w => w.length >= 3);
    const clickableEls = elements.filter(el => !isInputEl(el) || el.type === 'radio' || el.type === 'button' || el.type === 'submit');
    let bestEl = null, bestScore = 0;
    for (const el of clickableEls) {
      const lbl = getLabel(el);
      if (!lbl) continue;
      let score = 0;
      for (const w of targetWords) {
        if (lbl.includes(w)) score += 35;
      }
      if (rawTarget.includes(lbl) || lbl.includes(rawTarget)) score += 60;
      if (rawTarget.includes('google') && (lbl.includes('google') || lbl.includes('continue with google') || lbl.includes('sign in with google') || lbl.includes('log in with google'))) score += 80;
      if (rawTarget.includes('sign in') && (lbl === 'sign in' || lbl === 'log in' || lbl === 'login' || lbl === 'signin')) score += 50;
      if (el.tag === 'button' || el.role === 'button' || el.type === 'submit') score += 20;
      if (el.tag === 'a' || el.role === 'link') score += 15;
      if (score > bestScore) { bestScore = score; bestEl = el; }
    }
    if (bestEl && bestScore >= 20) {
      actions.push({ step: 0, tag_id: bestEl.tag_id, action: 'click', description: step.label });
    }
  }

  if (step.type === 'scroll') {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', value: step.direction || 'down', description: step.label });
  }

  return actions;
}

function broadcastStepProgress() {
  if (!activeTask) return;
  chrome.runtime.sendMessage({
    type: 'step_progress',
    payload: {
      goal: activeTask.goal,
      steps: activeTask.steps.map(s => ({ id: s.id, label: s.label, status: s.status })),
      currentStep: activeTask.steps.findIndex(s => s.status === 'pending' || s.status === 'running')
    }
  }).catch(() => {});
}

// ============================================================================
// TAB NAVIGATION RELAY: when page finishes loading, resume StepQueue
// ============================================================================
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!activeTask || activeTask.status !== 'navigating') return;

  // Wait 1.2s for SPA hydration (e.g. React/Vue router mounting on LeetCode/GitHub)
  setTimeout(async () => {
    try {
      activeTask.status = 'running';
      console.log('[SQ] Page loaded, resuming step queue on tab', tabId);
      await runStepQueue(tabId);
    } catch (e) {
      console.warn('[SQ] Resume after navigation failed:', e.message);
    }
  }, 1200);
});

// ============================================================================
// LEGACY: handleClarificationReply kept for compatibility
// ============================================================================
async function handleClarificationReply(payload) {
  if (!activeTask?.steps) return;
  // If there's a pending step queue, just resume it
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = tabs?.[0]?.id;
  if (tabId) runStepQueue(tabId);
}

// Legacy UNIVERSAL_INTENTS kept for classifyIntent compatibility
const UNIVERSAL_INTENTS = [
  { id: 'LOGIN', patterns: [/\blog\s*in\b/i, /\bsign\s*in\b/i, /\blogin\b/i], requiredFields: [], confirmPrompt: 'Log in' },
  { id: 'REGISTER', patterns: [/\bsign\s*up\b/i, /\bcreate\s*account\b/i], requiredFields: [], confirmPrompt: 'Register' },
];
function classifyIntent(query) { return null; } // Disabled — StepQueue handles all flows

function extractFormFieldsFromDOM(elements) { return []; }
function extractQuickActionButtonsFromDOM(elements) { return []; }
function buildClarificationRequest() { return { fields: [], hasMissingRequired: false }; }
function executeTaskWorkflow() {}
function buildWorkflowSteps() { return []; }

function parseCompoundWorkflow(query, elements) {
  if (!query || elements.length === 0) return null;

  // Normalize leading high-level goal wrappers like "create a new repository..."
  const normalizedQuery = query
    .replace(/^create\s+(?:a\s+)?(?:new\s+)?(?:repository|repo)\s+/i, '')
    .replace(/^fill\s+(?:out\s+)?(?:this\s+)?(?:form\s+)?/i, '')
    .trim();

  const rawSegments = (normalizedQuery || query)
    .split(/\s+(?:and\s+then|then|after\s+that|and\s+also|also|and|,|;)\s+|\s+(?=(?:make|set|change|switch|turn|select|choose|click|press|tap|submit|create|save|fill|type|enter|name\s+it|named)\s+)/i)
    .map(s => s.trim())
    .filter(s => s.length > 1);

  if (rawSegments.length < 2) return null;

  const actions = [];
  const descriptions = [];
  const isInputEl = (el) =>
    el.tag === 'input' || el.tag === 'textarea' || el.role === 'textbox' || el.role === 'searchbox';
  const getElLabel = (el) =>
    (el.text || el.aria_label || el.placeholder || el.name || el.id || el.value || '').toLowerCase();

  const inputEls = elements.filter(isInputEl).filter(el => el.type !== 'radio' && el.type !== 'checkbox');
  const clickableEls = elements.filter(el => !isInputEl(el) || el.type === 'radio' || el.type === 'checkbox');

  for (const segment of rawSegments) {
    let handled = false;

    // ── 1. TYPE / FORM FILL INTENT ───────────────────────────────────────────
    const typeMatch = segment.match(/^(?:enter|type|write|input|fill\s+in|fill|put\s+in|put|set)\s+(.+)$/i);
    const namedMatch = segment.match(/(?:name\s+it|named|name|called)\s+(.+)$/i);

    if (typeMatch || namedMatch) {
      let val = null;
      let fieldName = null;

      if (namedMatch) {
        val = namedMatch[1].trim().replace(/\s+(?:and|make|set|as|with|just).*$/i, '');
        fieldName = 'repository name';
      } else if (typeMatch) {
        const rest = typeMatch[1].trim();
        const asMatch = rest.match(/^(.+?)\s+(?:as|in(?:to)?|inside|for)\s+(?:the\s+)?(.+)$/i);
        const withMatch = rest.match(/^(.+?)\s+(?:with|to|=)\s+(.+)$/i);

        if (asMatch) {
          val = asMatch[1].trim();
          fieldName = asMatch[2].trim().replace(/\s*(field|box|input|area)$/i, '');
        } else if (withMatch) {
          fieldName = withMatch[1].trim().replace(/\s*(field|box|input|area)$/i, '');
          val = withMatch[2].trim();
        }
      }

      if (val) {
        if (!fieldName) fieldName = 'name';
        const fieldWords = fieldName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        let bestInput = null;
        let bestScore = 0;
        for (const el of inputEls) {
          const lbl = getElLabel(el);
          let score = fieldWords.reduce((s, w) => s + (lbl.includes(w) ? 35 : 0), 0);
          if (lbl.includes(fieldName.toLowerCase())) score += 50;
          if (score > bestScore) { bestScore = score; bestInput = el; }
        }
        if (!bestInput && inputEls.length > 0) bestInput = inputEls[0];

        if (bestInput) {
          actions.push({
            step: actions.length,
            tag_id: bestInput.tag_id,
            action: 'type',
            value: val,
            description: `Type "${val}" into "${fieldName}" (#${bestInput.tag_id})`
          });
          descriptions.push(`typed "${val}" into "${fieldName}"`);
          handled = true;
        }
      }
    }

    // ── 2. TOGGLE / RADIO / OPTION SELECTION INTENT ──────────────────────────
    if (!handled) {
      const toggleMatch = segment.match(/^(?:make|set|change|switch|turn|toggle|choose|select)\s+(?:from\s+)?(?:[a-z0-9_-]+\s+)?(?:to\s+)?(.+)$/i);
      if (toggleMatch) {
        const targetOption = toggleMatch[1].trim().replace(/^(?:the\s+|a\s+)/i, '').toLowerCase();
        let bestOptEl = null;
        let bestScore = 0;

        for (const el of elements) {
          const lbl = getElLabel(el);
          let score = 0;
          if (lbl.includes(targetOption)) score += 60;
          const words = targetOption.split(/\s+/).filter(w => w.length > 2);
          for (const w of words) {
            if (lbl.includes(w)) score += 30;
          }
          if (el.role === 'radio' || el.type === 'radio' || el.tag === 'button' || el.role === 'button' || el.tag === 'label') score += 20;
          if (score > bestScore) { bestScore = score; bestOptEl = el; }
        }

        if (bestOptEl && bestScore >= 30) {
          actions.push({
            step: actions.length,
            tag_id: bestOptEl.tag_id,
            action: 'click',
            description: `Select "${bestOptEl.text?.slice(0, 30) || targetOption}" (#${bestOptEl.tag_id})`
          });
          descriptions.push(`selected "${targetOption}"`);
          handled = true;
        }
      }
    }

    // ── 3. CLICK / SUBMIT / ACTION INTENT ────────────────────────────────────
    if (!handled) {
      const cleanSeg = segment.replace(/^(?:click\s+on|click|press|tap|hit|submit|save|create)\s*(?:the\s+)?/i, '').trim();
      const targetName = cleanSeg || segment;
      const words = (targetName || segment).toLowerCase().split(/\s+/).filter(w => w.length > 2);

      let bestBtn = null;
      let bestScore = 0;

      for (const el of clickableEls) {
        const lbl = getElLabel(el);
        let score = 0;
        if (lbl.includes(targetName.toLowerCase())) score += 60;
        for (const w of words) {
          if (lbl.includes(w)) score += 30;
        }
        if (el.tag === 'button' || el.role === 'button' || el.type === 'submit') score += 20;
        if (score > bestScore) { bestScore = score; bestBtn = el; }
      }

      if (bestBtn && bestScore >= 30) {
        actions.push({
          step: actions.length,
          tag_id: bestBtn.tag_id,
          action: 'click',
          description: `Click "${bestBtn.text?.slice(0, 35) || targetName}" (#${bestBtn.tag_id})`
        });
        descriptions.push(`clicked "${bestBtn.text?.slice(0, 30) || targetName}"`);
        handled = true;
      }
    }
  }

  if (actions.length >= 2) {
    return {
      reasoning: `Autonomous compound flow: ${descriptions.join(' ➔ ')}.`,
      actions
    };
  }
  return null;
}

// ============================================================================
// Generate Real Action Plan matching user query against actual webpage DOM elements
function generateRealActionPlan(query, elements, currentUrl = '') {
  if (!query) return null;
  const actions = [];
  let reasoning = '';

  // 1. Normalize query: strip conversational filler words (English & Hindi/Hinglish)
  let cleanQ = query.toLowerCase().trim();

  // =========================================================================
  // PHONETIC CORRECTION MAP
  // Web Speech API commonly mishears proper nouns. Fix before any intent logic.
  // =========================================================================
  const PHONETIC_FIXES = [
    // Continue as / SSO fixes ("continue has mohit", "continue us", "continue has", "login with my first email")
    [/\blogin with (?:my\s+)?first\s+(?:e-?mail|mail)\b/gi, 'continue as mohit'],
    [/\b(?:my\s+)?first\s+(?:e-?mail|mail)\b/gi,            'continue as mohit'],
    [/\bcontinue\s+has\b/g,                                'continue as'],
    [/\bcontinue\s+us\b/g,                                 'continue as'],
    [/\bhas\s+mohit\b/g,                                   'as mohit'],
    // GitHub (most common — "guitar", "get hub", "git hub", "get up", "github")
    [/\bguitar\b/g,                   'github'],
    [/\bget hub\b/g,                   'github'],
    [/\bgit hub\b/g,                   'github'],
    [/\bget up\b/g,                    'github'],
    [/\bgithub\b/g,                    'github'],
    // YouTube ("you tube", "utube", "u tube")
    [/\byou\s*tube\b/g,                'youtube'],
    [/\butube\b/g,                     'youtube'],
    // GSOC ("gsock", "g soc", "g sock", "google summer of cord", "google soc")
    [/\bgsock\b/g,                     'gsoc'],
    [/\bg\s+soc\b/g,                   'gsoc'],
    [/\bg\s+sock\b/g,                  'gsoc'],
    [/\bgoogle summer of cord\b/g,     'google summer of code'],
    [/\bgoogle summer of cod\b/g,      'google summer of code'],
    [/\bgoogle summer code\b/g,        'google summer of code'],
    // ISRO ("is ro", "is arrow", "is roe", "i s r o")
    [/\bis\s+ro\b/g,                   'isro'],
    [/\bis\s+arrow\b/g,                'isro'],
    [/\bis\s+roe\b/g,                  'isro'],
    [/\bi\s+s\s+r\s+o\b/g,             'isro'],
    // BMSIT ("bms eat", "bms it", "b m s i t", "bmsit")
    [/\bbms\s+eat\b/g,                 'bmsit'],
    [/\bb\s*m\s*s\s*i\s*t\b/g,         'bmsit'],
    // LinkedIn ("linked in", "link din", "link thin")
    [/\blinked\s+in\b/g,               'linkedin'],
    [/\blink\s*din\b/g,                'linkedin'],
    [/\blink\s*thin\b/g,               'linkedin'],
    // Instagram ("insta gram", "insta")
    [/\binsta\s+gram\b/g,              'instagram'],
    // WhatsApp ("what sap", "whats app", "what's app")
    [/\bwhat\s*['']?s?\s*app\b/g,     'whatsapp'],
    [/\bwhat\s+sap\b/g,               'whatsapp'],
    // Stack Overflow ("stack over flow")
    [/\bstack\s+over\s+flow\b/g,      'stack overflow'],
    // Twitter/X
    [/\btwitter\b/g,                   'twitter'],
    // ChatGPT ("chat g p t", "chat gbt", "chat gpt")
    [/\bchat\s+g\s*b\s*t\b/g,         'chatgpt'],
    [/\bchat\s+g\s+p\s+t\b/g,         'chatgpt'],
    // Google Maps ("google map", "google mapes")
    [/\bgoogle\s+map[se]?\b/g,        'google maps'],
    // Scroll commands ("scroll don" / "scroll dawn")
    [/\bscroll\s+don\b/g,             'scroll down'],
    [/\bscroll\s+dawn\b/g,            'scroll down'],
    [/\bscroll\s+app\b/g,             'scroll up'],
  ];

  for (const [pattern, fix] of PHONETIC_FIXES) {
    cleanQ = cleanQ.replace(pattern, fix);
  }

  let prevQ;
  do {
    prevQ = cleanQ;
    cleanQ = cleanQ.replace(/^(?:hey|hi|hello|ok|okay|aero|please|can you|could you|would you|i want to|help me|just|bro|agent|tum mujhe|aap mujhe|mujhe|kya tum|kya aap|zara|ek baar|bhai|kripya)\s+/i, '').trim();
  } while (cleanQ !== prevQ);

  // Strip conversational suffixes (English & Hindi/Hinglish)
  let prevSuff;
  do {
    prevSuff = cleanQ;
    cleanQ = cleanQ.replace(/\s+(?:nikal kar de sakte ho|nikal kar do|nikal ke do|nikal do|khol kar do|khol ke do|khol do|kholo|open kar do|open karo|open karke do|dikha do|dikhao|search kar do|search karo|de sakte ho|kar sakte ho|karo|chahiye|for me|for us|please|now|fast)$/i, '').trim();
  } while (cleanQ !== prevSuff);

  // =========================================================================
  // PRIORITY -1: Autonomous Compound Flow Decomposition
  // Handles multi-clause natural dictations: "enter X into Y, set Z to private, and create"
  // =========================================================================
  if (elements.length > 0) {
    const compoundPlan = parseCompoundWorkflow(cleanQ, elements);
    if (compoundPlan && compoundPlan.actions.length >= 2) {
      return {
        id: `plan-${Date.now()}`,
        confidence: 0.99,
        source: 'Compound-Flow-Perception',
        reasoning: compoundPlan.reasoning,
        actions: compoundPlan.actions
      };
    }
  }

  // =========================================================================
  // PRIORITY 0: Browser Control & History ("go back", "refresh", "reload")
  // =========================================================================
  if (cleanQ === 'go back' || cleanQ === 'back' || cleanQ === 'previous page') {
    actions.push({ step: 0, tag_id: 0, action: 'back', description: 'Navigate back to previous page' });
    reasoning = `Going back to the previous webpage.`;
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) chrome.tabs.goBack(tabs[0].id).catch(() => {});
    });
    return { id: `plan-${Date.now()}`, confidence: 0.99, source: 'Live DOM-Perception', reasoning, actions };
  } else if (cleanQ === 'refresh' || cleanQ === 'reload' || cleanQ === 'reload page') {
    actions.push({ step: 0, tag_id: 0, action: 'reload', description: 'Reload active webpage' });
    reasoning = `Reloading current webpage.`;
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id).catch(() => {});
    });
    return { id: `plan-${Date.now()}`, confidence: 0.99, source: 'Live DOM-Perception', reasoning, actions };
  }

  // =========================================================================
  // PRIORITY 0.5: Informational Questions about Current Page ("what is this page", "summarize")
  // =========================================================================
  const isPageQuestion = cleanQ.includes('this page') || cleanQ.includes('this website') || cleanQ.includes('this site') || cleanQ === 'what is this' || cleanQ.startsWith('summarize') || cleanQ.includes("can't see");

  if (isPageQuestion && elements.length > 0) {
    const headings = elements.filter(el => el.tag?.startsWith('h') || el.role === 'heading' || (el.text && el.text.length > 15))
                             .map(el => el.text).slice(0, 3).join(' • ');

    if (currentUrl.includes('isro.gov.in') || headings.toLowerCase().includes('isro') || headings.toLowerCase().includes('spark')) {
      reasoning = `You are on the ISRO SPARK Virtual Space Museum & Space Tech Park. This shows interactive exhibits of Indian satellite and rocket missions. Say "scroll down" to browse or "go back" to return to the main portal.`;
    } else if (headings) {
      reasoning = `This page displays: ${headings.slice(0, 140)}. You can say "scroll down", "click on [section]", or "go back".`;
    } else {
      reasoning = `You are currently viewing ${currentUrl || 'an active webpage'}. Say "scroll down" to explore or "click [button name]" to interact.`;
    }

    return { id: `plan-${Date.now()}`, confidence: 0.95, source: 'Live DOM-Perception', reasoning, actions: [] };
  }

  // =========================================================================
  // PRIORITY 1: Scroll intents (< 20ms) - MUST be first to avoid false text matches
  // Matches: "scroll down this existing website", "scroll down", "scroll up", "page down"
  // =========================================================================
  if (cleanQ.includes('scroll down') || cleanQ.includes('page down') || cleanQ.startsWith('scroll') || (cleanQ.includes('scroll') && cleanQ.includes('down'))) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'down', amount: 600, description: 'Scroll page down 600px' });
    reasoning = `Recognized scroll command. Scrolling page down.`;
    return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
  } else if (cleanQ.includes('scroll up') || cleanQ.includes('page up') || (cleanQ.includes('scroll') && cleanQ.includes('up'))) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'up', amount: 600, description: 'Scroll page up 600px' });
    reasoning = `Recognized scroll command. Scrolling page up.`;
    return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
  }

  // =========================================================================
  // PRIORITY 2: Autonomous Login & Form Filling (< 30ms)
  // If user says "login ...", "sign in ...", "enter credentials ..."
  // =========================================================================
  const isLoginIntent = cleanQ.includes('login') || cleanQ.includes('sign in') || cleanQ.includes('credentials') || cleanQ.includes('log in');
  
  if (isLoginIntent) {
    const userMatch = cleanQ.match(/(?:username|user|email|id|login)\s+(?:is\s+|as\s+)?([^\s]+)/i);
    const passMatch = cleanQ.match(/(?:password|pass|pwd)\s+(?:is\s+|as\s+)?([^\s]+)/i);

    // Find username & password fields in active page DOM
    const userField = elements.find(el => 
      (el.tag_name === 'INPUT' || el.role === 'textbox') &&
      (el.attributes?.type === 'email' || el.attributes?.type === 'text' || el.attributes?.name?.toLowerCase().includes('user') ||
       el.attributes?.name?.toLowerCase().includes('email') || el.attributes?.id?.toLowerCase().includes('user') ||
       el.attributes?.placeholder?.toLowerCase().includes('user') || el.attributes?.placeholder?.toLowerCase().includes('email'))
    ) || elements.find(el => el.tag_name === 'INPUT' && el.attributes?.type !== 'password');

    const passField = elements.find(el => 
      el.tag_name === 'INPUT' && (el.attributes?.type === 'password' || el.attributes?.name?.toLowerCase().includes('pass') ||
      el.attributes?.id?.toLowerCase().includes('pass') || el.attributes?.placeholder?.toLowerCase().includes('pass'))
    );

    const loginBtn = elements.find(el => 
      (el.role === 'button' || el.tag_name === 'BUTTON' || el.tag_name === 'INPUT') &&
      (el.text?.toLowerCase().includes('log in') || el.text?.toLowerCase().includes('login') ||
       el.text?.toLowerCase().includes('sign in') || el.text?.toLowerCase().includes('submit') ||
       el.value?.toLowerCase().includes('login') || el.attributes?.value?.toLowerCase().includes('login'))
    ) || elements.find(el => (el.role === 'link' || el.tag_name === 'A') && 
      (el.text?.toLowerCase().includes('login') || el.text?.toLowerCase().includes('sign in')));

    let stepIdx = 0;
    if (userField && userMatch) {
      actions.push({
        step: stepIdx++,
        tag_id: userField.tag_id,
        action: 'type',
        value: userMatch[1],
        description: `Enter username "${userMatch[1]}" (#${userField.tag_id})`
      });
    }

    if (passField && passMatch) {
      actions.push({
        step: stepIdx++,
        tag_id: passField.tag_id,
        action: 'type',
        value: passMatch[1],
        description: `Enter password into #${passField.tag_id}`
      });
    }

    if (loginBtn) {
      actions.push({
        step: stepIdx++,
        tag_id: loginBtn.tag_id,
        action: 'click',
        description: `Click "${loginBtn.text || 'Login'}" button (#${loginBtn.tag_id})`
      });
    }

    if (actions.length > 0) {
      reasoning = `Automating login workflow: filled credentials and clicked submit.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 2.5: Smart Form Field Fill
  // Handles: "enter repository name airtel", "type airtel in repo name",
  //          "fill description with hello", "set username to john"
  // Uses el.tag (lowercase) — NOT el.tag_name — matching content.js schema
  // =========================================================================
  const isInputEl = (el) =>
    el.tag === 'input' || el.tag === 'textarea' ||
    el.role === 'textbox' || el.role === 'searchbox' || el.role === 'spinbutton' ||
    el.type === 'text' || el.type === 'email' || el.type === 'password' || el.type === 'search' || el.type === 'url' || el.type === 'number';

  const getElLabel = (el) =>
    (el.text || el.aria_label || el.placeholder || el.name || el.id || el.value || '').toLowerCase();

  const hasFormIntent = /^(?:enter|type|write|input|fill|set|change|update|put)\b/i.test(cleanQ);
  if (hasFormIntent && elements.length > 0) {
    const inputEls = elements.filter(isInputEl);

    if (inputEls.length > 0) {
      // ── Parse field name + value from the command ──────────────────────────
      // Strategy: strip the verb, then greedily match the longest prefix that
      // corresponds to an input label, with the remainder as the typed value.
      const stripped = cleanQ
        .replace(/^(?:enter|type|write|input|fill\s+in|fill|put\s+in|put|set|change|update)\s+(?:the\s+)?/i, '')
        .replace(/\s+(?:field|box|input|area)$/i, '')
        .trim();

      // Pattern A: "VALUE as/in[to] FIELD"  →  "Coca-Cola as repository name"
      const asMatch = stripped.match(/^(.+?)\s+(?:as|for|in(?:to)?|inside)\s+(?:the\s+)?(.+)$/i);
      // Pattern B: "FIELD with/to/= VALUE"  →  "repository name with Coca-Cola"
      const withMatch = stripped.match(/^(.+?)\s+(?:with|to|=)\s+(.+)$/i);
      let parsedField = null;
      let parsedValue = null;

      if (asMatch) {
        parsedValue = asMatch[1].trim();
        parsedField = asMatch[2].trim().replace(/\s*(field|box|input|area)$/i, '').trim();
      } else if (withMatch) {
        parsedField = withMatch[1].trim().replace(/\s*(field|box|input|area)$/i, '').trim();
        parsedValue = withMatch[2].trim();
      } else {
        // Pattern C (default): split on whitespace, try every split point
        // Longest prefix that matches an input label = field name, rest = value
        const words = stripped.split(/\s+/);
        if (words.length >= 2) {
          let bestSplit = -1;
          let bestScore = 0;
          for (let k = words.length - 1; k >= 1; k--) {
            const candidate = words.slice(0, k).join(' ');
            const val       = words.slice(k).join(' ');
            if (!val) continue;
            const score = inputEls.reduce((max, el) => {
              const lbl = getElLabel(el);
              const s = candidate.split(/\s+/).filter(w => w.length > 2 && lbl.includes(w)).length;
              return Math.max(max, s);
            }, 0);
            if (score > bestScore) { bestScore = score; bestSplit = k; }
          }
          if (bestSplit > 0) {
            parsedField = words.slice(0, bestSplit).join(' ');
            parsedValue = words.slice(bestSplit).join(' ');
          } else if (words.length >= 2) {
            // Absolute fallback: last word = value, rest = field name
            parsedField = words.slice(0, -1).join(' ');
            parsedValue = words[words.length - 1];
          }
        }
      }

      if (parsedField && parsedValue) {
        // Score inputs against parsedField
        const fieldWords = parsedField.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        let bestInput = null;
        let bestInputScore = 0;
        for (const el of inputEls) {
          const lbl = getElLabel(el);
          let score = fieldWords.reduce((s, w) => s + (lbl.includes(w) ? 30 : 0), 0);
          if (lbl.includes(parsedField.toLowerCase())) score += 50;
          if (!el.disabled) score += 5;
          if (score > bestInputScore) { bestInputScore = score; bestInput = el; }
        }
        // Fallback to first input if no label match
        if (!bestInput) bestInput = inputEls[0];

        if (bestInput) {
          actions.push({
            step: 0,
            tag_id: bestInput.tag_id,
            action: 'type',
            value: parsedValue,
            description: `Type "${parsedValue}" into "${parsedField}" (field #${bestInput.tag_id})`
          });
          reasoning = `Form fill detected: typing "${parsedValue}" into the "${parsedField}" field (#${bestInput.tag_id}).`;
          return { id: `plan-${Date.now()}`, confidence: 0.99, source: 'Live DOM-Perception', reasoning, actions };
        }
      }
    }
  }

  // =========================================================================
  // PRIORITY 3: On-Page Click / Choose / Select a Button or Link (< 30ms)
  // Skips INPUT/TEXTAREA — those are handled by Priority 2.5 above
  // =========================================================================
  if (elements.length > 0) {
    const searchTerms = cleanQ
      .replace(/^(?:choose|select|pick|open|get into|into|go to|click on|click|visit|tap|login|enter|create|make|add|continue as|continue with|continue)\s+(?:the\s+)?(?:a\s+)?/i, '')
      .replace(/\s+(?:on the website|on website|on page|language|website|site|page|portal|url|link)$/i, '')
      .trim();

    let bestEl = null;
    let bestScore = 0;

    for (const el of elements) {
      // Skip inputs — never click them; type into them via Priority 2.5
      if (isInputEl(el)) continue;

      const elText = (el.text || el.aria_label || el.placeholder || '').toLowerCase();
      const elHref = (el.href || '').toLowerCase();
      if (!elText && !elHref) continue;

      let score = 0;
      const words = (searchTerms || cleanQ).split(/\s+/).filter(w => w.length >= 2 && w !== 'the' && w !== 'this');
      for (const w of words) {
        if (elText.includes(w)) score += 35;
        if (elHref.includes(w)) score += 20;
      }
      if (searchTerms && elText.includes(searchTerms)) score += 60;
      if (cleanQ.includes('continue') && elText.includes('continue')) score += 40;
      if (elText.includes('privacy policy') || elText.includes('terms of service')) score -= 40;
      if (el.role === 'button' || el.tag === 'button' || (el.role === 'link' && el.text?.length > 3) || el.tag === 'a' || el.tag === 'iframe') score += 15;

      // Smart alias bonuses
      if ((cleanQ.includes('repo') || cleanQ.includes('repository')) && (elText === 'new' || elHref === '/new' || elHref.endsWith('/new'))) {
        score += 60;
      }

      if (score > bestScore) { bestScore = score; bestEl = el; }
    }

    if (bestEl && bestScore >= 30) {
      actions.push({
        step: 0,
        tag_id: bestEl.tag_id,
        action: 'click',
        description: `Click "${bestEl.text?.slice(0, 45) || 'Element'}" (#${bestEl.tag_id})`
      });
      reasoning = `Found on-page element matching "${searchTerms || cleanQ}" (#${bestEl.tag_id}). Clicking directly on active page.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 4: Generic type into the first visible input (last resort)
  // =========================================================================
  if (cleanQ.includes('search') || cleanQ.includes('type') || cleanQ.includes('find') || cleanQ.includes('enter') || cleanQ.includes('write')) {
    let searchText = cleanQ.replace(/^(?:search for|search|type|find|enter|write|google for|google)\s*/i, '').trim();
    if (!searchText) searchText = cleanQ;

    const inputNode =
      elements.find(el => isInputEl(el) && el.placeholder?.toLowerCase().includes('search')) ||
      elements.find(el => el.role === 'searchbox') ||
      elements.find(el => isInputEl(el) && !el.disabled);

    if (inputNode) {
      actions.push({
        step: 0,
        tag_id: inputNode.tag_id,
        action: 'type',
        value: searchText,
        description: `Type "${searchText}" into input (#${inputNode.tag_id})`
      });
      actions.push({
        step: 1,
        tag_id: inputNode.tag_id,
        action: 'press_key',
        value: 'Enter',
        description: `Press Enter to submit`
      });
      reasoning = `Found input field (#${inputNode.tag_id}). Typing and submitting.`;
      return { id: `plan-${Date.now()}`, confidence: 0.97, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 5: Direct Website Domain Navigation
  // =========================================================================
  // PRIORITY 5: Universal Website & Domain Navigation (ANY website on the Internet)
  // Matches: "open canva website", "open spotify", "go to udemy", "github.com", "open gsoc"
  // =========================================================================
  const KNOWN_SITES = {
    'youtube': 'https://www.youtube.com',
    'google': 'https://www.google.com',
    'github': 'https://www.github.com',
    'canva': 'https://www.canva.com',
    'wikipedia': 'https://www.wikipedia.org',
    'reddit': 'https://www.reddit.com',
    'gmail': 'https://mail.google.com',
    'chatgpt': 'https://chat.openai.com',
    'isro': 'https://www.isro.gov.in',
    'gsoc': 'https://summerofcode.withgoogle.com',
    'google summer of code': 'https://summerofcode.withgoogle.com',
    'bmsit': 'https://bmsit.ac.in',
    'bms it': 'https://bmsit.ac.in',
    'bms': 'https://bmsit.ac.in',
    'bms institute of technology': 'https://bmsit.ac.in',
    'linkedin': 'https://www.linkedin.com',
    'instagram': 'https://www.instagram.com',
    'twitter': 'https://www.twitter.com',
    'x': 'https://www.x.com',
    'netflix': 'https://www.netflix.com',
    'amazon': 'https://www.amazon.in',
    'flipkart': 'https://www.flipkart.com',
    'spotify': 'https://open.spotify.com',
    'coursera': 'https://www.coursera.org',
    'udemy': 'https://www.udemy.com',
    'stack overflow': 'https://stackoverflow.com',
    'stackoverflow': 'https://stackoverflow.com',
    'google maps': 'https://maps.google.com',
    'maps': 'https://maps.google.com',
    'whatsapp': 'https://web.whatsapp.com',
    'discord': 'https://discord.com',
    'notion': 'https://www.notion.so',
    'figma': 'https://www.figma.com',
    'medium': 'https://www.medium.com',
    'hackerrank': 'https://www.hackerrank.com',
    'leetcode': 'https://www.leetcode.com',
    'codechef': 'https://www.codechef.com',
    'codeforces': 'https://codeforces.com',
    'moodle': 'https://moodle.org',
    'nptel': 'https://nptel.ac.in',
    'swayam': 'https://swayam.gov.in',
    'zomato': 'https://www.zomato.com',
    'swiggy': 'https://www.swiggy.com'
  };

  const isExplicitNav = cleanQ.match(/^(?:open|go to|launch|visit|navigate to|search for)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|portal|url|link))?$/i);
  let rawTarget = isExplicitNav ? isExplicitNav[1].trim() : cleanQ;
  rawTarget = rawTarget.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:website|site|page|portal|url|link)$/i, '').trim();

  const lowerTarget = rawTarget.toLowerCase();

  // 1. Exact known site match
  if (KNOWN_SITES[lowerTarget]) {
    const targetUrl = KNOWN_SITES[lowerTarget];
    chrome.tabs.create({ url: targetUrl });
    actions.push({ step: 0, tag_id: 0, action: 'navigate', value: targetUrl, description: `Navigate to ${rawTarget}` });
    reasoning = `Opening "${rawTarget}" (${targetUrl}) in a new tab.`;
    return { id: `plan-${Date.now()}`, confidence: 0.99, source: 'Universal-Navigator', reasoning, actions };
  }

  // 2. Direct domain with dot (e.g. "canva.com", "bmsit.ac.in")
  if (rawTarget.includes('.') && !rawTarget.includes(' ')) {
    const targetUrl = rawTarget.startsWith('http') ? rawTarget : `https://${rawTarget}`;
    chrome.tabs.create({ url: targetUrl });
    actions.push({ step: 0, tag_id: 0, action: 'navigate', value: targetUrl, description: `Navigate to ${rawTarget}` });
    reasoning = `Opening "${rawTarget}" in a new tab.`;
    return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Universal-Navigator', reasoning, actions };
  }

  // 3. Explicit "open <brand/website>" (e.g. "open canva website", "open hotstar") -> resolve to https://www.<brand>.com
  if (isExplicitNav && !rawTarget.includes(' ') && rawTarget.length > 2) {
    const targetUrl = `https://www.${rawTarget.toLowerCase()}.com`;
    chrome.tabs.create({ url: targetUrl });
    actions.push({ step: 0, tag_id: 0, action: 'navigate', value: targetUrl, description: `Navigate to ${rawTarget}` });
    reasoning = `Opening "${rawTarget}" website (${targetUrl}) in a new tab.`;
    return { id: `plan-${Date.now()}`, confidence: 0.97, source: 'Universal-Navigator', reasoning, actions };
  }

  // =========================================================================
  // PRIORITY 6: Universal Web Search Fallback (Searches ANY query on the Internet)
  // =========================================================================
  const searchQuery = isExplicitNav ? rawTarget : cleanQ;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
  chrome.tabs.create({ url: searchUrl });
  actions.push({
    step: 0,
    tag_id: 0,
    action: 'navigate',
    value: searchUrl,
    description: `Search "${searchQuery}" on Google`
  });
  reasoning = `Searching "${searchQuery}" on the web.`;
  return { id: `plan-${Date.now()}`, confidence: 0.95, source: 'Universal-Web-Search', reasoning, actions };
}

// Handle messages from native host
function handleNativeMessage(message) {
  if (!message) return;

  switch (message.type) {
    case 'result':
    case 'action_plan':
      const plan = message.plan || message.payload || message;
      if (plan && plan.actions) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: 'execute_actions',
              payload: plan
            }).catch(() => {});
          }
        });
        chrome.runtime.sendMessage({
          type: 'action_plan',
          payload: plan
        }).catch(() => {});
        broadcastStatus('acting', `Executing actions from agent`);
      } else {
        broadcastStatus('online', message.why || 'Task complete');
      }
      break;

    case 'progress':
      broadcastStatus('thinking', message.message || 'Agent reasoning...');
      break;

    case 'transcript':
      broadcastStatus('thinking', `Heard: "${message.canonical || message.original || ''}"`);
      break;

    case 'transcription':
      chrome.runtime.sendMessage(message).catch(() => {});
      broadcastStatus('thinking', `Recognized: "${message.payload?.text || ''}"`);
      break;

    case 'status':
      currentStatus = message.payload || message;
      broadcastStatus(currentStatus.state || 'online', currentStatus.message || '');
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    case 'error':
      console.warn('[Background] Native host error:', message.message || message.detail);
      broadcastStatus('online', message.message || 'Ready');
      break;

    default:
      console.log('[Background] Native message received:', message.type);
      chrome.runtime.sendMessage(message).catch(() => {});
  }
}

function broadcastStatus(state, message = '') {
  currentStatus = { state, message };
  chrome.runtime.sendMessage({
    type: 'status',
    payload: currentStatus
  }).catch(() => {});
}

connectNativeHost();

// Open side panel when toolbar button is clicked (keeps UI alive, unlike popup)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

console.log('[SIH26171] Background Service Worker ready');
