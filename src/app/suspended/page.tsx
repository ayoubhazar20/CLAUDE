import { redirect } from "next/navigation";
export default function Suspended() {
  redirect("/pending-approval");
}
