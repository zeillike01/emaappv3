import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

/**
 * Glass surface primitives — one coherent light-glass look for the whole app.
 *
 * Panels sit on the luminous page backdrop as frosted layers: translucent
 * white fill, 1px light edge, an inner top highlight (the "edge light"), and
 * a soft cool drop shadow. Colors are kept inside the palette the dark-mode
 * remap layer understands (bg-white/30-70, border-white/40-50, slate text,
 * emerald/rose/sky/violet accents) so the same classes read correctly in
 * both themes.
 */
interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}

export function GlassPanel({ children, className, hover = false }: GlassPanelProps) {
  return (
    <div
      className={cn(
        "rounded-2xl sm:rounded-3xl border border-white/65 bg-white/45 backdrop-blur-2xl",
        "shadow-[inset_0_1px_1.5px_rgba(255,255,255,0.9),0_14px_38px_-12px_rgba(15,23,42,0.09)]",
        "transition-all duration-300",
        hover &&
          "hover:border-white/80 hover:bg-white/55 hover:shadow-[inset_0_1px_2px_rgba(255,255,255,1),0_20px_44px_-14px_rgba(15,23,42,0.14)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface GlassCardProps {
  /** Optional accent icon tile shown left of the title row. */
  icon?: ReactNode;
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}

export function GlassCard({ icon, title, subtitle, children, className, action }: GlassCardProps) {
  return (
    <GlassPanel className={cn("p-4 sm:p-6", className)}>
      {(title || action) && (
        /* MOBILE (2026-10-28): the action slot used to be `shrink-0` beside the
           title, so a wide action (two buttons, an input + button, a chip row)
           squeezed the title/subtitle to a sliver on a phone — and the action
           itself was clipped rather than wrapped. Below `sm` the action now
           drops under the header at full width; above it nothing changes. */
        <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {icon && (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/80 bg-gradient-to-br from-sky-400/15 via-white/40 to-indigo-500/15 text-sky-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.95),0_4px_12px_-2px_rgba(14,165,233,0.12)]">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && (
                <h3 className="truncate text-[15px] font-bold tracking-tight text-slate-800">
                  {title}
                </h3>
              )}
              {subtitle && (
                <p className="mt-0.5 text-xs text-slate-400 font-normal leading-relaxed">{subtitle}</p>
              )}
            </div>
          </div>
          {action && (
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">{action}</div>
          )}
        </div>
      )}
      {children}
    </GlassPanel>
  );
}
