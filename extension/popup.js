/**
 * SIH26171 — Popup Logic
 * Handles command input, voice recording, and communication with background worker.
 * Owner: Mohit
 */

document.addEventListener('DOMContentLoaded', () => {
  const commandInput = document.getElementById('command-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const trailContent = document.getElementById('trail-content');
  const evidenceContent = document.getElementById('evidence-content');
  const verifyLogBtn = document.getElementById('verify-log-btn');
  const resourceStats = document.getElementById('resource-stats');

  // Send command
  sendBtn.addEventListener('click', () => {
    const text = commandInput.value.trim();
    if (!text) return;

    const language = document.querySelector('input[name="lang"]:checked').value;

    // Send to background worker
    chrome.runtime.sendMessage({
      type: 'command',
      payload: { text, source: 'text', language }
    }, (response) => {
      console.log('[Popup] Response:', response);
    });

    // Show in trail
    addTrailEntry('user', text);
    commandInput.value = '';
  });

  // Enter key sends
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendBtn.click();
  });

  // Mic button placeholder
  micBtn.addEventListener('click', () => {
    // TODO: Implement audio recording and send to native host
    console.log('[Popup] Mic button clicked — voice recording TBD');
    micBtn.classList.toggle('recording');
  });

  // Log verification
  verifyLogBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'verify_log' }, (response) => {
      console.log('[Popup] Log verification result:', response);
    });
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'status') {
      updateStatus(message.payload.state);
    } else if (message.type === 'action_plan') {
      addTrailEntry('agent', message.payload.reasoning);
    } else if (message.type === 'evidence') {
      addEvidenceEntry(message.payload);
    } else if (message.type === 'resource_stats') {
      updateResourceStats(message.payload);
    }
  });

  function addTrailEntry(role, text) {
    const placeholder = trailContent.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    const entry = document.createElement('div');
    entry.className = `trail-entry ${role}`;
    entry.textContent = `${role === 'user' ? '👤' : '🤖'} ${text}`;
    trailContent.appendChild(entry);
    trailContent.scrollTop = trailContent.scrollHeight;
  }

  function addEvidenceEntry(evidence) {
    const placeholder = evidenceContent.querySelector('.placeholder');
    if (placeholder) placeholder.remove();

    const entry = document.createElement('div');
    entry.className = 'evidence-entry';
    entry.innerHTML = `<strong>${evidence.element_text || 'N/A'}</strong>: ${evidence.reason || 'No reason provided'}`;
    evidenceContent.appendChild(entry);
  }

  function updateStatus(state) {
    statusIndicator.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    statusIndicator.className = `status ${state}`;
  }

  function updateResourceStats(stats) {
    resourceStats.textContent = `RAM: ${stats.ram_mb}MB | Latency: ${stats.inference_time_ms}ms`;
  }

  console.log('[SIH26171] Popup loaded');
});
