// Options page script — no chrome globals used in pure functions
// All page-derived and server-derived strings rendered via textContent (never innerHTML)

const API_BASE = "http://127.0.0.1:8787";

const apiKeyInput = document.getElementById("apiKey");
const saveButton = document.getElementById("save");
const readout = document.getElementById("readout");
const stateEl = document.getElementById("state");
const detailEl = document.getElementById("detail");
const errorEl = document.getElementById("errorDetail");

// states: idle | checking | linked | failed
function setReadout(state, label, detail, error) {
  readout.className = "readout" + (state === "idle" ? "" : " " + state);
  stateEl.textContent = label;
  detailEl.textContent = detail || "";
  errorEl.textContent = error || "";
  errorEl.style.display = error ? "block" : "none";
}

async function getProfileId() {
  let { profileId } = await chrome.storage.local.get("profileId");
  if (!profileId) {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  return profileId;
}

// Cheap truth-probe: does the server answer this key? Read-only, creates nothing.
async function probe(apiKey) {
  const res = await fetch(`${API_BASE}/browser/instances`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return res.json();
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
    throw new Error(`registration failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.instanceId;
}

saveButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setReadout("failed", "Link failed", "", "Enter the server key first.");
    return;
  }

  saveButton.disabled = true;
  setReadout("checking", "Linking");

  try {
    await chrome.storage.local.set({ apiKey });
    const instanceId = await testRegistration(apiKey);
    await chrome.storage.local.set({ instanceId });
    setReadout("linked", "Linked", instanceId.slice(0, 8));
  } catch (err) {
    setReadout("failed", "Link failed", "", String(err.message || err)
      + " - check that the VibeOps server is running on 127.0.0.1:8787.");
  } finally {
    saveButton.disabled = false;
  }
});

// On load: restore the key, then probe the server so the readout shows the
// truth now, not the last saved state.
chrome.storage.local.get(["apiKey", "instanceId"]).then(async ({ apiKey, instanceId }) => {
  if (!apiKey) return;
  apiKeyInput.value = apiKey;
  setReadout("checking", "Checking");
  try {
    await probe(apiKey);
    setReadout("linked", "Linked", instanceId ? instanceId.slice(0, 8) : "server up");
  } catch (err) {
    setReadout("failed", "Not reachable", "", String(err.message || err)
      + " - is the VibeOps server running?");
  }
});
