import { Component, type ReactNode } from "react";

/**
 * The last line of defence: an error thrown while a view renders would otherwise leave a blank page. This shows
 * a plain message and a way out instead.
 */
export class Boundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false };

  static getDerivedStateFromError(): { broken: boolean } {
    return { broken: true };
  }

  override render(): ReactNode {
    if (!this.state.broken) return this.props.children;
    return (
      <main className="page wrap" role="alert">
        <h1>Something broke</h1>
        <p className="dim">This page hit an error it could not get past. Reload to try again.</p>
        <p className="row">
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
          <a href="/">Go to the start page</a>
        </p>
      </main>
    );
  }
}
