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

// Linking is the worker's job: we save the key, ask the worker to re-register,
// then watch the server list until OUR profile's instance appears. The options
// page itself never registers - that used to leave a phantom instance nobody
// polled, and batches sent to it timed out (504).
async function waitForOwnInstance(apiKey, timeoutMs) {
  const profileId = await getProfileId();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const instances = await probe(apiKey);
    const mine = instances.find((i) => i.profileId === profileId);
    if (mine) return mine;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
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
    await probe(apiKey); // reject a bad key before touching stored state
    await chrome.storage.local.set({ apiKey });
    // Wakes the worker if Chrome killed it; no receiver is not an error here.
    await chrome.runtime.sendMessage("relink").catch(() => {});
    const mine = await waitForOwnInstance(apiKey, 10000);
    if (mine) setReadout("linked", "Linked", mine.instanceId.slice(0, 8));
    else setReadout("failed", "Link failed", "", "Server is up but the extension did not register within 10s - try reloading the extension.");
  } catch (err) {
    setReadout("failed", "Link failed", "", String(err.message || err)
      + " - check that the VibeOps server is running on 127.0.0.1:8787.");
  } finally {
    saveButton.disabled = false;
  }
});

// On load: restore the key, then verify against the server. Linked means OUR
// instance is in the server's live list - not merely that the server answers,
// and never remembered local state. A dead session must read as disconnected.
chrome.storage.local.get(["apiKey"]).then(async ({ apiKey }) => {
  if (!apiKey) return;
  apiKeyInput.value = apiKey;
  setReadout("checking", "Checking");
  try {
    const [instances, profileId] = await Promise.all([probe(apiKey), getProfileId()]);
    const mine = instances.find((i) => i.profileId === profileId);
    if (mine) {
      setReadout("linked", "Linked", mine.instanceId.slice(0, 8));
    } else {
      setReadout("failed", "Not linked", "",
        "Server is up but this browser has no live session. " +
        "The extension reconnects within about 30 seconds, or click Save to link now.");
    }
  } catch (err) {
    setReadout("failed", "Not reachable", "", String(err.message || err)
      + " - is the VibeOps server running?");
  }
});
