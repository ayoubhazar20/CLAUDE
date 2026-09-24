"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { SignaturePad } from "./signature-pad";

interface Recipient {
  id: string;
  name: string;
  maskedEmail: string;
  signed: boolean;
  canActNow: boolean;
}

type Intent = "ACCEPT_QUOTE" | "SIGN_CONTRACT" | "REJECT_DOCUMENT";
type Step = "who" | "code" | "confirm" | "consent" | "signature" | "reject" | "done";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? "Something went wrong. Please try again.");
  return json as T;
}

export function PublicActions(props: { token: string; mode: "ACCEPT" | "SIGN"; documentType: "QUOTE" | "CONTRACT"; recipients: Recipient[]; brand: string; consentText: string; acceptanceText: string }) {
  const router = useRouter();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [step, setStep] = useState<Step>("who");
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [challenge, setChallenge] = useState<{ id: string; maskedEmail: string } | null>(null);
  const [code, setCode] = useState("");
  const [grant, setGrant] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [consent, setConsent] = useState(false);
  const [method, setMethod] = useState<"TYPED" | "DRAWN">("TYPED");
  const [typed, setTyped] = useState("");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [reason, setReason] = useState("");
  const [doneMessage, setDoneMessage] = useState("");

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const eligible = props.recipients.filter((r) => !r.signed);
  const primaryLabel = props.mode === "ACCEPT" ? "Accept quote" : props.documentType === "QUOTE" ? "Sign quote" : "Sign contract";
  const base = `/api/public/${props.token}`;

  const start = (i: Intent) => {
    setIntent(i);
    setError(null);
    setCode("");
    setGrant(null);
    setConsent(false);
    const candidates = i === "REJECT_DOCUMENT" ? props.recipients : eligible;
    if (candidates.length === 1) {
      setRecipient(candidates[0]!);
      void requestCode(candidates[0]!, i);
    } else {
      setRecipient(null);
      setStep("who");
    }
  };

  const requestCode = async (r: Recipient, i: Intent) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ challengeId: string; maskedEmail: string }>(`${base}/otp`, { recipientId: r.id, action: i });
      setChallenge({ id: res.challengeId, maskedEmail: res.maskedEmail });
      setSignerName(r.name);
      setStep("code");
      setCooldown(30);
    } catch (e) {
      setError((e as Error).message);
      setStep("who");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ grant: string }>(`${base}/verify`, { challengeId: challenge.id, code });
      setGrant(res.grant);
      setStep(intent === "ACCEPT_QUOTE" ? "confirm" : intent === "SIGN_CONTRACT" ? "consent" : "reject");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (url: string, body: unknown, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await post(url, body);
      setDoneMessage(message);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    const completed = step === "done";
    setIntent(null);
    setStep("who");
    // Refresh after the confirmation is dismissed so the page shows the new status.
    if (completed) router.refresh();
  };

  const btn = "inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold disabled:opacity-60";

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,.06)] backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            {props.mode === "ACCEPT" ? "Ready to go ahead? Accept this quote online." : eligible.length ? `Signature requested from ${eligible.map((r) => r.name).join(", ")}.` : "All signatures collected."}
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            <button type="button" className={`${btn} flex-1 border border-slate-300 bg-white text-slate-700 sm:flex-none`} onClick={() => start("REJECT_DOCUMENT")}>Decline</button>
            {eligible.length ? (
              <button type="button" className={`${btn} flex-1 text-white sm:flex-none`} style={{ background: props.brand }} onClick={() => start(props.mode === "ACCEPT" ? "ACCEPT_QUOTE" : "SIGN_CONTRACT")}>
                {primaryLabel}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <Modal open={intent !== null} onClose={close} title={intent === "REJECT_DOCUMENT" ? "Decline document" : primaryLabel}>
        {error ? <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">{error}</p> : null}

        {step === "who" ? (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">Who are you? We will send a verification code to your email.</p>
            {(intent === "REJECT_DOCUMENT" ? props.recipients : eligible).map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={busy || (intent === "SIGN_CONTRACT" && !r.canActNow)}
                onClick={() => { setRecipient(r); void requestCode(r, intent!); }}
                className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-3 text-left hover:bg-slate-50 disabled:opacity-50"
              >
                <span><span className="font-medium">{r.name}</span><span className="block text-xs text-slate-500">{r.maskedEmail}</span></span>
                {intent === "SIGN_CONTRACT" && !r.canActNow ? <span className="text-xs text-slate-500">Waiting for previous signer</span> : <span aria-hidden="true">→</span>}
              </button>
            ))}
            {busy ? <p className="text-sm text-slate-500">Sending code…</p> : null}
          </div>
        ) : null}

        {step === "code" && challenge ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <p className="text-sm text-slate-600">We sent a 6-digit code to <strong>{challenge.maskedEmail}</strong>. It expires in 10 minutes.</p>
            <label htmlFor="otp" className="block text-sm font-medium">Verification code</label>
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-md border border-slate-300 px-3 py-3 text-center text-2xl tracking-[0.5em]"
              autoFocus
            />
            <button type="submit" disabled={busy || code.length !== 6} className={`${btn} w-full text-white`} style={{ background: props.brand }}>{busy ? "Verifying…" : "Verify"}</button>
            <button type="button" disabled={cooldown > 0 || busy || !recipient} onClick={() => recipient && intent && void requestCode(recipient, intent)} className="w-full text-sm text-slate-600 underline disabled:no-underline disabled:opacity-60">
              {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
            </button>
          </form>
        ) : null}

        {step === "confirm" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">{props.acceptanceText}</p>
            <button type="button" disabled={busy} onClick={() => void finish(`${base}/accept`, { grant }, "Thank you — the quote has been accepted. A confirmation email is on its way.")} className={`${btn} w-full text-white`} style={{ background: props.brand }}>
              {busy ? "Accepting…" : "Confirm acceptance"}
            </button>
          </div>
        ) : null}

        {step === "consent" ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">Before signing, please confirm:</p>
            <label className="flex items-start gap-2 rounded-md border border-slate-200 p-3 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              <span>{props.consentText}</span>
            </label>
            <button type="button" disabled={!consent} onClick={() => setStep("signature")} className={`${btn} w-full text-white`} style={{ background: props.brand }}>Continue</button>
          </div>
        ) : null}

        {step === "signature" ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const signatureData = method === "TYPED" ? typed : drawn;
              if (!signatureData) {
                setError(method === "TYPED" ? "Type your name to sign." : "Draw your signature.");
                return;
              }
              void finish(`${base}/sign`, { grant, signerName, method, signatureData, consent: true }, "Thank you — your signature has been recorded. You will receive the completed document by email once all parties have signed.");
            }}
          >
            <div>
              <label htmlFor="signer-name" className="block text-sm font-medium">Full name</label>
              <input id="signer-name" value={signerName} onChange={(e) => setSignerName(e.target.value)} required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2" />
            </div>
            <div role="tablist" aria-label="Signature method" className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
              {(["TYPED", "DRAWN"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={method === m} onClick={() => setMethod(m)} className={`rounded px-3 py-1.5 text-sm font-medium ${method === m ? "bg-white shadow" : "text-slate-600"}`}>
                  {m === "TYPED" ? "Type" : "Draw"}
                </button>
              ))}
            </div>
            {method === "TYPED" ? (
              <div>
                <label htmlFor="typed-signature" className="block text-sm font-medium">Type your signature</label>
                <input id="typed-signature" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={signerName} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-3 font-serif text-3xl italic" />
              </div>
            ) : (
              <SignaturePad onChange={setDrawn} />
            )}
            <button type="submit" disabled={busy} className={`${btn} w-full text-white`} style={{ background: props.brand }}>{busy ? "Signing…" : "Sign"}</button>
            <p className="text-xs text-slate-500">This is an electronic signature verified by a one-time code sent to your email address.</p>
          </form>
        ) : null}

        {step === "reject" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void finish(`${base}/reject`, { grant, reason }, "The document has been declined. The sender has been notified."); }}>
            <label htmlFor="reason" className="block text-sm font-medium">Reason <span className="font-normal text-slate-500">(optional)</span></label>
            <textarea id="reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <button type="submit" disabled={busy} className={`${btn} w-full bg-red-600 text-white`}>{busy ? "Declining…" : "Decline document"}</button>
          </form>
        ) : null}

        {step === "done" ? (
          <div className="space-y-4 text-center">
            <p className="text-4xl" aria-hidden="true">✓</p>
            <p className="text-sm text-slate-700">{doneMessage}</p>
            <button type="button" onClick={close} className={`${btn} w-full border border-slate-300`}>Close</button>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
