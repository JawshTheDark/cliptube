/** OurTube's palette, the same as the website's (web/src/styles.css): dark, slightly purple, never bright white. */
export const colors = {
  bg: '#0e0d16',
  bg2: '#12101c',
  surface: '#17151f',
  surface2: '#24212f',
  surface3: '#34314a',
  border: 'rgba(196,176,255,0.16)',
  hairline: 'rgba(196,176,255,0.09)',
  text: '#f2f0fa',
  text2: '#a19db8',
  accent: '#7c4dff',
  accentHover: '#8f66ff',
  accentText: '#c4b0ff', // links and purple text
  accentSoft: 'rgba(124,77,255,0.22)',
  link: '#c4b0ff',
  live: '#e5283c', // red only ever means live
  liveSoft: 'rgba(229,40,60,0.16)',
  liveBorder: 'rgba(229,40,60,0.45)',
  overlay: 'rgba(14,13,22,0.82)', // badges and tags on thumbnails
  ok: '#6bff9a',
  warn: '#ffd166',
  err: '#ff6b6b',
} as const;

/**
 * Bundled with the app (app.json, expo-font): Plus Jakarta Sans for text, Bricolage Grotesque for headings and the
 * wordmark. Each family has its weights, so fontWeight picks the face.
 */
export const fonts = {
  text: 'PlusJakartaSans',
  display: 'BricolageGrotesque',
} as const;

export const radius = 14;
export const thumbRadius = 16;
