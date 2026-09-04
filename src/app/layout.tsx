import type { Metadata, Viewport } from "next";

import "./globals.css";

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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th">
      <body className="min-h-screen bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
