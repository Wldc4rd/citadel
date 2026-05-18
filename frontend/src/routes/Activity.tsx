// PHASE C placeholder — commits, builds, dev-deploy history. Lands in
// milestone C.
export function ActivityPage() {
  return (
    <section className="space-y-3">
      <header>
        <h1 className="text-lg font-sans font-semibold text-ink-100">Activity</h1>
        <p className="text-xs text-ink-300">Commits, builds, dev-deploy history</p>
      </header>
      <div className="panel panel-body text-sm text-ink-300">
        <p className="font-medium text-ink-200 mb-1">Phase C</p>
        <p>
          Recent commits + dev-deploy parsing land in milestone C. Use <code className="text-ink-100">git log</code> / <code className="text-ink-100">tail .dev-deploy-log</code> for now.
        </p>
      </div>
    </section>
  );
}
