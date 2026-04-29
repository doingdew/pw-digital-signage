// Minimalist world map for the World Clocks zone.
// We render a simplified continent outline as inline SVG paths and place
// city cards over their lat/lon using equirectangular projection.
//
// The continent paths below are derived from a low-resolution simplified
// Natural Earth dataset (public domain). Coordinates are in the
// equirectangular projection where:
//   x = (lon + 180) * (W / 360)
//   y = (90 - lat)  * (H / 180)
// so longitude -180..180 maps to 0..W and latitude 90..-90 maps to 0..H.
//
// We expose:
//   window.WORLD_MAP_SVG   — string to drop inside <svg>
//   window.projectLatLon(lat, lon, w, h)   — returns [x, y] in pixels
//   window.CITY_LATLON     — lookup table for ~80 major cities

window.projectLatLon = function (lat, lon, w, h) {
  const x = (Number(lon) + 180) * (w / 360);
  const y = (90 - Number(lat))  * (h / 180);
  return [x, y];
};

// Minimal continent silhouettes — composed of polylines that approximate the
// shapes of the continents at low resolution. Drawn with a soft fill.
window.WORLD_MAP_SVG = `
<defs>
  <linearGradient id="map-bg-grad" x1="0" x2="0" y1="0" y2="1">
    <stop offset="0%" stop-color="#0a1228"/>
    <stop offset="100%" stop-color="#04080f"/>
  </linearGradient>
</defs>
<rect x="0" y="0" width="1000" height="500" fill="url(#map-bg-grad)"/>
<!-- Latitude lines -->
<g stroke="rgba(120,160,220,0.06)" stroke-width="0.5" fill="none">
  <line x1="0" y1="125" x2="1000" y2="125"/>
  <line x1="0" y1="187.5" x2="1000" y2="187.5"/>
  <line x1="0" y1="250" x2="1000" y2="250"/>
  <line x1="0" y1="312.5" x2="1000" y2="312.5"/>
  <line x1="0" y1="375" x2="1000" y2="375"/>
</g>
<!-- Longitude lines -->
<g stroke="rgba(120,160,220,0.06)" stroke-width="0.5" fill="none">
  <line x1="166.66" y1="0" x2="166.66" y2="500"/>
  <line x1="333.33" y1="0" x2="333.33" y2="500"/>
  <line x1="500" y1="0" x2="500" y2="500"/>
  <line x1="666.66" y1="0" x2="666.66" y2="500"/>
  <line x1="833.33" y1="0" x2="833.33" y2="500"/>
</g>
<!-- Equator -->
<line x1="0" y1="250" x2="1000" y2="250" stroke="rgba(120,160,220,0.12)" stroke-width="0.7" stroke-dasharray="4 4"/>
<!-- Continents (simplified outlines, ~equirectangular) -->
<g fill="rgba(120,160,220,0.18)" stroke="rgba(140,180,230,0.4)" stroke-width="0.6" stroke-linejoin="round">
  <!-- North America -->
  <path d="M 130 90 L 165 80 L 200 75 L 245 80 L 300 90 L 320 110 L 310 140 L 320 170 L 290 200 L 260 230 L 240 250 L 250 275 L 230 280 L 215 260 L 195 235 L 175 215 L 165 195 L 150 175 L 145 150 L 135 130 L 125 110 Z"/>
  <!-- Central + South America -->
  <path d="M 245 270 L 270 285 L 285 300 L 290 320 L 295 345 L 300 370 L 295 395 L 285 410 L 275 405 L 270 380 L 265 355 L 255 330 L 248 305 L 240 285 Z"/>
  <!-- Greenland -->
  <path d="M 350 65 L 380 55 L 405 60 L 415 80 L 405 100 L 380 110 L 360 100 L 350 80 Z"/>
  <!-- Europe -->
  <path d="M 470 100 L 500 95 L 525 92 L 545 100 L 555 115 L 540 130 L 525 140 L 505 138 L 485 130 L 470 118 Z"/>
  <!-- Africa -->
  <path d="M 495 175 L 525 165 L 555 175 L 575 195 L 590 230 L 595 270 L 585 310 L 565 340 L 540 360 L 520 350 L 510 320 L 500 285 L 490 245 L 488 210 Z"/>
  <!-- Middle East / Western Asia -->
  <path d="M 555 145 L 590 145 L 615 160 L 605 185 L 580 195 L 565 180 Z"/>
  <!-- Asia -->
  <path d="M 555 95 L 605 88 L 660 90 L 720 95 L 770 105 L 810 120 L 830 145 L 825 175 L 800 195 L 770 205 L 745 200 L 715 195 L 685 200 L 660 210 L 635 215 L 615 200 L 595 180 L 575 160 L 560 130 Z"/>
  <!-- Southeast Asia / Indonesia -->
  <path d="M 760 220 L 790 230 L 815 235 L 800 250 L 780 255 L 760 250 L 745 240 Z"/>
  <!-- Australia -->
  <path d="M 800 320 L 845 315 L 880 325 L 890 340 L 880 360 L 850 365 L 815 360 L 795 345 Z"/>
  <!-- New Zealand -->
  <path d="M 905 370 L 920 365 L 925 380 L 915 388 L 905 380 Z"/>
  <!-- UK / Ireland -->
  <path d="M 470 110 L 478 105 L 482 115 L 478 122 L 472 120 Z"/>
  <!-- Japan -->
  <path d="M 815 150 L 825 152 L 832 165 L 825 175 L 818 170 Z"/>
  <!-- Madagascar -->
  <path d="M 590 305 L 596 300 L 600 320 L 595 335 L 590 325 Z"/>
  <!-- Iceland -->
  <path d="M 450 92 L 460 88 L 465 95 L 458 100 L 451 98 Z"/>
  <!-- Philippines -->
  <path d="M 815 215 L 822 218 L 822 232 L 815 230 Z"/>
</g>
`;

