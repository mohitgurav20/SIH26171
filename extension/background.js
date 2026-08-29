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

// Full command pipeline
async function handleUserCommand(commandPayload) {
  broadcastStatus('thinking', 'Extracting page DOM & capturing context...');

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0]) {
      throw new Error('No active browser tab found');
    }

    const activeTab = tabs[0];
    let domData = null;
    let screenshot = null;

    // Check if valid prefetch exists for this URL
    if (prefetchedState && prefetchedState.url === activeTab.url && (Date.now() - prefetchedState.timestamp < 3000)) {
      console.log('[Background] Task 105: Utilizing prefetched DOM & screenshot!');
      domData = prefetchedState.dom;
      screenshot = prefetchedState.screenshot;
      prefetchedState = null;
    } else {
      // Normal fetch
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          type: 'extract_dom',
          render_overlays: false
        });
        if (response && response.payload) {
          domData = response.payload;
        }
      } catch (err) {
        console.warn('[Background] Could not extract DOM via content script:', err);
      }

      screenshot = await captureActiveTabScreenshot();
    }

    // Format PageState object matching voicc_host schema
    const pageState = domData ? {
      url: activeTab.url || '',
      title: activeTab.title || '',
      elements: domData.elements || [],
      changed_tag_ids: domData.changed_tag_ids || [],
      has_opaque_regions: domData.has_opaque_regions || false,
      layout_hash: domData.layout_hash || '',
      dom_payload_bytes: domData.dom_payload_bytes || 0,
      raw_html_bytes: domData.raw_html_bytes || 0
    } : null;

    // --- INSTANT ACTION EXECUTION ---
    // Always generate instant reflex plan (works on New Tab, blank tabs, and live web pages)
    const elementsList = domData?.elements || [];
    const instantPlan = generateRealActionPlan(commandPayload.text, elementsList, activeTab.url);

    if (instantPlan && instantPlan.actions.length > 0) {
      // Send to content script to execute on the real webpage (if not a chrome:// page)
      if (activeTab.id && !activeTab.url?.startsWith('chrome://') && !activeTab.url?.startsWith('edge://')) {
        chrome.tabs.sendMessage(activeTab.id, {
          type: 'execute_actions',
          payload: instantPlan
        }).catch(() => {});
      }

      // Broadcast immediately to popup
      chrome.runtime.sendMessage({
        type: 'action_plan',
        payload: instantPlan
      }).catch(() => {});

      broadcastStatus('online', `Completed: ${instantPlan.actions[0].description}`);
      return;
    }

    // Forward properly formatted request to native host for deep multi-step reasoning
    if (nativePort) {
      forwardToNativeHost({
        type: 'command',
        id: `cmd-${Date.now()}`,
        task: commandPayload.text,
        page: pageState,
        image_b64: screenshot?.image_base64 || '',
        visible_tags: domData?.elements ? domData.elements.map(e => e.tag_id) : []
      });
    }

  } catch (error) {
    console.error('[Background] Error processing command pipeline:', error);
    broadcastStatus('error', error.message);
  }
}

