import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { STORAGE_KEY, DEFAULT_THEME } from "@/shared/theme/themeConfig";
import { GoogleAnalytics } from "@next/third-parties/google";
import { GA_ID } from "@/shared/constants/analytics";
import RotateOverlay from "@/shared/components/ui/RotateOverlay";
import ScriptOnce from "@/shared/components/ui/ScriptOnce";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "9Remote — Remote Everything, Everywhere",
  description: "Remote IDE, desktop, files, emulator & vibe coding on PC, Web, iPad, and Mobile. Ultra-low latency WebRTC P2P dev suite.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "9Remote"
  },
  applicationName: "9Remote Terminal",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" }
    ]
  }
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

// Redirect Expo WebView from dev.9remote.cc to production 9remote.cc
const expoRedirectScript = `(function(){try{if(location.hostname==="dev.9remote.cc"&&(window.ReactNativeWebView||/9Remote-Mobile/i.test(navigator.userAgent))){location.replace("https://9remote.cc"+location.pathname+location.search+location.hash);}}catch(e){}})();`;

// Native shell bridge — expo injects the real status-bar inset via
// handleSafeAreaInset; web applies it as --pl-top (0 when unset, so browsers/PWA
// are unaffected). Bottom inset is owned by bottom bars (.safe-area-bottom).
const safeAreaScript = `window.handleSafeAreaInset=function(top,bottom){try{document.documentElement.style.setProperty("--pl-top",Math.max(top||0,0)+"px");}catch(e){}};`;

// Clipboard-read blocker — neutralizes navigator.clipboard.readText/.read at the
// browser API level so no library (xterm core OSC52, CodeMirror, addon) can trigger
// a clipboard-read permission prompt. No web feature reads the clipboard today
// (useClipboardBus + ClipboardModal only write). Uncomment the script tag below
// (and add key) to activate; currently commented while investigating the prompt source.
// const clipboardBlockScript = `(function(){try{var c=navigator.clipboard;if(c){c.readText=function(){return Promise.resolve("");};c.read=function(){return Promise.resolve([]);};}}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="scroll-smooth scroll-pt-20" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* ScriptOnce: theme-init still runs before paint (SSR HTML), no React 19 script warning */}
        <ScriptOnce id="expo-redirect" html={expoRedirectScript} />
        <ScriptOnce id="theme-init" html={themeInitScript} />
        <ScriptOnce id="safe-area-bridge" html={safeAreaScript} />
        <ScriptOnce
          id="sw-register"
          html={`if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(e){console.log('SW registration failed:',e);});});}`}
        />
        <ThemeProvider>{children}</ThemeProvider>
        <RotateOverlay />
        {GA_ID && <GoogleAnalytics gaId={GA_ID} />}
      </body>
    </html>
  );
}