// Common cities — name (lower case for lookup) → { lat, lon, label, tz }
// Used by admin's "Add city" picker so users don't have to type lat/lon.
window.CITY_LATLON = {
  // North America
  'new york':       { lat: 40.7128,  lon: -74.0060, label: 'New York',       tz: 'America/New_York' },
  'los angeles':    { lat: 34.0522,  lon: -118.2437, label: 'Los Angeles',   tz: 'America/Los_Angeles' },
  'chicago':        { lat: 41.8781,  lon: -87.6298, label: 'Chicago',        tz: 'America/Chicago' },
  'denver':         { lat: 39.7392,  lon: -104.9903, label: 'Denver',        tz: 'America/Denver' },
  'phoenix':        { lat: 33.4484,  lon: -112.0740, label: 'Phoenix',       tz: 'America/Phoenix' },
  'seattle':        { lat: 47.6062,  lon: -122.3321, label: 'Seattle',       tz: 'America/Los_Angeles' },
  'san francisco':  { lat: 37.7749,  lon: -122.4194, label: 'San Francisco', tz: 'America/Los_Angeles' },
  'boston':         { lat: 42.3601,  lon: -71.0589, label: 'Boston',         tz: 'America/New_York' },
  'miami':          { lat: 25.7617,  lon: -80.1918, label: 'Miami',          tz: 'America/New_York' },
  'dallas':         { lat: 32.7767,  lon: -96.7970, label: 'Dallas',         tz: 'America/Chicago' },
  'atlanta':        { lat: 33.7490,  lon: -84.3880, label: 'Atlanta',        tz: 'America/New_York' },
  'washington':     { lat: 38.9072,  lon: -77.0369, label: 'Washington DC',  tz: 'America/New_York' },
  'toronto':        { lat: 43.6532,  lon: -79.3832, label: 'Toronto',        tz: 'America/Toronto' },
  'montreal':       { lat: 45.5017,  lon: -73.5673, label: 'Montreal',       tz: 'America/Toronto' },
  'vancouver':      { lat: 49.2827,  lon: -123.1207, label: 'Vancouver',     tz: 'America/Vancouver' },
  'mexico city':    { lat: 19.4326,  lon: -99.1332, label: 'Mexico City',    tz: 'America/Mexico_City' },
  // South America
  'são paulo':      { lat: -23.5505, lon: -46.6333, label: 'São Paulo',      tz: 'America/Sao_Paulo' },
  'sao paulo':      { lat: -23.5505, lon: -46.6333, label: 'São Paulo',      tz: 'America/Sao_Paulo' },
  'rio de janeiro': { lat: -22.9068, lon: -43.1729, label: 'Rio de Janeiro', tz: 'America/Sao_Paulo' },
  'buenos aires':   { lat: -34.6037, lon: -58.3816, label: 'Buenos Aires',   tz: 'America/Argentina/Buenos_Aires' },
  'lima':           { lat: -12.0464, lon: -77.0428, label: 'Lima',           tz: 'America/Lima' },
  'bogota':         { lat: 4.7110,   lon: -74.0721, label: 'Bogotá',         tz: 'America/Bogota' },
  'santiago':       { lat: -33.4489, lon: -70.6693, label: 'Santiago',       tz: 'America/Santiago' },
  // Europe
  'london':         { lat: 51.5074,  lon: -0.1278, label: 'London',          tz: 'Europe/London' },
  'paris':          { lat: 48.8566,  lon: 2.3522, label: 'Paris',            tz: 'Europe/Paris' },
  'berlin':         { lat: 52.5200,  lon: 13.4050, label: 'Berlin',          tz: 'Europe/Berlin' },
  'madrid':         { lat: 40.4168,  lon: -3.7038, label: 'Madrid',          tz: 'Europe/Madrid' },
  'rome':           { lat: 41.9028,  lon: 12.4964, label: 'Rome',            tz: 'Europe/Rome' },
  'amsterdam':      { lat: 52.3676,  lon: 4.9041, label: 'Amsterdam',        tz: 'Europe/Amsterdam' },
  'stockholm':      { lat: 59.3293,  lon: 18.0686, label: 'Stockholm',       tz: 'Europe/Stockholm' },
  'oslo':           { lat: 59.9139,  lon: 10.7522, label: 'Oslo',            tz: 'Europe/Oslo' },
  'helsinki':       { lat: 60.1699,  lon: 24.9384, label: 'Helsinki',        tz: 'Europe/Helsinki' },
  'copenhagen':     { lat: 55.6761,  lon: 12.5683, label: 'Copenhagen',      tz: 'Europe/Copenhagen' },
  'dublin':         { lat: 53.3498,  lon: -6.2603, label: 'Dublin',          tz: 'Europe/Dublin' },
  'lisbon':         { lat: 38.7223,  lon: -9.1393, label: 'Lisbon',          tz: 'Europe/Lisbon' },
  'vienna':         { lat: 48.2082,  lon: 16.3738, label: 'Vienna',          tz: 'Europe/Vienna' },
  'zurich':         { lat: 47.3769,  lon: 8.5417, label: 'Zurich',           tz: 'Europe/Zurich' },
  'warsaw':         { lat: 52.2297,  lon: 21.0122, label: 'Warsaw',          tz: 'Europe/Warsaw' },
  'prague':         { lat: 50.0755,  lon: 14.4378, label: 'Prague',          tz: 'Europe/Prague' },
  'athens':         { lat: 37.9838,  lon: 23.7275, label: 'Athens',          tz: 'Europe/Athens' },
  'moscow':         { lat: 55.7558,  lon: 37.6173, label: 'Moscow',          tz: 'Europe/Moscow' },
  'istanbul':       { lat: 41.0082,  lon: 28.9784, label: 'Istanbul',        tz: 'Europe/Istanbul' },
  // Africa
  'cairo':          { lat: 30.0444,  lon: 31.2357, label: 'Cairo',           tz: 'Africa/Cairo' },
  'lagos':          { lat: 6.5244,   lon: 3.3792, label: 'Lagos',            tz: 'Africa/Lagos' },
  'nairobi':        { lat: -1.2921,  lon: 36.8219, label: 'Nairobi',         tz: 'Africa/Nairobi' },
  'johannesburg':   { lat: -26.2041, lon: 28.0473, label: 'Johannesburg',    tz: 'Africa/Johannesburg' },
  'cape town':      { lat: -33.9249, lon: 18.4241, label: 'Cape Town',       tz: 'Africa/Johannesburg' },
  'casablanca':     { lat: 33.5731,  lon: -7.5898, label: 'Casablanca',      tz: 'Africa/Casablanca' },
  // Middle East
  'dubai':          { lat: 25.2048,  lon: 55.2708, label: 'Dubai',           tz: 'Asia/Dubai' },
  'tel aviv':       { lat: 32.0853,  lon: 34.7818, label: 'Tel Aviv',        tz: 'Asia/Jerusalem' },
  'riyadh':         { lat: 24.7136,  lon: 46.6753, label: 'Riyadh',          tz: 'Asia/Riyadh' },
  // Asia
  'tokyo':          { lat: 35.6762,  lon: 139.6503, label: 'Tokyo',          tz: 'Asia/Tokyo' },
  'seoul':          { lat: 37.5665,  lon: 126.9780, label: 'Seoul',          tz: 'Asia/Seoul' },
  'beijing':        { lat: 39.9042,  lon: 116.4074, label: 'Beijing',        tz: 'Asia/Shanghai' },
  'shanghai':       { lat: 31.2304,  lon: 121.4737, label: 'Shanghai',       tz: 'Asia/Shanghai' },
  'hong kong':      { lat: 22.3193,  lon: 114.1694, label: 'Hong Kong',      tz: 'Asia/Hong_Kong' },
  'taipei':         { lat: 25.0330,  lon: 121.5654, label: 'Taipei',         tz: 'Asia/Taipei' },
  'singapore':      { lat: 1.3521,   lon: 103.8198, label: 'Singapore',      tz: 'Asia/Singapore' },
  'bangkok':        { lat: 13.7563,  lon: 100.5018, label: 'Bangkok',        tz: 'Asia/Bangkok' },
  'kuala lumpur':   { lat: 3.1390,   lon: 101.6869, label: 'Kuala Lumpur',   tz: 'Asia/Kuala_Lumpur' },
  'jakarta':        { lat: -6.2088,  lon: 106.8456, label: 'Jakarta',        tz: 'Asia/Jakarta' },
  'manila':         { lat: 14.5995,  lon: 120.9842, label: 'Manila',         tz: 'Asia/Manila' },
  'mumbai':         { lat: 19.0760,  lon: 72.8777, label: 'Mumbai',          tz: 'Asia/Kolkata' },
  'delhi':          { lat: 28.6139,  lon: 77.2090, label: 'Delhi',           tz: 'Asia/Kolkata' },
  'kolkata':        { lat: 22.5726,  lon: 88.3639, label: 'Kolkata',         tz: 'Asia/Kolkata' },
  'bangalore':      { lat: 12.9716,  lon: 77.5946, label: 'Bangalore',       tz: 'Asia/Kolkata' },
  'karachi':        { lat: 24.8607,  lon: 67.0011, label: 'Karachi',         tz: 'Asia/Karachi' },
  'tehran':         { lat: 35.6892,  lon: 51.3890, label: 'Tehran',          tz: 'Asia/Tehran' },
  // Oceania
  'sydney':         { lat: -33.8688, lon: 151.2093, label: 'Sydney',         tz: 'Australia/Sydney' },
  'melbourne':      { lat: -37.8136, lon: 144.9631, label: 'Melbourne',      tz: 'Australia/Melbourne' },
  'brisbane':       { lat: -27.4698, lon: 153.0251, label: 'Brisbane',       tz: 'Australia/Brisbane' },
  'perth':          { lat: -31.9505, lon: 115.8605, label: 'Perth',          tz: 'Australia/Perth' },
  'auckland':       { lat: -36.8485, lon: 174.7633, label: 'Auckland',       tz: 'Pacific/Auckland' },
  'honolulu':       { lat: 21.3069,  lon: -157.8583, label: 'Honolulu',      tz: 'Pacific/Honolulu' },
};
