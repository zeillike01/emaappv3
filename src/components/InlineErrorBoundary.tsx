/**
 * InlineErrorBoundary — contains a crash to the view it wraps.
 *
 * The app has a root error boundary in main.tsx, which means ANY uncaught
 * error in a heavy view (e.g. the chart) blanks the WHOLE app with a
 * "Preview runtime error" screen. Wrapping individual views with this keeps
 * the rest of the dashboard alive and shows the actual error message inline
 * instead (so a broken chart can never take down Trades / Advanced Data).
 */
import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Short name used in the console log, e.g. "Chart". */
  label?: string;
}

interface State {
  error: Error | null;
}

export class InlineErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Keep the real error in the console for debugging — the fallback only
    // shows a summary.
    console.error(`[${this.props.label ?? "view"}] crashed:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-rose-200/60 bg-rose-50/40 backdrop-blur-sm p-6 text-center">
          <AlertTriangle className="size-6 text-rose-400 mx-auto mb-2" />
          <p className="text-xs font-semibold text-rose-600 mb-1">
            {this.props.label ?? "This view"} hit an error
          </p>
          <p className="text-[11px] text-slate-500 max-w-md mx-auto mb-3 break-words">
            {this.state.error.message}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="text-[11px]"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
