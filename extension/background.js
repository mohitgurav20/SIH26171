/**
 * SIH26171 — Background Service Worker
 * Relays messages between popup/content script and native host.
 * Owner: Mohit
 */

const NATIVE_HOST_NAME = 'com.sih26171.browser_ai_agent';

let nativePort = null;

// Connect to native host
function connectNativeHost() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((message) => {
      console.log('[Background] Received from native host:', message.type);
      handleNativeMessage(message);
    });

    nativePort.onDisconnect.addListener(() => {
      console.log('[Background] Native host disconnected:', chrome.runtime.lastError?.message);
      nativePort = null;
      broadcastStatus('offline');
    });

    broadcastStatus('connected');
    console.log('[Background] Connected to native host');
  } catch (error) {
    console.error('[Background] Failed to connect to native host:', error);
    broadcastStatus('offline');
  }
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Background] Received message:', message.type);

  switch (message.type) {
    case 'command':
      forwardToNativeHost(message);
      broadcastStatus('thinking');
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

    case 'audio':
      forwardToNativeHost(message);
      sendResponse({ status: 'sent' });
      break;

    case 'action_result':
      forwardToNativeHost(message);
      sendResponse({ status: 'sent' });
      break;

    case 'verify_log':
      forwardToNativeHost({ type: 'verify_log', payload: {} });
      sendResponse({ status: 'sent' });
      break;

    default:
      sendResponse({ status: 'unknown_type' });
  }

  return true; // Keep channel open for async response
});

// Forward message to native host
function forwardToNativeHost(message) {
  if (!nativePort) {
    console.warn('[Background] Native host not connected, attempting reconnect...');
    connectNativeHost();
  }

  if (nativePort) {
    nativePort.postMessage(message);
  } else {
    console.error('[Background] Cannot send — native host unavailable');
  }
}

// Handle messages from native host
function handleNativeMessage(message) {
  switch (message.type) {
    case 'action_plan':
      // Forward plan to content script for execution
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message);
        }
      });
      // Also forward to popup for display
      chrome.runtime.sendMessage(message);
      broadcastStatus('acting');
      break;

    case 'transcription':
      chrome.runtime.sendMessage(message);
      break;

    case 'status':
      broadcastStatus(message.payload.state);
      chrome.runtime.sendMessage(message);
      break;

    case 'confirmation_request':
      chrome.runtime.sendMessage(message);
      broadcastStatus('paused');
      break;

    case 'evidence':
      chrome.runtime.sendMessage(message);
      break;

    case 'resource_stats':
      chrome.runtime.sendMessage(message);
      break;

    default:
      console.log('[Background] Unknown native message type:', message.type);
  }
}

function broadcastStatus(state) {
  chrome.runtime.sendMessage({
    type: 'status',
    payload: { state, message: '' }
  }).catch(() => {}); // Popup might not be open
}

// Auto-connect on startup
connectNativeHost();

console.log('[SIH26171] Background service worker loaded');
