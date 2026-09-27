"use client";
import dynamic from "next/dynamic";
import type { RuntimeConfig } from "@/lib/types";
const Dashboard = dynamic(() => import("./dashboard"), {
  ssr: false,
  loading: () => (
    <main className="boot-screen" role="status">
      Opening content studio…
    </main>
  ),
});
export function DashboardBoundary({ config }: { config: RuntimeConfig }) {
  return <Dashboard config={config} />;
}
