import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkError, reloadForNewBuild } from "../lib/lazyChunk";

interface Props {
  children: ReactNode;
  /** What to show instead of the crashed children; the default is a full-page reload card. */
  fallback?(retry: () => void): ReactNode;
}

/** Catches a render error and offers a way back instead of a blank page. */
export class ErrorBoundary extends Component<Props, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("App crashed", error, info.componentStack);
    if (isChunkError(error)) reloadForNewBuild();
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(() => this.setState({ error: null }));
    return (
      <main className="portal center-page">
        <div className="card link-card">
          <h1>Something went wrong</h1>
          <p className="muted">
            {isChunkError(this.state.error)
              ? "The app was just updated. Reload to get the new version."
              : "Reload the page to pick up where you left off."}
          </p>
          <div className="row center">
            <button className="primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
