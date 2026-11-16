import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthBridge } from "@/components/auth-bridge";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Marigold",
  description: "An AI agent that quietly gets things done for you.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Marigold",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full">
        {/* Touch ID (WebAuthn) refuses IP addresses — always use the localhost name. */}
        <script dangerouslySetInnerHTML={{ __html: `if(location.hostname==="127.0.0.1"){location.replace(location.href.replace("//127.0.0.1","//localhost"))}if(/access_token=|[?&]code=/.test(location.hash+location.search)){try{sessionStorage.setItem("mg_signin_return","1")}catch(e){}}` }} />
        <AuthBridge />
        {children}
      </body>
    </html>
  );
}
