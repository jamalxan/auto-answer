// Templates remount on every navigation, so each dashboard page fades in.
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade-in">{children}</div>;
}
