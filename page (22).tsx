import AuthClient from "@/components/auth/AuthClient";

export const metadata = { title: "إنشاء خزنة · NimbusVault" };

export default function SignupPage() {
  return <AuthClient mode="signup" />;
}
