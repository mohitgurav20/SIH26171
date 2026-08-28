document.addEventListener('DOMContentLoaded', () => {
  const grantBtn = document.getElementById('grant-btn');
  const statusMsg = document.getElementById('status-msg');

  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately
      stream.getTracks().forEach(t => t.stop());
      statusMsg.textContent = '✓ Microphone access granted! Returning to agent...';
      chrome.storage.local.set({ mic_permission_granted: true });
      setTimeout(() => {
        window.close();
      }, 1000);
    } catch (err) {
      statusMsg.textContent = '❌ Microphone access denied: ' + err.message;
      statusMsg.style.color = '#ef4444';
    }
  }

  grantBtn.addEventListener('click', requestMic);
  // Auto-request on page load
  requestMic();
});
