import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "NimbusVault · خزنة سحابية مشفّرة بمساحة 1 تيرابايت",
  description:
    "تخزين سحابي مشفّر من الطرف للطرف (Zero-Knowledge) بمساحة 1 تيرابايت، رفع مجزأ متوازي عبر روابط موقعة مسبقاً، وبث فوري للوسائط دون استهلاك مساحة الجهاز.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
