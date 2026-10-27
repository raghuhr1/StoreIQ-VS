import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          {title && <h2 style={{ margin: 0 }}>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  COMPLETED: "ok",
  ACCEPTED: "ok",
  FAILED: "bad",
  REJECTED_FROM_ZONE: "bad",
  NEEDS_REVIEW: "warn",
  QUEUED: "info",
  PARSING: "info",
  CLASSIFYING: "info",
  EXPORTING: "info",
  RECEIVED: "neutral",
  FILE_DELETED: "neutral",
  HIGH: "ok",
  MEDIUM: "warn",
  LOW: "bad",
};

export function Badge({ value, tone }: { value: string; tone?: "ok" | "warn" | "bad" | "info" | "neutral" }) {
  const t = tone ?? STATUS_TONE[value] ?? "neutral";
  return <span className={`badge badge-${t}`}>{value.replace(/_/g, " ")}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "bad" | "ok";
  children: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="card">
      <h1>Access denied</h1>
      <p className="muted">
        Your role does not permit access to this section. Contact your administrator if you need access.
      </p>
    </div>
  );
}

/** Explicit placeholder for metrics that require labeled ground truth. */
export function NeedsGroundTruth() {
  return <span className="muted">Not available — labeled ground truth required</span>;
}
