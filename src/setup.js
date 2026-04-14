'use strict';

const folderDisplay = document.getElementById('folderDisplay');
const browseBtn     = document.getElementById('browseBtn');
const continueBtn   = document.getElementById('continueBtn');
const statusMsg     = document.getElementById('statusMsg');

window.electronAPI.getAssetsPath().then(p => {
  document.getElementById('assetsPathDisplay').textContent = p;
});

let selectedPath = null;

function showStatus(message, type) {
  statusMsg.textContent = message;
  statusMsg.className = `status-msg show ${type}`;
}

function hideStatus() {
  statusMsg.className = 'status-msg';
}

browseBtn.addEventListener('click', async () => {
  browseBtn.disabled = true;
  browseBtn.textContent = 'Opening…';

  try {
    const folderPath = await window.electronAPI.selectFolder();

    if (!folderPath) {
      // User cancelled
      showStatus('No folder selected.', 'error');
    } else {
      selectedPath = folderPath;
      folderDisplay.textContent = folderPath;
      folderDisplay.classList.add('has-path');
      continueBtn.classList.add('visible');
      showStatus('Folder selected! Click "Continue to Dashboard" to proceed.', 'success');
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    browseBtn.disabled = false;
    browseBtn.textContent = 'Browse…';
  }
});

continueBtn.addEventListener('click', async () => {
  if (!selectedPath) return;

  continueBtn.disabled = true;
  continueBtn.textContent = 'Saving…';
  hideStatus();

  try {
    const ok = await window.electronAPI.saveConfig({ historyFolder: selectedPath });
    if (ok) {
      await window.electronAPI.navigateToDashboard();
    } else {
      showStatus('Failed to save configuration. Check app permissions.', 'error');
      continueBtn.disabled = false;
      continueBtn.textContent = 'Continue to Dashboard';
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
    continueBtn.disabled = false;
    continueBtn.textContent = 'Continue to Dashboard';
  }
});
