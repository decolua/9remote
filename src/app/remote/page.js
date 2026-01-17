"use client";

import { Suspense } from "react";
import RemoteDesktop from "@/features/remote/components/RemoteDesktop";
import Spinner from "@/shared/components/ui/Spinner";

export default function RemotePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Spinner size="lg" text="Loading remote desktop..." />
      </div>
    }>
      <RemoteDesktop />
    </Suspense>
  );
}
