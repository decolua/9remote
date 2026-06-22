import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { STORAGE_KEY, DEFAULT_THEME } from "@/shared/theme/themeConfig";
import { GoogleAnalytics } from "@next/third-parties/google";
import { GA_ID } from "@/shared/constants/analytics";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "9Remote Terminal",
  description: "Access your terminal from anywhere - secure remote terminal access",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "9Remote"
  },
  applicationName: "9Remote Terminal",
  icons: {
    icon: [
      { url: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
      { url: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" }
    ],
    apple: [
      { url: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" }
    ]
  },
  themeColor: "#121212"
};

export const viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    interactiveWidget: "resizes-content",
    // viewportFit: "cover",
    themeColor: "#121212"
};

// Inline script - apply theme class before paint to prevent FOUC
const themeInitScript = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}")||"${DEFAULT_THEME}";document.documentElement.classList.add(t);}catch(e){document.documentElement.classList.add("${DEFAULT_THEME}");}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').catch(function(err) {
                    console.log('SW registration failed:', err);
                  });
                });
              }
            `
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>{children}</ThemeProvider>
        {GA_ID && <GoogleAnalytics gaId={GA_ID} />}
      </body>
    </html>
  );
}
