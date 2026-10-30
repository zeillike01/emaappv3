import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
}

/** Sun/moon toggle — switches the `dark` class on <html> (see index.css .dark). */
export function ThemeToggle({ className }: Props) {
  const { isDark, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full border border-white/40 bg-white/40 text-slate-600 backdrop-blur-sm transition-all",
        "hover:bg-white/70 hover:text-slate-800 hover:border-white/60",
        className,
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
