// UXP Polyfills for missing Web APIs
(function() {
  'use strict';

  // Polyfill for MutationObserver (required by React 18)
  if (typeof MutationObserver === 'undefined') {
    window.MutationObserver = class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.observing = false;
      }
      
      observe(target, options) {
        this.target = target;
        this.options = options;
        this.observing = true;
        // Fallback: use setTimeout to periodically check for changes
        this.checkInterval = setInterval(() => {
          if (this.observing && this.callback) {
            this.callback([], this);
          }
        }, 100);
      }
      
      disconnect() {
        this.observing = false;
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
        }
      }
      
      takeRecords() {
        return [];
      }
    };
  }

  // Polyfill for queueMicrotask (might be needed)
  if (typeof queueMicrotask === 'undefined') {
    window.queueMicrotask = function(callback) {
      Promise.resolve().then(callback).catch(e => {
        setTimeout(() => { throw e; }, 0);
      });
    };
  }

  console.log('UXP polyfills loaded');
})();
