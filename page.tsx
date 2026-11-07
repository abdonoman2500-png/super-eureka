import AuthClient from "@/components/auth/AuthClient";

export const metadata = { title: "تسجيل الدخول · NimbusVault" };

export default function LoginPage() {
  return <AuthClient mode="login" />;
}
