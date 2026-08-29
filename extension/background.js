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
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || !tabs[0]) {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (!tabs || !tabs[0]) {
      tabs = await chrome.tabs.query({ active: true });
    }
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
      // Normal fetch with auto-inject fallback
      try {
        const response = await chrome.tabs.sendMessage(activeTab.id, {
          type: 'extract_dom',
          render_overlays: false
        });
        if (response && response.payload) {
          domData = response.payload;
        }
      } catch (err) {
        console.warn('[Background] Content script not connected, auto-injecting into tab:', err);
        if (activeTab.id && !activeTab.url?.startsWith('chrome://') && !activeTab.url?.startsWith('edge://')) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              files: ['content.js']
            });
            await new Promise(r => setTimeout(r, 120));
            const retryRes = await chrome.tabs.sendMessage(activeTab.id, {
              type: 'extract_dom',
              render_overlays: false
            });
            if (retryRes && retryRes.payload) {
              domData = retryRes.payload;
            }
          } catch(injectErr) {
            console.warn('[Background] Script injection retry failed:', injectErr);
          }
        }
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
    } else if (instantPlan) {
      // Broadcast even if 0 actions (e.g. Q&A or info)
      chrome.runtime.sendMessage({
        type: 'action_plan',
        payload: instantPlan
      }).catch(() => {});
      broadcastStatus('online', 'Agent Ready');
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

  // 1. Normalize query: strip conversational filler words (English & Hindi/Hinglish)
  let cleanQ = query.toLowerCase().trim();

  // =========================================================================
  // PHONETIC CORRECTION MAP
  // Web Speech API commonly mishears proper nouns. Fix before any intent logic.
  // =========================================================================
  const PHONETIC_FIXES = [
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
  // PRIORITY 0.5: Informational Questions & Page Understanding ("what is this", "explain", "summarize")
  // =========================================================================
  const isQuestion = cleanQ.startsWith('what is') || cleanQ.startsWith('what are') || 
                     cleanQ.startsWith('explain') || cleanQ.startsWith('summarize') || 
                     cleanQ.includes("can't see") || cleanQ.includes('why is') || 
                     cleanQ.includes('how do i') || cleanQ.includes('what does');

  if (isQuestion) {
    // Extract key page text headings
    const headings = elements.filter(el => el.tag_name?.startsWith('H') || el.role === 'heading' || (el.text && el.text.length > 15))
                             .map(el => el.text).slice(0, 3).join(' • ');

    if (currentUrl.includes('isro.gov.in') || headings.toLowerCase().includes('isro') || headings.toLowerCase().includes('spark')) {
      reasoning = `You are on the ISRO SPARK Virtual Space Museum & Space Tech Park. This shows interactive exhibits of Indian satellite and rocket missions. Say "scroll down" to browse or "go back" to return to the main portal.`;
    } else if (headings) {
      reasoning = `This page displays: ${headings.slice(0, 140)}. You can say "scroll down", "click on [section]", or "go back".`;
    } else {
      reasoning = `You are currently viewing an active webpage overlay. Say "scroll down" to explore content or "click [button name]" to interact.`;
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

      // Pattern A: "VALUE in[to] FIELD"  →  "airtel into repository name"
      const intoMatch = stripped.match(/^(.+?)\s+(?:in(?:to)?|inside)\s+(?:the\s+)?(.+)$/i);
      let parsedField = null;
      let parsedValue = null;

      if (intoMatch) {
        parsedValue = intoMatch[1].trim();
        parsedField = intoMatch[2].trim().replace(/\s*(field|box|input|area)$/i, '').trim();
      } else if (/\s+(?:with|as|to|=)\s+/.test(stripped)) {
        // Pattern B: "FIELD with|to|= VALUE"
        const m = stripped.match(/^(.+?)\s+(?:with|as|to|=)\s+(.+)$/i);
        if (m) { parsedField = m[1].trim(); parsedValue = m[2].trim(); }
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
      .replace(/^(?:choose|select|pick|open|get into|into|go to|click on|click|visit|tap|login|enter|create|make|add)\s+(?:the\s+)?(?:a\s+)?/i, '')
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
      const words = (searchTerms || cleanQ).split(/\s+/).filter(w => w.length > 2 && w !== 'the' && w !== 'this');
      for (const w of words) {
        if (elText.includes(w)) score += 30;
        if (elHref.includes(w)) score += 20;
      }
      if (searchTerms && elText.includes(searchTerms)) score += 60;
      if (elText.includes('privacy') || elText.includes('terms') || elText === 'google' || elText === 'sign in') score -= 40;
      if (el.role === 'button' || el.tag === 'button' || (el.role === 'link' && el.text?.length > 3) || el.tag === 'a') score += 10;

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
  // Matches: "open google summer of code", "google summer of code", "youtube", "go to github"
  // =========================================================================
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
    'bms institute of technology': 'https://bmsit.ac.in',
    'linkedin': 'https://www.linkedin.com',
    'instagram': 'https://www.instagram.com',
    'twitter': 'https://www.twitter.com',
    'x': 'https://www.x.com',
    'netflix': 'https://www.netflix.com',
    'amazon': 'https://www.amazon.in',
    'flipkart': 'https://www.flipkart.com',
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
    'swayam': 'https://swayam.gov.in'
  };

  const isExplicitNav = cleanQ.match(/^(?:open|go to|launch|visit|navigate to)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|url|link))?$/i);
  let rawTarget = isExplicitNav ? isExplicitNav[1].trim() : cleanQ;
  rawTarget = rawTarget.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+(?:website|site|page|portal|url|link)$/i, '').trim();

  const lowerTarget = rawTarget.toLowerCase();
  if (KNOWN_SITES[lowerTarget] || (isExplicitNav && rawTarget.includes('.') && !rawTarget.includes(' '))) {
    let targetUrl = KNOWN_SITES[lowerTarget] || (rawTarget.startsWith('http') ? rawTarget : `https://${rawTarget}`);
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
