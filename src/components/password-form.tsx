"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api-client";

export function PasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "bad" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("newPassword") !== f.get("confirm"))
      return setMsg({ tone: "bad", text: "New passwords do not match" });
    setBusy(true);
    try {
      await api("/api/v1/auth/password", {
        method: "POST",
        json: { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") },
      });
      if (forced) {
        router.replace("/dashboard");
        router.refresh();
      } else {
        form.reset();
        setMsg({ tone: "ok", text: "Password changed. Other sessions were signed out." });
      }
    } catch (err) {
      setMsg({ tone: "bad", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="stack" style={{ maxWidth: 380 }}>
      {msg && (
        <div className={`alert alert-${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
          {msg.text}
        </div>
      )}
      <div className="field">
        <label htmlFor="currentPassword">{forced ? "Temporary password" : "Current password"}</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <div className="field">
        <label htmlFor="newPassword">New password</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          aria-describedby="pw-hint"
        />
        <span id="pw-hint" className="hint">
          At least 12 characters. A passphrase is recommended.
        </span>
      </div>
      <div className="field">
        <label htmlFor="confirm">Confirm new password</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}
