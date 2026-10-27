import { LoginForm } from "@/components/login-form";

export const metadata = { title: "Sign in · StoreIQ Simple Virtual Shield" };

export default function LoginPage() {
  return (
    <main className="login-wrap">
      <div className="card login-card stack">
        <div className="brand" style={{ border: 0, padding: 0 }}>
          <div className="brand-mark" aria-hidden>
            SV
          </div>
          <div>
            <div className="brand-name">StoreIQ Simple Virtual Shield</div>
            <div className="brand-sub">Scan normally. Clean virtually. Trust your inventory.</div>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
