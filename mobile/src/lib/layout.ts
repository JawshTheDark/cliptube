import { useWindowDimensions } from 'react-native';
import { useDensity } from './density';

/** Forms and lists of settings stay this wide on a tablet, centred, instead of stretching across the screen. */
export const READABLE_WIDTH = 720;

/**
 * The app turns with the device. `wide` is a landscape screen with room for two panes (a tablet, or a phone on its
 * side): the watch, live and party screens put the video on the left and the rest beside it. `columns` is how many
 * video cards fit across a feed, `shortColumns` how many Shorts; a denser setting makes both smaller, so more fit.
 */
export function useLayout() {
  const { width, height } = useWindowDimensions();
  const { minCard, scale } = useDensity();
  const landscape = width > height;
  const wide = landscape && width >= 700;
  const columns = Math.max(1, Math.min(6, Math.floor((width - 8) / minCard)));
  const shortColumns = Math.max(2, Math.min(9, Math.floor((width - 24) / (170 * scale))));
  // The left pane of a wide screen: about two thirds, leaving the right pane at least 300 wide.
  const leftPane = wide ? Math.min(Math.round(width * 0.64), width - 300) : width;
  return { width, height, landscape, wide, columns, shortColumns, leftPane, scale };
}

/** contentContainerStyle for a form or settings list: full width on a phone, a centred column on a tablet. */
export const readable = { width: '100%', maxWidth: READABLE_WIDTH, alignSelf: 'center' } as const;
