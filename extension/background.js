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

  // 1. Conversational Query Normalizer: strip conversational filler words (e.g. "hey", "can you", "please", "bro")
  let cleanQ = query.toLowerCase().trim();
  let prevQ;
  do {
    prevQ = cleanQ;
    cleanQ = cleanQ.replace(/^(?:hey|hi|hello|ok|okay|aero|please|can you|could you|would you|i want to|help me|just|bro|agent)\s+/i, '').trim();
  } while (cleanQ !== prevQ);

  // Strip conversational suffixes
  cleanQ = cleanQ.replace(/\s+(?:for me|for us|please|now|fast)$/i, '').trim();

  // 1. HIGHEST PRIORITY: "Get into the website" / Click on-page search result link
  // Matches: "get into the isro website", "get into the website", "click first result", "open result", "enter website"
  if (cleanQ.includes('get into') || cleanQ.includes('into the') || cleanQ.includes('into website') ||
      cleanQ.includes('first result') || cleanQ.includes('first link') || cleanQ.includes('search result') ||
      cleanQ.includes('open result') || cleanQ.includes('click result') || cleanQ.includes('enter website')) {
    
    // Extract optional target topic if mentioned (e.g. "isro", "careers", "admissions")
    const topic = cleanQ.replace(/^(?:get into|into|enter|open|click)\s+(?:the\s+)?/i, '')
                        .replace(/\s+(?:website|site|page|portal|url|link)$/i, '').trim();

    // 1st attempt: Find link matching specific topic
    let linkElement = null;
    if (topic && topic.length > 2 && topic !== 'website' && topic !== 'site') {
      linkElement = elements.find(el => 
        (el.role === 'link' || el.tag_name === 'A') &&
        (el.text?.toLowerCase().includes(topic) || el.attributes?.href?.toLowerCase().includes(topic))
      );
    }

    // 2nd attempt: Find primary search result link
    if (!linkElement) {
      linkElement = elements.find(el => 
        (el.role === 'link' || el.tag_name === 'A') &&
        el.text && el.text.length > 8 &&
        !el.text.toLowerCase().includes('google') &&
        !el.text.toLowerCase().includes('sign in') &&
        !el.text.toLowerCase().includes('privacy') &&
        !el.text.toLowerCase().includes('terms')
      ) || elements.find(el => (el.role === 'link' || el.tag_name === 'A') && el.text && el.text.length > 3)
        || elements.find(el => el.role === 'link' || el.tag_name === 'A');
    }

    if (linkElement) {
      actions.push({
        step: 0,
        tag_id: linkElement.tag_id,
        action: 'click',
        description: `Click "${linkElement.text?.slice(0, 45) || 'Primary Link'}" (#${linkElement.tag_id})`
      });
      reasoning = `Found link "${linkElement.text || 'Result'}" (#${linkElement.tag_id}) on page. Clicking to navigate into website.`;
    }
  }
  // 2. Instant Navigation / Open Website intents (< 10ms)
  // Matches: "open BMS it website", "open youtube", "go to github", "visit wikipedia"
  else if (cleanQ.match(/^(?:open|go to|launch|visit|navigate to)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|url|link))?$/i) ||
           cleanQ.match(/^(.+?)\s+(?:website|site|portal)$/i)) {
    const isExplicitNav = cleanQ.match(/^(?:open|go to|launch|visit|navigate to)\s+(?:the\s+)?(.+?)(?:\s+(?:website|site|page|url|link))?$/i);
    const isWebsiteSuffix = cleanQ.match(/^(.+?)\s+(?:website|site|portal)$/i);

    let rawTarget = (isExplicitNav ? isExplicitNav[1] : isWebsiteSuffix[1]).trim();
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
    } else if (rawTarget.includes('.') && !rawTarget.includes(' ')) {
      targetUrl = rawTarget.startsWith('http') ? rawTarget : `https://${rawTarget}`;
    } else {
      targetUrl = `https://www.google.com/search?q=${encodeURIComponent(rawTarget)}`;
    }

    chrome.tabs.create({ url: targetUrl });
    actions.push({
      step: 0,
      tag_id: 0,
      action: 'navigate',
      value: targetUrl,
      description: `Navigate to ${rawTarget}`
    });
    reasoning = `Opening "${rawTarget}" in a new tab.`;
  }
  // 3. Login with credentials & Form Automation (< 30ms)
  // Matches: "login with username mohit and password secret", "enter credentials", "login to portal", "sign in"
  else if (cleanQ.includes('login') || cleanQ.includes('sign in') || cleanQ.includes('credentials') || cleanQ.includes('log in')) {
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
    }
  }
  // 4. Targeted Form Field Filling: "type John in name", "fill email with test@gmail.com"
  else if (cleanQ.match(/^(?:type|fill|enter|input)\s+(.+?)\s+(?:in|into|with|as)\s+(.+?)$/i)) {
    const fillMatch = cleanQ.match(/^(?:type|fill|enter|input)\s+(.+?)\s+(?:in|into|with|as)\s+(.+?)$/i);
    let valPart = fillMatch[1].trim();
    let fieldPart = fillMatch[2].trim();

    // Check if swapped (e.g. "fill email with test@gmail.com")
    if (cleanQ.includes(' with ')) {
      const swapped = cleanQ.match(/^(?:fill|enter|set)\s+(.+?)\s+with\s+(.+?)$/i);
      if (swapped) {
        fieldPart = swapped[1].trim();
        valPart = swapped[2].trim();
      }
    }

    const targetInput = elements.find(el => 
      (el.tag_name === 'INPUT' || el.tag_name === 'TEXTAREA' || el.role === 'textbox') &&
      (el.text?.toLowerCase().includes(fieldPart) || el.attributes?.name?.toLowerCase().includes(fieldPart) ||
       el.attributes?.placeholder?.toLowerCase().includes(fieldPart) || el.attributes?.id?.toLowerCase().includes(fieldPart) ||
       el.aria_label?.toLowerCase().includes(fieldPart))
    ) || elements.find(el => el.tag_name === 'INPUT' || el.tag_name === 'TEXTAREA');

    if (targetInput) {
      actions.push({
        step: 0,
        tag_id: targetInput.tag_id,
        action: 'type',
        value: valPart,
        description: `Fill "${valPart}" into ${fieldPart} (#${targetInput.tag_id})`
      });
      reasoning = `Found field matching "${fieldPart}" (#${targetInput.tag_id}). Filled with "${valPart}".`;
    }
  }
  // 4. Click specific element: "click on about us", "click login", "tap submit", "click admissions"
  else if (cleanQ.startsWith('click ') || cleanQ.startsWith('tap ') || cleanQ.startsWith('press ') || cleanQ.startsWith('select ')) {
    const targetLabel = cleanQ.replace(/^(?:click on|click|tap on|tap|press on|press|select)\s+(?:the\s+)?/i, '').replace(/\s+(?:button|link|tab|option)$/i, '').trim();

    let bestEl = null;
    let bestScore = 0;

    for (const el of elements) {
      const elText = (el.text || el.aria_label || el.attributes?.title || el.attributes?.placeholder || el.name || '').toLowerCase();
      if (!elText) continue;

      let score = 0;
      if (elText === targetLabel) score = 100;
      else if (elText.includes(targetLabel)) score = 50;
      else {
        const words = targetLabel.split(/\s+/);
        for (const w of words) {
          if (w.length > 2 && elText.includes(w)) score += 10;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }

    if (bestEl && bestScore > 0) {
      actions.push({
        step: 0,
        tag_id: bestEl.tag_id,
        action: 'click',
        description: `Click "${bestEl.text || bestEl.aria_label || targetLabel}" (#${bestEl.tag_id})`
      });
      reasoning = `Found element matching "${targetLabel}" (#${bestEl.tag_id}) with confidence score ${bestScore}.`;
    } else {
      // If element not on page, search for target
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(targetLabel)}`;
      chrome.tabs.create({ url: searchUrl });
      actions.push({ step: 0, tag_id: 0, action: 'navigate', value: searchUrl, description: `Search "${targetLabel}" on Google` });
      reasoning = `Element "${targetLabel}" not found on page. Searching on Google.`;
    }
  }
  // 5. Scroll intents
  else if (cleanQ.includes('scroll down') || cleanQ.includes('down') || cleanQ.includes('page down')) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'down', amount: 600, description: 'Scroll page down 600px' });
    reasoning = `Recognized scroll command. Scrolling page down.`;
  } else if (cleanQ.includes('scroll up') || cleanQ.includes('up') || cleanQ.includes('page up')) {
    actions.push({ step: 0, tag_id: 0, action: 'scroll', direction: 'up', amount: 600, description: 'Scroll page up 600px' });
    reasoning = `Recognized scroll command. Scrolling page up.`;
  }
  // 6. Search / Type intents
  else if (cleanQ.includes('search') || cleanQ.includes('type') || cleanQ.includes('find') || cleanQ.includes('enter') || cleanQ.includes('write') || cleanQ.includes('google')) {
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
      reasoning = `Found search box "${inputNode.text || inputNode.attributes?.placeholder || 'search'}" (#${inputNode.tag_id}). Typing query and submitting.`;
    } else {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchText)}`;
      chrome.tabs.create({ url: searchUrl });
      actions.push({
        step: 0,
        tag_id: 0,
        action: 'navigate',
        value: searchUrl,
        description: `Search "${searchText}" on Google`
      });
      reasoning = `No search field found on active tab. Opening Google search for "${searchText}".`;
    }
  }
  // 7. General Keyword / DOM matching fallback
  else {
    let bestMatch = null;
    let bestScore = 0;

    for (const el of elements) {
      const elText = (el.text || el.aria_label || el.attributes?.title || el.attributes?.placeholder || '').toLowerCase();
      if (!elText) continue;

      let score = 0;
      const words = cleanQ.split(/\s+/);
      for (const w of words) {
        if (w.length > 2 && elText.includes(w)) score += 3;
      }
      if (elText.includes(cleanQ)) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    if (bestMatch && bestScore > 0) {
      actions.push({
        step: 0,
        tag_id: bestMatch.tag_id,
        action: 'click',
        description: `Click on "${bestMatch.text || bestMatch.aria_label || bestMatch.tag_name}" (#${bestMatch.tag_id})`
      });
      reasoning = `Found matching element "${bestMatch.text || bestMatch.aria_label}" (#${bestMatch.tag_id}).`;
    } else {
      // Universal fallback: Open search in new tab
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(cleanQ)}`;
      chrome.tabs.create({ url: searchUrl });
      actions.push({
        step: 0,
        tag_id: 0,
        action: 'navigate',
        value: searchUrl,
        description: `Search "${cleanQ}" on Google`
      });
      reasoning = `Opening web search for "${cleanQ}".`;
    }
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
