"use client";

// Modified by ARemote: the self-hosted entry uses the device login.
import ARemoteLogin from "@/shared/aremote/Login";
import { AREMOTE } from "@/shared/aremote/client";
import LandingPage from "@/features/landing";

export default function HomePage() {
  if (AREMOTE) return <ARemoteLogin />;
  return <LandingPage />;
}
