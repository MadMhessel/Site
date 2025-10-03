import { Router } from '../src/routing.js';
import type { View } from '../src/types.js';

describe('Router', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('emits current view on init', () => {
    const router = new Router();
    const views: string[] = [];
    router.onChange((view: View) => views.push(view));
    router.init();
    expect(views).toContain('home');
  });

  it('navigates to catalog view via hashchange', () => {
    const router = new Router();
    let current = '';
    router.onChange((view: View) => {
      current = view;
    });
    router.init();
    window.location.hash = '#catalog';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(current).toBe('catalog');
  });
});
