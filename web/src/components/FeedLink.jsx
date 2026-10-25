import { useEffect } from 'react';
import { Icon } from './Icons.jsx';

/** Adds <link rel="alternate"> for an Atom feed while a page is open, so feed readers find it. */
export function useFeedLink(href, title) {
  useEffect(() => {
    if (!href) return;
    const el = document.createElement('link');
    el.rel = 'alternate';
    el.type = 'application/atom+xml';
    el.href = href;
    el.title = title || 'Feed';
    document.head.appendChild(el);
    return () => el.remove();
  }, [href, title]);
}

/** A visible "Feed" link (Atom, with RSS as an alternative). */
export function FeedButton({ href, title }) {
  useFeedLink(href, title);
  if (!href) return null;
  return (
    <a className="btn btn-icon" href={href} title={`Subscribe in a feed reader (Atom). RSS: ${href.replace(/\.atom$/, '.rss')}`} target="_blank" rel="noopener noreferrer">
      <Icon name="rss" />
    </a>
  );
}
