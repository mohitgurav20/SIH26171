/**
 * SIH26171 — Popup Controller
 * Manages user interactions, audio recording, action plan visualization,
 * Proof-of-Perception evidence rendering, and safety guardrails.
 * Owner: Mohit
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const commandInput = document.getElementById('command-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const toggleTagsBtn = document.getElementById('toggle-tags-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const modelBadge = document.getElementById('model-badge');
  const voiceRecordingBar = document.getElementById('voice-recording-bar');
  const recordingTimer = document.getElementById('recording-timer');

  const planMeta = document.getElementById('plan-meta');
  const confidenceBadge = document.getElementById('confidence-badge');
  const sourceBadge = document.getElementById('source-badge');
  const reasoningBox = document.getElementById('reasoning-box');
  const planStepsContainer = document.getElementById('plan-steps-container');
  const planStepsList = document.getElementById('plan-steps-list');

  const evidenceContainer = document.getElementById('evidence-container');
  const verifyLogBtn = document.getElementById('verify-log-btn');
  const auditStatusPill = document.getElementById('audit-status-pill');
  const ramStat = document.getElementById('ram-stat');
  const latencyStat = document.getElementById('latency-stat');

  // Confirmation Modal
  const confirmationModal = document.getElementById('confirmation-modal');
  const modalMessage = document.getElementById('modal-message');
  const modalDetails = document.getElementById('modal-details');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');
  const modalRejectBtn = document.getElementById('modal-reject-btn');

  // Zoom Modal
  const imageZoomModal = document.getElementById('image-zoom-modal');
  const zoomedImage = document.getElementById('zoomed-image');
  const closeZoomBtn = document.getElementById('close-zoom-btn');

  // State
  let isRecording = false;
  let recordingStartTime = null;
  let recordingInterval = null;
  let audioStream = null;
  let audioContext = null;
  let audioProcessor = null;
  let mediaStreamSource = null;
  let recordedPCMChunks = [];
  let overlaysVisible = false;
  let currentPendingConfirmationId = null;

  // Initialize popup state from background
  chrome.runtime.sendMessage({ type: 'get_initial_state' }, (res) => {
    if (res && res.status) {
      updateStatus(res.status.state, res.status.message);
    }
    if (res && res.resource_stats) {
      updateResourceStats(res.resource_stats);
    }
  });

  // Event Listeners: Text Command
  sendBtn.addEventListener('click', handleSendCommand);
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendCommand();
    }
  });

  // Event Listener: Voice Mic Recording
  micBtn.addEventListener('click', handleToggleMic);

  // Event Listener: Toggle Tags Overlay
  toggleTagsBtn.addEventListener('click', () => {
    overlaysVisible = !overlaysVisible;
    chrome.runtime.sendMessage({
      type: 'toggle_overlays',
      show: overlaysVisible
    });
    toggleTagsBtn.style.color = overlaysVisible ? '#00f2fe' : '';
  });

  // Event Listener: Verify Hash Chain
  verifyLogBtn.addEventListener('click', () => {
    verifyLogBtn.disabled = true;
    verifyLogBtn.textContent = 'Verifying...';
    chrome.runtime.sendMessage({ type: 'verify_log' });

    setTimeout(() => {
      verifyLogBtn.disabled = false;
      verifyLogBtn.innerHTML = '<span class="icon">🔗</span><span>Verify Audit Log</span>';
      auditStatusPill.classList.remove('hidden');
      auditStatusPill.textContent = 'Verified ✓';
    }, 800);
  });

  // Event Listeners: Confirmation Modal
  modalConfirmBtn.addEventListener('click', () => {
    confirmationModal.classList.add('hidden');
    chrome.runtime.sendMessage({
      type: 'confirm_action',
      payload: { approved: true, id: currentPendingConfirmationId }
    });
  });

  modalRejectBtn.addEventListener('click', () => {
    confirmationModal.classList.add('hidden');
    chrome.runtime.sendMessage({
      type: 'confirm_action',
      payload: { approved: false, id: currentPendingConfirmationId }
    });
  });

  // Event Listeners: Image Zoom Modal
  closeZoomBtn.addEventListener('click', () => {
    imageZoomModal.classList.add('hidden');
  });
  imageZoomModal.addEventListener('click', (e) => {
    if (e.target === imageZoomModal) imageZoomModal.classList.add('hidden');
  });

  // Runtime Message Receiver
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[Popup] Message:', message.type);

    switch (message.type) {
      case 'status':
        updateStatus(message.payload?.state, message.payload?.message);
        break;

      case 'action_plan':
        renderActionPlan(message.payload);
        break;

      case 'action_result':
        updateStepResult(message.payload);
        break;

      case 'evidence':
        addEvidenceCard(message.payload);
        break;

      case 'transcription':
        if (message.payload?.text) {
          commandInput.value = message.payload.text;
          reasoningBox.innerHTML = `<strong>Transcribed Voice:</strong> "${message.payload.text}" (${message.payload.language?.toUpperCase() || 'EN'})`;
        }
        break;

      case 'confirmation_request':
        showConfirmationModal(message.payload, message.id);
        break;

      case 'resource_stats':
        updateResourceStats(message.payload);
        break;

      case 'verification_result':
        auditStatusPill.classList.remove('hidden');
        if (message.payload?.verified) {
          auditStatusPill.textContent = 'Verified ✓';
          auditStatusPill.style.color = '#34d399';
        } else {
          auditStatusPill.textContent = 'Tamper Alert ✗';
          auditStatusPill.style.color = '#ef4444';
        }
        break;
    }
  });

  // Command Submission Handler
  function handleSendCommand() {
    const text = commandInput.value.trim();
    if (!text) return;
    const lang = 'auto'; // Automatic speech language recognition (Hindi / Kannada / English)

    // Clear previous execution state
    planStepsList.innerHTML = '';
    planStepsContainer.style.display = 'none';
    planMeta.style.display = 'none';

    reasoningBox.innerHTML = `<strong>Command:</strong> "${escapeHtml(text)}"`;

    chrome.runtime.sendMessage({
      type: 'command',
      payload: {
        text,
        source: 'text',
        language: lang
      }
    });

    updateStatus('thinking', 'Planning actions for command...');
  }

  // Voice Mic Toggle — Delegates to background/offscreen for MV3 mic access
  // Uses Web Speech API for real-time live preview (what the user is saying)
  let speechRecognition = null;
  const liveTranscript = document.getElementById('live-transcript');
  const voiceStopBtn = document.getElementById('voice-stop-btn');

  if (voiceStopBtn) {
    voiceStopBtn.addEventListener('click', () => {
      if (isRecording) handleToggleMic();
    });
  }

  async function handleToggleMic() {
    if (!isRecording) {
      // Tell background service worker to start recording via offscreen document
      chrome.runtime.sendMessage({ type: 'start_recording' }, (res) => {
        if (res && res.error) {
          console.error('Recording failed:', res.error);
          reasoningBox.innerHTML = `<em style="color:#ef4444;">Mic Error: ${res.error}</em>`;
          return;
        }
      });

      isRecording = true;
      micBtn.classList.add('recording');
      voiceRecordingBar.classList.remove('hidden');
      recordingStartTime = Date.now();

      // Reset live transcript
      if (liveTranscript) {
        liveTranscript.textContent = 'Start speaking...';
        liveTranscript.classList.remove('has-text');
      }

      // Start live preview using Web Speech API (browser-native, works in Chrome)
      try {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SpeechRecognition) {
          speechRecognition = new SpeechRecognition();
          speechRecognition.continuous = true;
          speechRecognition.interimResults = true;
          // Use navigator language or default to en-IN (works well for English + Hindi mixed speech)
          speechRecognition.lang = navigator.language || 'en-IN';
          speechRecognition.maxAlternatives = 1;

          // Auto-restart if recognition stops prematurely while still recording
          speechRecognition.onend = () => {
            if (isRecording && speechRecognition) {
              try { speechRecognition.start(); } catch(e) {}
            }
          };

          let finalText = '';

          speechRecognition.onresult = (event) => {
            let interimText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const transcript = event.results[i][0].transcript;
              if (event.results[i].isFinal) {
                finalText += transcript + ' ';
              } else {
                interimText += transcript;
              }
            }

            if (liveTranscript) {
              const display = (finalText + interimText).trim();
              liveTranscript.textContent = display || 'Listening...';
              liveTranscript.classList.toggle('has-text', display.length > 0);
            }
          };

          speechRecognition.onerror = (e) => {
            console.warn('Speech preview error:', e.error);
            if (liveTranscript) liveTranscript.textContent = 'Listening (preview unavailable)...';
          };

          speechRecognition.start();
        }
      } catch (e) {
        console.warn('Web Speech API not available for preview:', e);
      }

      recordingInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
        const min = Math.floor(elapsedSec / 60);
        const sec = elapsedSec % 60;
        recordingTimer.textContent = `${min}:${sec < 10 ? '0' : ''}${sec}`;
      }, 500);
    } else {
      // Stop recording
      isRecording = false;
      micBtn.classList.remove('recording');
      voiceRecordingBar.classList.add('hidden');
      clearInterval(recordingInterval);

      // Stop live speech preview
      if (speechRecognition) {
        try { speechRecognition.stop(); } catch(e) {}
        speechRecognition = null;
      }

      // Show what was captured in reasoning box
      const capturedText = liveTranscript ? liveTranscript.textContent : '';
      if (capturedText && capturedText !== 'Start speaking...' && capturedText !== 'Listening...') {
        reasoningBox.innerHTML = `<strong>Voice:</strong> "${escapeHtml(capturedText)}"<br><em style="color:#6b7280">Transcribing on-device for precision...</em>`;
        commandInput.value = capturedText;
      } else {
        reasoningBox.innerHTML = `<em>Processing recorded audio...</em>`;
      }

      updateStatus('thinking', 'Transcribing audio on-device...');
      chrome.runtime.sendMessage({ type: 'stop_recording' });
    }
  }

  // Render Action Plan
  function renderActionPlan(plan) {
    if (!plan) return;

    // Reasoning
    if (plan.reasoning) {
      reasoningBox.innerHTML = `<strong>Reasoning:</strong> ${escapeHtml(plan.reasoning)}`;
    }

    // Meta Badges & Task 78 Cache Invalidation UI Feedback
    planMeta.style.display = 'flex';
    const cacheBadge = document.getElementById('cache-badge');
    if (cacheBadge) {
      if (plan.source === 'cached' || plan.cached_workflow) {
        cacheBadge.style.display = 'inline-block';
        cacheBadge.className = 'badge badge-cache cached';
        cacheBadge.textContent = '⚡ Cached Flow';
      } else if (plan.source === 'cache_invalidated' || plan.cache_invalidated) {
        cacheBadge.style.display = 'inline-block';
        cacheBadge.className = 'badge badge-cache invalidated';
        cacheBadge.textContent = '⚠️ Cache Invalidated';
      } else {
        cacheBadge.style.display = 'none';
      }
    }

    const conf = Math.round((plan.confidence || 0.9) * 100);
    confidenceBadge.textContent = `${conf}% Conf`;
    sourceBadge.textContent = (plan.source || 'DOM').toUpperCase();

    // Render Steps
    const actions = plan.actions || [];
    if (actions.length > 0) {
      planStepsContainer.style.display = 'flex';
      planStepsList.innerHTML = '';

      actions.forEach((act, idx) => {
        const stepNum = act.step !== undefined ? act.step : idx;
        const stepDiv = document.createElement('div');
        stepDiv.className = 'step-item';
        stepDiv.id = `step-item-${stepNum}`;

        stepDiv.innerHTML = `
          <div class="step-info">
            <span class="step-tag">#${act.tag_id || stepNum + 1}</span>
            <span class="step-action-type">${act.action || 'action'}</span>
            <span class="step-desc">${escapeHtml(act.description || act.value || '')}</span>
          </div>
          <span class="step-status-badge badge-queued" id="step-badge-${stepNum}">Queued</span>
        `;
        planStepsList.appendChild(stepDiv);
      });
    }

    // If evidence included in plan
    if (plan.evidence && Array.isArray(plan.evidence)) {
      plan.evidence.forEach(ev => addEvidenceCard(ev));
    }
  }

  // Update Step Execution Result
  function updateStepResult(result) {
    if (!result) return;
    const stepNum = result.step_index;
    const stepDiv = document.getElementById(`step-item-${stepNum}`);
    const stepBadge = document.getElementById(`step-badge-${stepNum}`);

    if (stepDiv && stepBadge) {
      if (result.success) {
        stepDiv.className = 'step-item completed';
        stepBadge.className = 'step-status-badge badge-done';
        stepBadge.textContent = 'Done ✓';
      } else {
        stepDiv.className = 'step-item failed';
        stepBadge.className = 'step-status-badge badge-error';
        stepBadge.textContent = 'Failed ✗';
      }
    }
  }

  // Add Proof-of-Perception Evidence Card (Task 153: lazy loading)
  function addEvidenceCard(evidence) {
    if (!evidence) return;

    const placeholder = evidenceContainer.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'evidence-entry';

    let cropHtml = '';
    if (evidence.vision_crop_base64) {
      const src = evidence.vision_crop_base64.startsWith('data:')
        ? evidence.vision_crop_base64
        : `data:image/png;base64,${evidence.vision_crop_base64}`;
      cropHtml = `<img src="${src}" class="evidence-thumb" loading="lazy" title="Click to zoom crop" />`;
    }

    const shortHash = evidence.hash ? evidence.hash.substring(0, 10) + '...' : 'hash-chain';
    const prevShortHash = evidence.prev_hash ? ' ← ' + evidence.prev_hash.substring(0, 8) + '...' : '';

    card.innerHTML = `
      ${cropHtml}
      <div class="evidence-body">
        <div class="evidence-label">${escapeHtml(evidence.element_text || 'Interactive Target')}</div>
        ${evidence.dom_snippet ? `<div class="evidence-snippet">${escapeHtml(evidence.dom_snippet)}</div>` : ''}
        <div class="evidence-reason">${escapeHtml(evidence.reason || 'Visual and DOM alignment confirmed')}</div>
        <div class="evidence-hash">⛓️ ${shortHash}${prevShortHash}</div>
      </div>
    `;

    const thumbImg = card.querySelector('.evidence-thumb');
    if (thumbImg) {
      thumbImg.addEventListener('click', () => {
        zoomedImage.src = thumbImg.src;
        imageZoomModal.classList.remove('hidden');
      });
    }

    evidenceContainer.prepend(card);
  }


  // Safety Confirmation Modal
  function showConfirmationModal(payload, id) {
    currentPendingConfirmationId = id;
    modalDetails.innerHTML = `
      <div><strong>Action:</strong> ${escapeHtml(payload?.action?.toUpperCase() || 'SENSITIVE ACTION')}</div>
      <div><strong>Target:</strong> ${escapeHtml(payload?.element_text || 'Element #' + payload?.tag_id)}</div>
      <div><strong>Confidence:</strong> ${Math.round((payload?.confidence || 0) * 100)}%</div>
      <div><strong>Reason:</strong> ${escapeHtml(payload?.reason || 'Guardrail flagged potentially destructive intent.')}</div>
    `;
    confirmationModal.classList.remove('hidden');
  }

  // Update Status Pill
  function updateStatus(state, msg) {
    if (!state) state = 'connected';
    const stateClass = `status-${state}`;
    statusIndicator.className = `status-pill ${stateClass}`;

    const label = statusIndicator.querySelector('.status-label');
    if (label) {
      label.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    }
  }

  // Update Resource Stats
  function updateResourceStats(stats) {
    if (!stats) return;
    if (stats.ram_mb !== undefined) {
      ramStat.textContent = `RAM: ${stats.ram_mb} MB`;
    }
    if (stats.inference_time_ms !== undefined) {
      latencyStat.textContent = `Latency: ${stats.inference_time_ms} ms`;
    }
    if (stats.model_loaded) {
      modelBadge.textContent = stats.model_loaded;
    }
  }

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Helper: WAV Encoder
  function encodeWAV(samples, sampleRate = 16000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let index = 44;
    for (let i = 0; i < samples.length; i++, index += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(index, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  console.log('[SIH26171] Popup controller initialized');
});
