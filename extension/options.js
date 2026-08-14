// Options page script — no chrome globals used in pure functions
// All page-derived and server-derived strings rendered via textContent (never innerHTML)

const API_BASE = "http://127.0.0.1:8787";

const apiKeyInput = document.getElementById("apiKey");
const saveButton = document.getElementById("save");
const statusDiv = document.getElementById("status");

function showStatus(message, isError) {
  statusDiv.textContent = message;
  statusDiv.className = isError ? "error" : "success";
}

async function getProfileId() {
  let { profileId } = await chrome.storage.local.get("profileId");
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  return profileId;
}

async function testRegistration(apiKey) {
  const profileId = await getProfileId();

  const res = await fetch(`${API_BASE}/browser/instances/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      browserChannel: "chrome",
      profileId,
      profileLabel: "Default",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Registration failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.instanceId;
}

saveButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    showStatus("Please enter an API key", true);
    return;
  }

  saveButton.disabled = true;
  statusDiv.textContent = "Testing connection...";
  statusDiv.className = "";

  try {
    await chrome.storage.local.set({ apiKey });
    const instanceId = await testRegistration(apiKey);
    await chrome.storage.local.set({ instanceId });
    showStatus(`Registration succeeded. Instance ID: ${instanceId}`, false);
  } catch (err) {
    showStatus(String(err), true);
  } finally {
    saveButton.disabled = false;
  }
});

// Load existing key on page load
chrome.storage.local.get(["apiKey", "instanceId"]).then(({ apiKey, instanceId }) => {
  if (apiKey) {
    apiKeyInput.value = apiKey;
  }
  if (instanceId) {
    showStatus(`Connected. Instance ID: ${instanceId}`, false);
  }
});
