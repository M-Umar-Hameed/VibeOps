import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { getSettings, saveSettings } from "../settings.js";
import { projects } from "../api/projects.js";
import { Banner } from "../components/Banner.js";

export function SettingsScreen() {
  const nav = useNavigate();
  const [baseUrl, setBaseUrl] = useState("http://localhost:8787");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setBaseUrl(s.baseUrl);
      setApiKey(s.apiKey);
    });
  }, []);

  async function test() {
    await saveSettings({ baseUrl, apiKey });
    try { await projects.list(); setStatus("ok"); }
    catch { setStatus("bad"); }
  }
  async function save() { await saveSettings({ baseUrl, apiKey }); nav({ to: "/" }); }

  return (
    <div>
      <h2>Settings</h2>
      <label>Server URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
      <label>API Key <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
      <button onClick={test}>Test connection</button>
      <button onClick={save}>Save</button>
      {status === "ok" && <Banner kind="info" message="Connected" />}
      {status === "bad" && <Banner kind="error" message="Key rejected or server unreachable" />}
    </div>
  );
}
