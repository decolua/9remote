import DownloadsPage from "@/features/landing/components/DownloadsPage";

export const metadata = {
  title: "Download 9Remote — macOS & Windows",
  description: "Download the 9Remote host app for macOS (.dmg) and Windows (.exe, installer or portable). Every version, direct from GitHub releases."
};

export default function DownloadRoute() {
  return <DownloadsPage />;
}
