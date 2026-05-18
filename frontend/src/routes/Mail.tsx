// PHASE B placeholder. Mail with identity-switching ships in the next
// milestone — separate router for send-as-Charlie, ViewingAsContext for
// view-as-X, audit log for every fetch.
export function MailPage() {
  return (
    <section className="space-y-3">
      <header>
        <h1 className="text-lg font-sans font-semibold text-ink-100">Mail</h1>
        <p className="text-xs text-ink-300">View as any agent · sends always logged as Charlie</p>
      </header>
      <div className="panel panel-body text-sm text-ink-300">
        <p className="font-medium text-ink-200 mb-1">Phase B</p>
        <p>
          Mail with identity-switching lands in milestone B. Use <code className="text-ink-100">gc mail inbox &lt;alias&gt;</code> from a terminal until then.
        </p>
      </div>
    </section>
  );
}
