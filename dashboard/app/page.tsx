import { DashboardBoundary } from "@/components/dashboard-boundary";
export const dynamic = "force-dynamic";
export default function DashboardPage() {
  return (
    <DashboardBoundary
      config={{
        apiUrl: process.env["API_URL"] || "http://localhost:8080",
        siteUrl: process.env["SITE_URL"] || "https://skyhold.ing",
        googleClientId: process.env["GOOGLE_CLIENT_ID"] || "",
        development: process.env["APP_ENV"] === "development",
      }}
    />
  );
}
