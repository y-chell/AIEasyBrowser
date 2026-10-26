import { initNativeHostListener } from './native-host';
import { initBrowserToolSessionListeners } from './tools/browser-session-context';

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  initNativeHostListener();
  initBrowserToolSessionListeners();
});
