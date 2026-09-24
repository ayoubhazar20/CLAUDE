import { findInvitation } from "@/server/services/members";
import { getCurrentUser } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Alert, ButtonLink } from "@/components/ui";
import { InviteForm } from "./invite-form";

export const metadata = { title: "Join your team" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await findInvitation(token);
  if (!invitation) {
    return <Alert tone="error" title="Invitation unavailable">This invitation is invalid, was revoked or has expired. Ask your administrator for a new one.</Alert>;
  }
  const current = await getCurrentUser();
  const existing = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
  const needsLogin = Boolean(existing) && current?.id !== existing?.id;
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Join {invitation.organization.name}</h1>
      <p className="mb-6 text-sm text-slate-600">
        You were invited as <strong>{invitation.role.name}</strong> ({invitation.email}).
      </p>
      {needsLogin ? (
        <ButtonLink href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in as {invitation.email} to accept</ButtonLink>
      ) : (
        <InviteForm token={token} needsAccount={!existing} />
      )}
    </>
  );
}
