"use client";

import { Button } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <h1 className="text-xl font-semibold">{offline ? "Connection lost" : "Something went wrong"}</h1>
      <p className="mt-2 text-sm text-slate-600">
        {offline ? "Check your internet connection and try again." : "The page could not be loaded. If this keeps happening, contact support with the reference below."}
      </p>
      {error.digest ? <p className="mt-2 font-mono text-xs text-slate-500">Reference: {error.digest}</p> : null}
      <Button className="mt-6" onClick={reset}>Try again</Button>
    </div>
  );
}
