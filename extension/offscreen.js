/**
 * SIH26171 — Offscreen Processor
 * Handles offscreen canvas cropping and 16kHz mono audio processing.
 * Owner: Mohit
 */

let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let audioStream = null;
let mediaStreamSource = null;
let audioProcessor = null;
let recordedPCMData = [];

// Message Listener for Offscreen tasks
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'crop_image':
      cropImagePatch(message.payload)
        .then(result => sendResponse({ success: true, result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // Keep channel open for async

    case 'start_audio_recording':
      startAudioRecording()
        .then(() => sendResponse({ success: true, status: 'recording' }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stop_audio_recording':
      stopAudioRecording()
        .then(result => sendResponse({ success: true, ...result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown offscreen task' });
  }
});

/**
 * Crops a sub-region from a base64 screenshot.
 * @param {Object} payload { image_base64, region: {x, y, w, h} }
 */
async function cropImagePatch(payload) {
  const { image_base64, region } = payload;
  if (!image_base64 || !region) {
    throw new Error('Missing image or region coordinates for crop');
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.getElementById('crop-canvas') || document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(region.w || 100));
        canvas.height = Math.max(1, Math.round(region.h || 100));
        const ctx = canvas.getContext('2d');

        // Draw sub-region
        ctx.drawImage(
          img,
          Math.max(0, region.x || 0),
          Math.max(0, region.y || 0),
          Math.max(1, region.w || 100),
          Math.max(1, region.h || 100),
          0,
          0,
          canvas.width,
          canvas.height
        );

        const croppedBase64 = canvas.toDataURL('image/png');
        resolve({
          image_base64: croppedBase64,
          width: canvas.width,
          height: canvas.height,
          region
        });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (err) => reject(new Error('Failed to load image for cropping: ' + err));
    img.src = image_base64.startsWith('data:') ? image_base64 : `data:image/png;base64,${image_base64}`;
  });
}

/**
 * Start capturing microphone stream and downsample to 16kHz PCM
 */
async function startAudioRecording() {
  recordedPCMData = [];
  audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  mediaStreamSource = audioContext.createMediaStreamSource(audioStream);

  // Buffer size 4096, 1 input channel, 1 output channel
  audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  audioProcessor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);
    recordedPCMData.push(new Float32Array(inputData));
  };

  mediaStreamSource.connect(audioProcessor);
  audioProcessor.connect(audioContext.destination);
}

/**
 * Stop capturing audio, encode PCM to 16kHz Mono 16-bit WAV, and return Base64
 */
async function stopAudioRecording() {
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
  let totalLength = 0;
  for (const chunk of recordedPCMData) {
    totalLength += chunk.length;
  }

  const mergedPCM = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of recordedPCMData) {
    mergedPCM.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert to 16-bit PCM WAV
  const wavBuffer = encodeWAV(mergedPCM, 16000);
  const base64Wav = bufferToBase64(wavBuffer);

  return {
    audio_base64: base64Wav,
    sample_rate: 16000,
    duration_sec: totalLength / 16000
  };
}

/**
 * Encodes Float32Array PCM samples into standard 16-bit mono WAV ArrayBuffer.
 */
function encodeWAV(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw PCM = 1) */
  view.setUint16(20, 1, true);
  /* channel count (mono = 1) */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sampleRate * 1 channel * 2 bytes) */
  view.setUint32(28, sampleRate * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * 2, true);

  // Write PCM samples (convert float [-1.0, 1.0] to 16-bit signed integer)
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
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
