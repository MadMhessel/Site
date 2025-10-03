/**
 * Utility functions shared across the application.
 * @module utils
 */

/** Allowed HTML tags for sanitized editable content. */
const ALLOWED_TAGS = new Set(['B', 'I', 'STRONG', 'EM', 'A', 'UL', 'OL', 'LI', 'BR', 'P', 'SPAN']);

/** Allowed attributes for sanitized editable content. */
const ALLOWED_ATTRIBUTES = new Set(['href', 'title', 'target', 'rel']);

/**
 * Creates a slug from arbitrary text.
 * @param text - Source text.
 * @returns Slugified string.
 */
export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[^\w\s-]+/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Formats value as Russian ruble currency.
 * @param value - Numeric value.
 * @returns Formatted currency string.
 */
export const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(value);

/**
 * Sanitizes HTML using a lightweight allowlist.
 * @param input - Raw HTML string.
 * @returns Sanitized string safe for insertion.
 */
export const sanitizeHtml = (input: string): string => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(input, 'text/html');

  /**
   * Recursively walks through nodes and strips dangerous content.
   * @param node - Node to sanitize.
   */
  const walk = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (!ALLOWED_TAGS.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        return;
      }
      Array.from(element.attributes).forEach((attribute) => {
        if (!ALLOWED_ATTRIBUTES.has(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
        if (attribute.name === 'href' && element.getAttribute('href')) {
          const value = element.getAttribute('href') ?? '';
          if (value.startsWith('javascript:')) {
            element.removeAttribute('href');
          } else {
            element.setAttribute('rel', 'noopener noreferrer');
            element.setAttribute('target', '_blank');
          }
        }
      });
    }
    Array.from(node.childNodes).forEach(walk);
  };

  Array.from(doc.body.childNodes).forEach(walk);
  return doc.body.innerHTML;
};

/**
 * Creates a debounced version of the supplied callback.
 * @param callback - Function to debounce.
 * @param delay - Delay in milliseconds.
 * @returns Debounced function.
 */
export const debounce = <T extends (...args: unknown[]) => void>(callback: T, delay = 250): T => {
  let timer: number | undefined;
  return ((...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  }) as T;
};

/**
 * Creates a throttled version of the supplied callback.
 * @param callback - Function to throttle.
 * @param interval - Interval in milliseconds.
 * @returns Throttled function.
 */
export const throttle = <T extends (...args: unknown[]) => void>(
  callback: T,
  interval = 200
): T => {
  let lastInvoke = 0;
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastInvoke >= interval) {
      lastInvoke = now;
      callback(...args);
    }
  }) as T;
};

/**
 * Reads a file as text.
 * @param file - Source file.
 * @returns File contents.
 */
export const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, 'utf-8');
  });

/**
 * Creates an accessible toast element.
 * @param message - Text to display.
 * @param type - Toast type.
 * @returns HTMLElement instance.
 */
export const createToastElement = (message: string, type: 'info' | 'success' | 'error'): HTMLElement => {
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.textContent = message;
  return toast;
};
