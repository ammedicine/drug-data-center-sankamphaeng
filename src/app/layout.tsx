import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Thai } from "next/font/google";

import "./globals.css";

/**
 * IBM Plex Sans Thai has the clearest Thai letterforms at 13-14px of the
 * open fonts, and its figures are unambiguous - which matters on a screen that
 * is mostly quantities. Loaded through next/font so the file is self-hosted and
 * the layout never shifts while it downloads.
 */
const thai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-thai",
});

export const metadata: Metadata = {
  title: {
    default: "ศูนย์ข้อมูลการใช้ยา อำเภอสันกำแพง",
    template: "%s · ศูนย์ข้อมูลการใช้ยา",
  },
  description:
    "ระบบรวบรวมและวิเคราะห์ปริมาณการจ่ายยาจาก JHCIS ของโรงพยาบาลส่งเสริมสุขภาพตำบล อำเภอสันกำแพง",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#17252f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={thai.variable}>
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
