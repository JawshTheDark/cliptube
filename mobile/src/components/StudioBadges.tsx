import { Badge } from './Form';
import type { Video } from '@/lib/types';

/** Where a video is: ready, processing, rendering an edit, failed, or hidden by moderators (the website's Studio badge). */
export function StatusBadge({ video: v }: { video: Video }) {
  if (v.moderation_status) return <Badge text={`${v.moderation_status === 'removed' ? 'Removed' : 'Hidden'} by moderators`} tone="err" />;
  if (v.status === 'ready' && (v.render_status === 'queued' || v.render_status === 'rendering')) return <Badge text={`Rendering edit ${v.render_progress || 0}%`} tone="warn" />;
  if (v.status === 'ready' && v.render_status === 'failed') return <Badge text="Edit failed" tone="err" />;
  switch (v.status) {
    case 'ready':
      return <Badge text="Ready" tone="ok" />;
    case 'failed':
      return <Badge text="Failed" tone="err" />;
    case 'processing':
      return <Badge text={`Processing ${Math.round(v.progress || 0)}%`} tone="warn" />;
    default:
      return <Badge text="Queued" tone="warn" />;
  }
}

/** Public, unlisted or private; a draft says so instead. */
export function VisibilityBadge({ video: v }: { video: Video }) {
  if (v.draft) return <Badge text="Draft" tone="warn" />;
  return <Badge text={v.visibility[0].toUpperCase() + v.visibility.slice(1)} />;
}

/** Still processing or rendering, so the lists check again. */
export const isBusy = (v: Video) => v.status === 'queued' || v.status === 'processing' || v.render_status === 'queued' || v.render_status === 'rendering';
