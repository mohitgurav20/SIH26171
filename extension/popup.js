/**
 * SIH26171 — Aero Agent Popup Controller
 * Premium Pink & White Edition
 * Direct Speech Recognition & Live Transcription Engine
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const commandInput = document.getElementById('command-input');
  const sendBtn = document.getElementById('send-btn');
  const micBtn = document.getElementById('mic-btn');
  const toggleTagsBtn = document.getElementById('toggle-tags-btn');
  const statusIndicator = document.getElementById('status-indicator');
  const voiceRecordingBar = document.getElementById('voice-recording-bar');
  const recordingTimer = document.getElementById('recording-timer');
  const liveTranscript = document.getElementById('live-transcript');
  const voiceStopBtn = document.getElementById('voice-stop-btn');
  const micStatusLabel = document.getElementById('mic-status-label');

  const planMeta = document.getElementById('plan-meta');
  const confidenceBadge = document.getElementById('confidence-badge');
  const sourceBadge = document.getElementById('source-badge');
  const reasoningBox = document.getElementById('reasoning-box');
  const planStepsContainer = document.getElementById('plan-steps-container');
  const planStepsList = document.getElementById('plan-steps-list');

  const verifyLogBtn = document.getElementById('verify-log-btn');

  // Clarification Card
  const clarificationCard = document.getElementById('clarification-card');
  const clarifyTitle = document.getElementById('clarify-title');
  const clarifySubtitle = document.getElementById('clarify-subtitle');
  const clarifyFields = document.getElementById('clarify-fields');
  const clarifyCancelBtn = document.getElementById('clarify-cancel-btn');
  const clarifySpeakBtn = document.getElementById('clarify-speak-btn');
  const clarifyRunBtn = document.getElementById('clarify-run-btn');
  const clarifyVoiceHint = document.getElementById('clarify-voice-hint');

  // Confirmation Modal
  const confirmationModal = document.getElementById('confirmation-modal');
  const modalMessage = document.getElementById('modal-message');
  const modalDetails = document.getElementById('modal-details');
  const modalConfirmBtn = document.getElementById('modal-confirm-btn');
  const modalRejectBtn = document.getElementById('modal-reject-btn');

  // State
  let currentClarification = null;
  let isRecording = false;
  let recordingStartTime = null;
  let recordingInterval = null;
  let waveAnimInterval = null;
  let overlaysVisible = false;
  let currentPendingConfirmationId = null;
  let localSpeechRec = null;
  let alwaysOnMode = false;        // Always-on continuous voice mode
  let autoResumeTimer = null;      // Timer to auto-resume listening
  let lastExecutedCommand = '';    // Dedup: avoid re-running same command

  // Initialize status from background service worker
  chrome.runtime.sendMessage({ type: 'get_initial_state' }, (res) => {
    if (res && res.status) {
      updateStatus(res.status.state, res.status.message);
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

  if (voiceStopBtn) {
    voiceStopBtn.addEventListener('click', () => {
      if (isRecording) handleToggleMic();
    });
  }

  // Event Listener: Toggle Tags Overlay
  toggleTagsBtn.addEventListener('click', () => {
    overlaysVisible = !overlaysVisible;
    chrome.runtime.sendMessage({
      type: 'toggle_overlays',
      show: overlaysVisible
    });
    toggleTagsBtn.style.borderColor = overlaysVisible ? '#f43f5e' : '';
    toggleTagsBtn.style.color = overlaysVisible ? '#f43f5e' : '';
  });

  // Always-On Mode Toggle Button (injected dynamically)
  const alwaysOnBtn = document.createElement('button');
  alwaysOnBtn.id = 'always-on-btn';
  alwaysOnBtn.className = 'util-btn';
  alwaysOnBtn.title = 'Toggle Always-On Voice Mode';
  alwaysOnBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
    </svg>
    Always-On: OFF
  `;
  document.querySelector('.utility-row').appendChild(alwaysOnBtn);

  alwaysOnBtn.addEventListener('click', () => {
    alwaysOnMode = !alwaysOnMode;
    if (alwaysOnMode) {
      alwaysOnBtn.style.borderColor = '#8b5cf6';
      alwaysOnBtn.style.color = '#8b5cf6';
      alwaysOnBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="22"/>
        </svg>
        🟣 Always-On: ON
      `;
      updateStatus('online', '🎙️ Always Listening...');
      // Auto-start listening if not already
      if (!isRecording) handleToggleMic();
    } else {
      alwaysOnBtn.style.borderColor = '';
      alwaysOnBtn.style.color = '';
      alwaysOnBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px">
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="22"/>
        </svg>
        Always-On: OFF
      `;
      if (autoResumeTimer) { clearTimeout(autoResumeTimer); autoResumeTimer = null; }
      // Stop listening if active from always-on
      if (isRecording) handleToggleMic();
      updateStatus('online', 'Agent Ready');
    }
  });

  // Event Listener: Verify Hash Chain
  verifyLogBtn.addEventListener('click', () => {
    verifyLogBtn.disabled = true;
    verifyLogBtn.textContent = 'Verifying...';
    chrome.runtime.sendMessage({ type: 'verify_log' });

    setTimeout(() => {
      verifyLogBtn.disabled = false;
      verifyLogBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        Audit Log Verified ✓
      `;
    }, 600);
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

  // Event Listeners: Clarification Card
  clarifyCancelBtn.addEventListener('click', () => {
    clarificationCard.classList.add('hidden');
    currentClarification = null;
    updateStatus('online', 'Agent Ready');
  });

  clarifyRunBtn.addEventListener('click', submitClarification);

  clarifySpeakBtn.addEventListener('click', () => {
    clarifyVoiceHint.classList.remove('hidden');
    // Start listening for field inputs
    if (!isRecording) handleToggleMic();
  });

  function showClarificationDialog(req) {
    currentClarification = req;
    clarifyTitle.textContent = req.intentLabel || 'I need a few details';
    clarifySubtitle.textContent = 'Fill in the information below or speak:';
    clarifyFields.innerHTML = '';

    (req.fields || []).forEach((field) => {
      const row = document.createElement('div');
      row.className = 'clarify-field-row';

      const label = document.createElement('label');
      label.className = 'clarify-label';
      label.textContent = field.label;
      if (field.optional) {
        const opt = document.createElement('span');
        opt.className = 'opt-tag';
        opt.textContent = '(optional)';
        label.appendChild(opt);
      }

      const input = document.createElement('input');
      input.className = 'clarify-input';
      input.type = field.type === 'password' ? 'password' : 'text';
      input.dataset.key = field.key;
      input.value = field.prefilled || '';
      input.placeholder = `Enter ${field.label.toLowerCase()}...`;

      row.appendChild(label);
      row.appendChild(input);
      clarifyFields.appendChild(row);
    });

    clarificationCard.classList.remove('hidden');
    // Focus first empty input
    const firstEmpty = clarifyFields.querySelector('input:not([value])') || clarifyFields.querySelector('input');
    if (firstEmpty) setTimeout(() => firstEmpty.focus(), 100);
  }

  function submitClarification() {
    if (!currentClarification) return;
    const values = {};
    const inputs = clarifyFields.querySelectorAll('.clarify-input');
    inputs.forEach(inp => {
      values[inp.dataset.key] = inp.value.trim();
    });

    clarificationCard.classList.add('hidden');
    reasoningBox.innerHTML = `<strong>Autonomous Plan:</strong> Executing ${escapeHtml(currentClarification.intentLabel || 'task')}...`;
    updateStatus('thinking', 'Executing all steps autonomously...');

    chrome.runtime.sendMessage({
      type: 'clarification_reply',
      payload: {
        intent: currentClarification.intent,
        values
      }
    });

    currentClarification = null;
  }

  // Runtime Message Receiver
  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'status':
        updateStatus(message.payload?.state, message.payload?.message);
        break;

      case 'clarification_request':
        showClarificationDialog(message.payload);
        break;

      case 'action_plan':
        renderActionPlan(message.payload);
        break;

      case 'action_result':
        updateStepResult(message.payload);
        // In always-on mode, auto-resume listening 1.8s after task finishes
        if (alwaysOnMode && message.payload?.success !== false) {
          scheduleAutoResumeListen();
        }
        break;

      case 'speech_live_transcript':
        if (message.text) {
          handleSpeechTranscriptUpdate(message.text);
        }
        break;

      case 'transcription':
        if (message.payload?.text) {
          commandInput.value = message.payload.text;
          if (liveTranscript) {
            liveTranscript.textContent = message.payload.text;
            liveTranscript.classList.add('has-text');
          }
          reasoningBox.innerHTML = `<strong>Voice Command:</strong> "${escapeHtml(message.payload.text)}"`;
          handleSendCommand();
        }
        break;

      case 'voice_volume_level':
        if (voiceRecordingBar && !voiceRecordingBar.classList.contains('hidden')) {
          const waves = voiceRecordingBar.querySelectorAll('.wave-visualizer span');
          const lvl = message.level || 0.2;
          waves.forEach((s, idx) => {
            const h = Math.max(4, Math.min(18, Math.round(lvl * 22 * (0.6 + 0.4 * Math.sin(idx * 1.5 + Date.now() / 90)))));
            s.style.height = `${h}px`;
          });
        }
        break;

      case 'confirmation_request':
        showConfirmationModal(message.payload, message.id);
        break;
    }
  });

  /**
   * Schedule auto-resume listening after task completion (Always-On Mode).
   * Waits 1.8s so the user can see the result, then restarts mic.
   */
  function scheduleAutoResumeListen() {
    if (!alwaysOnMode) return;
    if (autoResumeTimer) clearTimeout(autoResumeTimer);
    autoResumeTimer = setTimeout(() => {
      autoResumeTimer = null;
      if (alwaysOnMode && !isRecording) {
        // Reset input for fresh command
        commandInput.value = '';
        lastExecutedCommand = '';
        if (liveTranscript) {
          liveTranscript.textContent = '🟣 Always-On: Listening for next command...';
          liveTranscript.classList.remove('has-text');
        }
        handleToggleMic();
        updateStatus('online', '🎙️ Always Listening...');
      }
    }, 1800);
  }

  // Voice Mic Toggle & Speech Coordination
  let speechSilenceTimer = null;

  function handleSpeechTranscriptUpdate(text) {
    if (!text) return;
    const cleanText = text.trim();
    if (!cleanText) return;

    if (liveTranscript) {
      liveTranscript.textContent = cleanText;
      liveTranscript.classList.add('has-text');
    }

    // If clarification dialog is active, map spoken text into clarification fields
    if (currentClarification && !clarificationCard.classList.contains('hidden')) {
      const parts = cleanText.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
      const inputs = clarifyFields.querySelectorAll('.clarify-input');
      inputs.forEach((inp, idx) => {
        if (parts[idx]) inp.value = parts[idx];
      });
      if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
      speechSilenceTimer = setTimeout(() => {
        if (isRecording) {
          handleToggleMic();
          submitClarification();
        }
      }, 4000);
      return;
    }

    commandInput.value = cleanText;

    // Auto-execute after 5s pause — gives user time to finish speaking naturally
    if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
    speechSilenceTimer = setTimeout(() => {
      if (isRecording && commandInput.value.trim().length > 2) {
        console.log('[Popup] Voice silence 5s auto-submit:', commandInput.value);
        handleToggleMic();
      }
    }, 5000);
  }

  async function handleToggleMic() {
    if (speechSilenceTimer) {
      clearTimeout(speechSilenceTimer);
      speechSilenceTimer = null;
    }

    if (!isRecording) {
      isRecording = true;
      micBtn.classList.add('recording');
      voiceRecordingBar.classList.remove('hidden');
      if (micStatusLabel) micStatusLabel.textContent = '🔴 Listening... Speak clearly now';
      recordingStartTime = Date.now();

      // Reset live transcript
      if (liveTranscript) {
        liveTranscript.textContent = 'Listening to your voice...';
        liveTranscript.classList.remove('has-text');
      }

      // Start dynamic wave visualizer
      if (waveAnimInterval) clearInterval(waveAnimInterval);
      waveAnimInterval = setInterval(() => {
        if (!isRecording) { clearInterval(waveAnimInterval); return; }
        const waves = voiceRecordingBar.querySelectorAll('.wave-visualizer span');
        waves.forEach((s) => {
          const h = 4 + Math.round(Math.random() * 14);
          s.style.height = `${h}px`;
        });
      }, 90);

      // Start recording timer
      if (recordingInterval) clearInterval(recordingInterval);
      recordingInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - recordingStartTime) / 1000);
        const min = Math.floor(elapsedSec / 60);
        const sec = elapsedSec % 60;
        if (recordingTimer) {
          recordingTimer.textContent = `${min}:${sec < 10 ? '0' : ''}${sec}`;
        }
      }, 500);

      // Trigger speech recognition in active tab
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        let activeTab = tabs?.[0];
        const triggerSpeech = (tabId) => {
          chrome.tabs.sendMessage(tabId, { type: 'start_speech_recognition' }, (res) => {
            if (chrome.runtime.lastError || !res?.success) {
              console.log('[Popup] Injecting content script for speech...');
              chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
              }).then(() => {
                setTimeout(() => {
                  chrome.tabs.sendMessage(tabId, { type: 'start_speech_recognition' }).catch(() => startLocalSpeechFallback());
                }, 100);
              }).catch(() => startLocalSpeechFallback());
            }
          });
        };

        if (activeTab?.id) {
          triggerSpeech(activeTab.id);
        } else {
          chrome.tabs.query({ active: true }, (fallbackTabs) => {
            if (fallbackTabs?.[0]?.id) {
              triggerSpeech(fallbackTabs[0].id);
            } else {
              startLocalSpeechFallback();
            }
          });
        }
      });
    } else {
      // Stop recording
      isRecording = false;
      micBtn.classList.remove('recording');
      voiceRecordingBar.classList.add('hidden');
      if (micStatusLabel) micStatusLabel.textContent = 'Tap to speak in English, Hindi, or Kannada';
      if (recordingInterval) clearInterval(recordingInterval);
      if (waveAnimInterval) clearInterval(waveAnimInterval);

      // Stop speech recognition across tabs
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'stop_speech_recognition' }).catch(() => {});
        }
      });
      chrome.tabs.query({ active: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'stop_speech_recognition' }).catch(() => {});
        }
      });
      stopLocalSpeechFallback();

      // Submit recognized text if present
      const capturedText = commandInput.value.trim();
      const isAlwaysOnResume = capturedText.toLowerCase().startsWith('🟣');
      if (capturedText && !capturedText.toLowerCase().startsWith('listening') && !isAlwaysOnResume && capturedText.length > 1) {
        // Dedup: don't re-execute same command back to back
        if (capturedText !== lastExecutedCommand) {
          lastExecutedCommand = capturedText;
          reasoningBox.innerHTML = `<strong>Voice Command:</strong> "${escapeHtml(capturedText)}"`;
          handleSendCommand();
        } else {
          scheduleAutoResumeListen();
        }
      } else if (!alwaysOnMode) {
        reasoningBox.innerHTML = `<em>No speech recognized. Tap mic and try speaking clearly, or type below.</em>`;
      } else {
        // In always-on mode, no speech = just resume listening again
        scheduleAutoResumeListen();
      }

      if (!alwaysOnMode) updateStatus('online', 'Agent Ready');
    }
  }

  function startLocalSpeechFallback() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    try {
      if (localSpeechRec) {
        try { localSpeechRec.abort(); } catch(e) {}
      }
      localSpeechRec = new SpeechRecognition();
      localSpeechRec.continuous = true;
      localSpeechRec.interimResults = true;
      localSpeechRec.lang = 'en-US';

      localSpeechRec.onresult = (event) => {
        let interimText = '';
        let finalText = '';
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalText += res[0].transcript + ' ';
          } else {
            interimText += res[0].transcript;
          }
        }
        handleSpeechTranscriptUpdate(finalText + interimText);
      };

      localSpeechRec.onerror = (e) => {
        if (e.error === 'network') {
          setTimeout(() => {
            if (isRecording && localSpeechRec) {
              try { localSpeechRec.start(); } catch(ex) {}
            }
          }, 300);
        }
      };

      localSpeechRec.start();
    } catch(e) {}
  }

  function stopLocalSpeechFallback() {
    if (localSpeechRec) {
      const r = localSpeechRec;
      localSpeechRec = null;
      try { r.stop(); } catch(e) {}
    }
  }

  // Command Submission Handler
  function handleSendCommand() {
    const text = commandInput.value.trim();
    if (!text) return;

    // Clear previous execution state
    planStepsList.innerHTML = '';
    planStepsContainer.style.display = 'none';
    planMeta.style.display = 'none';

    reasoningBox.innerHTML = `<strong>Planning:</strong> Analyzing active page DOM elements for "${escapeHtml(text)}"...`;
    updateStatus('thinking', 'Planning actions for command...');

    chrome.runtime.sendMessage({
      type: 'command',
      payload: {
        text,
        source: 'text',
        language: 'auto'
      }
    });
  }

  // Render Action Plan
  function renderActionPlan(plan) {
    if (!plan) return;

    if (plan.reasoning) {
      reasoningBox.innerHTML = `<strong>Reasoning:</strong> ${escapeHtml(plan.reasoning)}`;
    }

    planMeta.style.display = 'flex';
    const conf = Math.round((plan.confidence || 0.95) * 100);
    confidenceBadge.textContent = `${conf}% Match`;
    sourceBadge.textContent = (plan.source || 'DOM').toUpperCase();

    const actions = plan.actions || [];
    if (actions.length > 0) {
      planStepsContainer.style.display = 'flex';
      planStepsList.innerHTML = '';

      actions.forEach((act, idx) => {
        const stepNum = act.step !== undefined ? act.step : idx;
        const stepDiv = document.createElement('div');
        const isInstantDone = act.action === 'navigate';
        stepDiv.className = isInstantDone ? 'step-item done' : 'step-item';
        stepDiv.id = `step-item-${stepNum}`;

        stepDiv.innerHTML = `
          <div class="step-info" style="display:flex; align-items:center; gap:6px;">
            <span style="font-weight:700; color:#f43f5e; font-family:var(--font-mono);">#${act.tag_id || stepNum + 1}</span>
            <span style="font-weight:600; font-size:10px; background:#ffe4e6; color:#e11d48; padding:1px 5px; border-radius:4px;">${act.action || 'ACTION'}</span>
            <span>${escapeHtml(act.description || act.value || '')}</span>
          </div>
          <span class="step-badge" id="step-badge-${stepNum}" style="font-size:10px; font-weight:700; color:${isInstantDone ? '#059669' : '#6b7280'};">${isInstantDone ? 'Done ✓' : 'Queued'}</span>
        `;
        planStepsList.appendChild(stepDiv);
      });
      if (actions.some(a => a.action === 'navigate')) {
        updateStatus('online', 'Task Complete ✓');
        // Navigate actions resolve instantly — auto-resume for next command
        if (alwaysOnMode) scheduleAutoResumeListen();
      }
    } else {
      planStepsContainer.style.display = 'none';
      updateStatus('online', alwaysOnMode ? '🎙️ Always Listening...' : 'Agent Ready');
      if (alwaysOnMode) scheduleAutoResumeListen();
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
        stepDiv.className = 'step-item done';
        stepBadge.style.color = '#059669';
        stepBadge.textContent = 'Done ✓';
        updateStatus('online', 'Task Complete ✓');
      } else {
        stepDiv.className = 'step-item';
        stepBadge.style.color = '#ef4444';
        stepBadge.textContent = 'Failed ✗';
        updateStatus('error', result.error || 'Step failed');
      }
    }
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
    if (!statusIndicator) return;
    statusIndicator.className = 'status-pill';
    const label = statusIndicator.querySelector('.status-label');
    if (label) {
      if (state === 'thinking') {
        label.textContent = 'Thinking...';
      } else if (state === 'acting') {
        label.textContent = 'Executing...';
      } else {
        label.textContent = 'Ready';
      }
    }
  }

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  console.log('[Aero Agent] Popup controller initialized');
});
