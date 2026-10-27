import { initNativeHostListener } from './native-host';

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  initNativeHostListener();
});
