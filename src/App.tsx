import { useEffect, useState } from "react";
import { fetchAppInfo, formatAppInfo, type AppInfo } from "./lib/appInfo";

type Status = "loading" | "ready" | "error";

export default function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAppInfo()
      .then((result) => {
        if (!cancelled) {
          setInfo(result);
          setStatus("ready");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(String(err));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app">
      <h1>AI Reel Studio</h1>
      <p className="subtitle">Phase 0 &mdash; desktop foundation</p>
      {status === "loading" && <p>Connecting to native backend&hellip;</p>}
      {status === "ready" && info && (
        <p className="verified" data-testid="foundation-status">
          Foundation verified &mdash; {formatAppInfo(info)}
        </p>
      )}
      {status === "error" && (
        <p className="error" data-testid="foundation-error">
          Backend unavailable: {error}
        </p>
      )}
    </main>
  );
}
