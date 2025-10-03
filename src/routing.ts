import type { View } from './types.js';

/**
 * Hash based router.
 */
export class Router {
  private currentView: View = 'home';

  private readonly listeners: Array<(view: View) => void> = [];

  public constructor() {
    window.addEventListener('hashchange', () => this.handleHashChange());
  }

  /**
   * Registers change listener.
   * @param listener - Callback invoked on route change.
   */
  public onChange(listener: (view: View) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Initializes router and emits current view.
   */
  public init(): void {
    this.currentView = this.getViewFromHash();
    this.emit();
  }

  /**
   * Navigates to desired view.
   * @param view - Target view id.
   */
  public navigate(view: View): void {
    window.location.hash = view;
  }

  /**
   * Returns active view id.
   * @returns Current view.
   */
  public getCurrentView(): View {
    return this.currentView;
  }

  /**
   * Handles browser hash change events.
   */
  private handleHashChange(): void {
    const view = this.getViewFromHash();
    if (view === this.currentView) {
      return;
    }
    this.currentView = view;
    this.emit();
  }

  /**
   * Notifies registered listeners about view changes.
   */
  private emit(): void {
    this.listeners.forEach((listener) => listener(this.currentView));
  }

  /**
   * Converts current hash to known view identifier.
   * @returns View id derived from hash.
   */
  private getViewFromHash(): View {
    const hash = window.location.hash.replace('#', '') as View;
    if (hash === 'catalog' || hash === 'cart') {
      return hash;
    }
    return 'home';
  }
}
