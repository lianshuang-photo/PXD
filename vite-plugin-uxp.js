// Vite plugin to make output compatible with UXP
export function uxpPlugin() {
  return {
    name: 'vite-plugin-uxp',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        // Only transform in production build
        if (!bundle) return html;
        
        // Remove type="module" and crossorigin attributes for UXP
        return html
          .replace(/type="module"\s*/g, '')
          .replace(/crossorigin\s*/g, '')
          .replace(/<script\s+src="\.\/assets\/([^"]+)"><\/script>/, 
            '<script src="./uxp-polyfill.js"></script>\n    <script src="./assets/$1"></script>');
      }
    }
  };
}
