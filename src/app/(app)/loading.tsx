export default function Loading() {
  return (
    <div className="flex items-center gap-3 py-20 text-sm text-slate-500" role="status" aria-live="polite">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden="true" />
      Loading…
    </div>
  );
}
