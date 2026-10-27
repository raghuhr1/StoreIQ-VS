import { PasswordForm } from "@/components/password-form";
import { pageAuth } from "@/server/auth/page";

export const metadata = { title: "Change password · StoreIQ Simple Virtual Shield" };

export default async function ChangePasswordPage() {
  const ctx = await pageAuth({ allowPasswordChange: true });
  return (
    <main className="login-wrap">
      <div className="card login-card stack">
        <h1>Change password</h1>
        {ctx.mustChangePassword && (
          <p className="muted">You signed in with a temporary password. Choose a new password to continue.</p>
        )}
        <PasswordForm forced={ctx.mustChangePassword} />
      </div>
    </main>
  );
}
