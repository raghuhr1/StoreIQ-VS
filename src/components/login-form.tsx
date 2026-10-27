"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api-client";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mustChangePassword: boolean }>("/api/v1/auth/login", {
        method: "POST",
        json: { email: f.get("email"), password: f.get("password") },
      });
      window.location.href = r.data.mustChangePassword ? "/change-password" : "/dashboard";
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="stack" noValidate>
      {error && (
        <div className="alert alert-bad" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
