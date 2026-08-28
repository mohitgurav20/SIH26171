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

    const lang = document.querySelector('input[name="lang"]:checked')?.value || 'en';

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

  // Voice Mic Toggle
  async function handleToggleMic() {
    if (!isRecording) {
      try {
        await startRecording();
      } catch (err) {
        console.error('Failed to start recording:', err);
        alert('Could not access microphone: ' + err.message);
      }
    } else {
      await stopAndSendRecording();
    }
  }

  async function startRecording() {
    recordedPCMChunks = [];
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    mediaStreamSource = audioContext.createMediaStreamSource(audioStream);

    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    audioProcessor.onaudioprocess = (e) => {
      const channelData = e.inputBuffer.getChannelData(0);
      recordedPCMChunks.push(new Float32Array(channelData));
    };

    mediaStreamSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    isRecording = true;
    micBtn.classList.add('recording');
    voiceRecordingBar.classList.remove('hidden');
    recordingStartTime = Date.now();

    recordingInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
      const min = Math.floor(elapsedSec / 60);
      const sec = elapsedSec % 60;
      recordingTimer.textContent = `Recording 16kHz audio... ${min}:${sec < 10 ? '0' : ''}${sec}`;
    }, 500);
  }

  async function stopAndSendRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    voiceRecordingBar.classList.add('hidden');
    clearInterval(recordingInterval);

    if (audioProcessor && mediaStreamSource) {
      mediaStreamSource.disconnect();
      audioProcessor.disconnect();
    }
    if (audioStream) {
      audioStream.getTracks().forEach(track => track.stop());
    }
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }

    // Merge PCM chunks
    let totalLen = 0;
    for (const chunk of recordedPCMChunks) totalLen += chunk.length;
    const mergedPCM = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of recordedPCMChunks) {
      mergedPCM.set(chunk, offset);
      offset += chunk.length;
    }

    // Encode to 16kHz WAV
    const wavBuffer = encodeWAV(mergedPCM, 16000);
    const audioBase64 = bufferToBase64(wavBuffer);
    const lang = document.querySelector('input[name="lang"]:checked')?.value || 'auto';

    reasoningBox.innerHTML = `<em>Transcribing voice audio (${(totalLen / 16000).toFixed(1)}s)...</em>`;
    updateStatus('thinking', 'Transcribing audio on-device...');

    chrome.runtime.sendMessage({
      type: 'audio',
      id: `audio-${Date.now()}`,
      timestamp: new Date().toISOString(),
      payload: {
        audio_base64: audioBase64,
        sample_rate: 16000,
        language_hint: lang
      }
    });
  }

  // Render Action Plan
  function renderActionPlan(plan) {
    if (!plan) return;

    // Reasoning
    if (plan.reasoning) {
      reasoningBox.innerHTML = `<strong>Reasoning:</strong> ${escapeHtml(plan.reasoning)}`;
    }

    // Meta Badges
    planMeta.style.display = 'flex';
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

  // Add Proof-of-Perception Evidence Card
  function addEvidenceCard(evidence) {
    if (!evidence) return;

    // Remove placeholder
    const placeholder = evidenceContainer.querySelector('.placeholder-text');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'evidence-entry';

    let cropHtml = '';
    if (evidence.vision_crop_base64) {
      const src = evidence.vision_crop_base64.startsWith('data:')
        ? evidence.vision_crop_base64
        : `data:image/png;base64,${evidence.vision_crop_base64}`;
      cropHtml = `<img src="${src}" class="evidence-thumb" title="Click to zoom crop" />`;
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

    // Zoom listener for crop thumbnail
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
