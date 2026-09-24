"use client";

import { useEffect } from "react";

/** Records a client view once per page load (runs only in real browsers, not link previewers). */
export function ViewTracker({ token }: { token: string }) {
  useEffect(() => {
    const key = `dd-viewed-${token}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* storage unavailable */
    }
    void fetch(`/api/public/${token}/view`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
  }, [token]);
  return null;
}
