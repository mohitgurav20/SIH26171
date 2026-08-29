document.addEventListener('DOMContentLoaded', () => {
  const grantBtn = document.getElementById('grant-btn');
  const statusMsg = document.getElementById('status-msg');

  async function requestMic() {
    statusMsg.textContent = 'Requesting microphone access... Please click "Allow" in Chrome popup';
    statusMsg.style.color = '#2563eb';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Test audio tracks
      stream.getTracks().forEach(t => t.stop());
      statusMsg.textContent = '✓ Microphone access granted successfully! You can close this tab and use voice in Aero Agent.';
      statusMsg.style.color = '#16a34a';
      grantBtn.textContent = '✓ Access Granted';
      grantBtn.style.background = '#16a34a';
      grantBtn.disabled = true;

      chrome.storage.local.set({ mic_permission_granted: true });
      setTimeout(() => {
        try { window.close(); } catch(e) {}
      }, 1500);
    } catch (err) {
      console.warn('getUserMedia error:', err);
      statusMsg.textContent = '❌ Microphone access error: ' + err.message + '. Please click the lock/tune icon next to URL to Allow microphone.';
      statusMsg.style.color = '#ef4444';
    }
  }

  grantBtn.addEventListener('click', requestMic);
});
