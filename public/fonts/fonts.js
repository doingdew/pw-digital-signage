// Shared font catalog used by both admin and signage. Each entry is a
// Google Fonts family name + the Google Fonts CSS URL that loads it.
//
// To go fully offline, drop self-hosted woff2 files under /public/fonts/
// and replace `cssUrl` with a local @font-face stylesheet path.
//
// Loaded as a plain <script src="/fonts/fonts.js"> so it's available as
// window.AVAILABLE_FONTS on both pages.

window.AVAILABLE_FONTS = [
  { family: 'Inter',          weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;700&display=swap' },
  { family: 'Roboto',         weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap' },
  { family: 'Open Sans',      weights: '300;400;600;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap' },
  { family: 'Source Sans 3',  weights: '300;400;600;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;600;700&display=swap' },
  { family: 'Manrope',        weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;700&display=swap' },
  { family: 'IBM Plex Sans',  weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;700&display=swap' },
  { family: 'JetBrains Mono', weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap' },
  { family: 'Bebas Neue',     weights: '400',              cssUrl: 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap' },
  { family: 'Oswald',         weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;700&display=swap' },
  { family: 'Montserrat',     weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;700&display=swap' },
  { family: 'Lato',           weights: '300;400;700',      cssUrl: 'https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap' },
  { family: 'Poppins',        weights: '300;400;500;700',  cssUrl: 'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;700&display=swap' },
];

// Inject a Google Fonts <link> for the chosen family, only once per family.
window.loadFontFamily = function loadFontFamily(family) {
  if (!family) return;
  const meta = window.AVAILABLE_FONTS.find(f => f.family === family);
  if (!meta) return;
  const id = 'font-' + family.replace(/\s+/g, '-');
  if (document.getElementById(id)) return;
  // Preconnect for speed
  if (!document.getElementById('gf-preconnect')) {
    const a = document.createElement('link');
    a.id = 'gf-preconnect';
    a.rel = 'preconnect';
    a.href = 'https://fonts.gstatic.com';
    a.crossOrigin = 'anonymous';
    document.head.appendChild(a);
  }
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = meta.cssUrl;
  document.head.appendChild(link);
};
