import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LogOut, Radio, TrendingUp } from "lucide-react";

/** Shared header for the authenticated workspace pages (paper + live). */
export function WorkspaceHeader({
  accent,
  title,
  subtitle,
  actions,
}: {
  accent: "paper" | "live";
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const isPaper = accent === "paper";
  const iconBox = isPaper
    ? "border border-sky-400/40 bg-gradient-to-br from-sky-400/20 via-sky-500/10 to-indigo-500/20 text-sky-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_8px_20px_-6px_rgba(14,165,233,0.25)]"
    : "border border-rose-400/40 bg-gradient-to-br from-rose-400/20 via-rose-500/10 to-orange-500/20 text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_8px_20px_-6px_rgba(244,63,94,0.25)]";

  const nav = [
    { to: "/dashboard", label: "Paper", icon: TrendingUp },
    { to: "/live", label: "Live", icon: Radio },
  ];

  return (
    <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3.5">
        <div
          className={cn(
            "flex size-11 items-center justify-center rounded-2xl backdrop-blur-xl transition-all",
            iconBox,
          )}
        >
          {isPaper ? (
            <TrendingUp className="size-5.5 stroke-[2.2]" />
          ) : (
            <Radio className="size-5.5 stroke-[2.2]" />
          )}
        </div>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{title}</h1>
          <p className="text-xs font-medium text-slate-400 tracking-normal">{subtitle}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        {/* Workspace switcher with fluid glass pill */}
        <nav className="flex items-center rounded-2xl border border-white/70 bg-white/40 p-1 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_20px_-6px_rgba(15,23,42,0.06)] backdrop-blur-xl">
          {nav.map(({ to, label, icon: Icon }) => {
            const active = pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  "relative flex items-center gap-2 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all duration-200",
                  active
                    ? to === "/live"
                      ? "border border-white/80 bg-white/85 text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,1),0_2px_8px_-2px_rgba(244,63,94,0.15)]"
                      : "border border-white/80 bg-white/85 text-sky-700 shadow-[inset_0_1px_1px_rgba(255,255,255,1),0_2px_8px_-2px_rgba(14,165,233,0.15)]"
                    : "border border-transparent text-slate-500 hover:text-slate-800 hover:bg-white/30",
                )}
              >
                <Icon className="size-3.5" />
                {label}
                {to === "/live" && !active && (
                  <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-rose-600">
                    real
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {actions}

        <span className="hidden md:inline-block max-w-32 truncate text-xs font-medium text-slate-400">
          {user?.name || "Account"}
        </span>
        <ThemeToggle />
        <Button
          variant="outline"
          size="sm"
          onClick={handleSignOut}
          className="rounded-xl border border-white/60 bg-white/40 text-xs font-semibold text-slate-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-xl hover:bg-white/65 hover:text-slate-900 transition-all"
        >
          <LogOut className="size-3.5 mr-1 text-slate-400" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
