/**
 * SIH26171 — Background Service Worker
 * Native host communication, offscreen task offloading, screenshot captures,
 * and Task 105 Predictive Prefetching.
 * Owner: Mohit
 */

const NATIVE_HOST_NAME = 'com.sih26171.browser_ai_agent';

let nativePort = null;
let reconnectTimer = null;
let currentStatus = { state: 'offline', message: '' };
let latestResourceStats = null;
let prefetchedState = null;
let prefetchAbortController = null;

// Connect to native messaging host
function connectNativeHost() {
  if (nativePort) return;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((message) => {
      console.log('[Background] Native host message:', message.type);
      handleNativeMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'Unknown error';
      console.warn('[Background] Native host disconnected:', error);
      nativePort = null;
      broadcastStatus('offline', 'Native host disconnected. Reconnecting...');
      scheduleReconnect();
    });

    broadcastStatus('connected', 'Connected to native agent');
    console.log('[Background] Connected to native host:', NATIVE_HOST_NAME);
  } catch (error) {
    console.error('[Background] Failed to connect to native host:', error);
    nativePort = null;
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
      return true;

    case 'stop_recording':
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

    if (domData) {
      forwardToNativeHost({
        type: 'dom_data',
        id: `dom-${Date.now()}`,
        timestamp: new Date().toISOString(),
        payload: domData
      });
    }

    if (screenshot) {
      forwardToNativeHost({
        type: 'screenshot',
        id: `ss-${Date.now()}`,
        timestamp: new Date().toISOString(),
        payload: {
          ...screenshot,
          url: activeTab.url || ''
        }
      });
    }

    forwardToNativeHost({
      type: 'command',
      id: `cmd-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: commandPayload
    });

    broadcastStatus('thinking', 'Agent analyzing page and planning actions...');
  } catch (error) {
    console.error('[Background] Error processing command pipeline:', error);
    broadcastStatus('error', error.message);
  }
}

// Handle messages from native host
function handleNativeMessage(message) {
  switch (message.type) {
    case 'action_plan':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message).catch((err) => {
            console.warn('[Background] Failed to send action_plan to tab:', err);
          });
        }
      });
      chrome.runtime.sendMessage(message).catch(() => {});
      broadcastStatus('acting', 'Executing planned actions...');
      break;

    case 'transcription':
      chrome.runtime.sendMessage(message).catch(() => {});
      broadcastStatus('thinking', `Recognized: "${message.payload?.text || ''}"`);
      break;

    case 'status':
      currentStatus = message.payload;
      broadcastStatus(message.payload.state, message.payload.message);
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    case 'confirmation_request':
      broadcastStatus('paused', 'Confirmation required for sensitive action');
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    case 'evidence':
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    case 'resource_stats':
      latestResourceStats = message.payload;
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    case 'verification_result':
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    default:
      console.log('[Background] Unhandled native message type:', message.type);
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

console.log('[SIH26171] Background Service Worker ready');