// Generate Real Action Plan matching user query against actual webpage DOM elements
function generateRealActionPlan(query, elements, currentUrl = '') {
  if (!query) return null;
  const actions = [];
  let reasoning = '';

  // 1. Normalize query: strip conversational filler words (e.g. "hey", "can you", "please", "bro")
  let cleanQ = query.toLowerCase().trim();
  let prevQ;
  do {
    prevQ = cleanQ;
    cleanQ = cleanQ.replace(/^(?:hey|hi|hello|ok|okay|aero|please|can you|could you|would you|i want to|help me|just|bro|agent)\s+/i, '').trim();
  } while (cleanQ !== prevQ);

  // Strip conversational suffixes
  cleanQ = cleanQ.replace(/\s+(?:for me|for us|please|now|fast)$/i, '').trim();

  // =========================================================================
  // PRIORITY 1: Autonomous Login & Form Filling (< 30ms)
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
  // PRIORITY 2: On-Page Result Entry / Click Matching Link (< 30ms)
  // If user says "get into isro", "login the isro website", "click result", "click admissions"
  // Look at the CURRENT WEBPAGE and click the best matching link or button!
  // =========================================================================
  if (elements.length > 0) {
    // Extract keywords
    const searchTerms = cleanQ.replace(/^(?:open|get into|into|go to|click on|click|visit|tap|login|enter)\s+(?:the\s+)?/i, '')
                              .replace(/\s+(?:website|site|page|portal|url|link)$/i, '').trim();

    let bestEl = null;
    let bestScore = 0;

    for (const el of elements) {
      const elText = (el.text || el.aria_label || el.attributes?.title || el.attributes?.placeholder || el.name || '').toLowerCase();
      const elHref = (el.attributes?.href || '').toLowerCase();
      if (!elText && !elHref) continue;

      let score = 0;
      
      // Match query terms
      const words = (searchTerms || cleanQ).split(/\s+/).filter(w => w.length > 2);
      for (const w of words) {
        if (elText.includes(w)) score += 30;
        if (elHref.includes(w)) score += 20;
      }

      // Exact match bonus
      if (searchTerms && elText.includes(searchTerms)) score += 50;

      // Penalize generic navigational links on search engines
      if (elText.includes('privacy') || elText.includes('terms') || elText === 'google' || elText === 'sign in') {
        score -= 40;
      }

      // Prioritize substantial result links on search pages
      if ((el.role === 'link' || el.tag_name === 'A') && el.text && el.text.length > 8) {
        score += 15;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    // If an element on the current page clearly matches the user's target, CLICK IT!
    if (bestEl && bestScore >= 30) {
      actions.push({
        step: 0,
        tag_id: bestEl.tag_id,
        action: 'click',
        description: `Click "${bestEl.text?.slice(0, 45) || 'Target Element'}" (#${bestEl.tag_id})`
      });
      reasoning = `Found on-page element matching "${searchTerms || cleanQ}" (#${bestEl.tag_id}). Clicking directly on active page.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 3: Scroll intents (< 20ms)
  // =========================================================================
  if (cleanQ.includes('scroll down') || cleanQ.includes('down') || cleanQ.includes('page down')) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'down', amount: 600, description: 'Scroll page down 600px' });
    reasoning = `Recognized scroll command. Scrolling page down.`;
    return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
  } else if (cleanQ.includes('scroll up') || cleanQ.includes('up') || cleanQ.includes('page up')) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'up', amount: 600, description: 'Scroll page up 600px' });
    reasoning = `Recognized scroll command. Scrolling page up.`;
    return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
  }

  // =========================================================================
  // PRIORITY 4: Type into on-page Search Input (< 30ms)
  // If user says "search for X", "type X into search box"
  // =========================================================================
  if (cleanQ.includes('search') || cleanQ.includes('type') || cleanQ.includes('find') || cleanQ.includes('enter') || cleanQ.includes('write')) {
    let searchText = cleanQ.replace(/^(?:search for|search|type|find|enter|write|google for|google)\s*/i, '').trim();
    if (!searchText) searchText = cleanQ;

    const inputNode = elements.find(el => 
      el.tag_name === 'INPUT' || el.tag_name === 'TEXTAREA' || el.role === 'searchbox' || el.role === 'textbox' ||
      (el.attributes?.placeholder && el.attributes.placeholder.toLowerCase().includes('search'))
    ) || elements.find(el => el.tag_name === 'INPUT' || el.tag_name === 'TEXTAREA');

    if (inputNode) {
      actions.push({
        step: 0,
        tag_id: inputNode.tag_id,
        action: 'type',
        value: searchText,
        description: `Type "${searchText}" into <${inputNode.tag_name.toLowerCase()}> (#${inputNode.tag_id})`
      });
      actions.push({
        step: 1,
        tag_id: inputNode.tag_id,
        action: 'press_key',
        value: 'Enter',
        description: `Press Enter to submit search`
      });
      reasoning = `Found search box "${inputNode.text || inputNode.attributes?.placeholder || 'search'}" (#${inputNode.tag_id}). Typing query and submitting on active page.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 5: Direct Website Domain Navigation (ONLY for explicit new site requests)
  // =========================================================================
  const isExplicitNav = cleanQ.match(/^(?:open|go to|launch|visit|navigate to)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|url|link))?$/i);
  if (isExplicitNav) {
    let rawTarget = isExplicitNav[1].trim();
    rawTarget = rawTarget.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:website|site|page|portal|url|link)$/i, '').trim();
    let targetUrl;

    const KNOWN_SITES = {
      'youtube': 'https://www.youtube.com',
      'google': 'https://www.google.com',
      'github': 'https://www.github.com',
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
      'bms institute of technology': 'https://bmsit.ac.in'
    };

    const lowerTarget = rawTarget.toLowerCase();
    if (KNOWN_SITES[lowerTarget]) {
      targetUrl = KNOWN_SITES[lowerTarget];
      chrome.tabs.create({ url: targetUrl });
      actions.push({
        step: 0,
        tag_id: 0,
        action: 'navigate',
        value: targetUrl,
        description: `Navigate to ${rawTarget}`
      });
      reasoning = `Opening "${rawTarget}" in a new tab.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    } else if (rawTarget.includes('.') && !rawTarget.includes(' ')) {
      targetUrl = rawTarget.startsWith('http') ? rawTarget : `https://${rawTarget}`;
      chrome.tabs.create({ url: targetUrl });
      actions.push({
        step: 0,
        tag_id: 0,
        action: 'navigate',
        value: targetUrl,
        description: `Navigate to ${rawTarget}`
      });
      reasoning = `Opening "${rawTarget}" in a new tab.`;
      return { id: `plan-${Date.now()}`, confidence: 0.98, source: 'Live DOM-Perception', reasoning, actions };
    }
  }

  // =========================================================================
  // PRIORITY 6: Primary Page Element Click Fallback (NEVER open search tabs blindly)
  // =========================================================================
  if (elements.length > 0) {
    const primaryLink = elements.find(el => (el.role === 'link' || el.tag_name === 'A') && el.text && el.text.length > 5 && !el.text.toLowerCase().includes('google'))
                     || elements[0];
    actions.push({
      step: 0,
      tag_id: primaryLink.tag_id,
      action: 'click',
      description: `Click "${primaryLink.text?.slice(0, 45) || primaryLink.tag_name}" (#${primaryLink.tag_id})`
    });
    reasoning = `Interacting with element #${primaryLink.tag_id} on active page.`;
    return { id: `plan-${Date.now()}`, confidence: 0.95, source: 'Live DOM-Perception', reasoning, actions };
  }

  if (actions.length === 0) {
    reasoning = `No interactive target matched for "${query}".`;
  }

  return {
    id: `plan-${Date.now()}`,
    confidence: 0.98,
    source: 'Live DOM-Perception',
    reasoning,
    actions
  };
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
