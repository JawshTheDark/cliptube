// Shapes returned by the ClipTube API (see server/routes/videos.js, server/network.js and server/auth.js).

export type User = {
  id: string;
  username: string;
  display_name: string;
  bio?: string | null;
  avatar_url: string | null;
  banner_url?: string | null;
  is_admin: boolean;
  is_moderator: boolean;
  role: 'user' | 'moderator' | 'admin';
  status: string;
  created_at: number;
};

export type Site = {
  site_name: string;
  registration_mode: 'open' | 'approval' | 'invite' | 'closed';
  allow_registration: boolean;
  max_upload_mb: number;
  needs_setup: boolean;
  has_terms: boolean;
  federation: boolean;
  network_peers?: { id: number; name: string; url: string }[];
};

export type Uploader = {
  id: string | null;
  username: string;
  display_name: string;
  avatar_url: string | null;
  url?: string | null;
  subscriber_count?: number;
  support_links?: { label: string; url: string }[];
};

export type GameRef = { id: string; name: string; short_name?: string | null };

export type Game = GameRef & {
  aliases?: string[];
  artwork_url: string | null;
  logo_url?: string | null;
  hero_url?: string | null;
  video_count?: number;
  network_count?: number;
  remote_only?: boolean;
};

export type RemoteInfo = {
  peer_id: number;
  remote_id: string;
  peer_name: string | null;
  peer_url: string;
  watch_url: string | null;
};

export type Visibility = 'public' | 'unlisted' | 'private';

export type Video = {
  id: string;
  title: string;
  description: string;
  visibility: Visibility;
  draft?: boolean;
  draft_visibility?: Visibility | null;
  status: string; // queued | processing | ready | failed
  progress?: number;
  error?: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  views: number;
  created_at: number;
  published_at?: number | null;
  thumbnail_url: string | null;
  video_url: string | null;
  hls_url?: string | null;
  game: GameRef | null;
  community?: { title: string | null; thumbnail_url: string | null } | null;
  uploader: Uploader;
  remote?: RemoteInfo;
  origin_type?: string;
  tags?: string[];
  likes?: number;
  dislikes?: number | null;
  my_like?: number;
  comment_count?: number;
  subscribed?: boolean;
  can_edit?: boolean;
  resume_at?: number;
  moderation_status?: string | null;
  moderation_reason?: string | null;
  allow_clips?: boolean;
  // For-you feed extras
  reason?: string;
  watched?: boolean;
  feed_keys?: { channel: string; video: string; game: string | null };
  // History extras
  position?: number;
  watched_at?: number;
};

export type Paged<T> = { items: T[]; hasMore: boolean };

export type Comment = {
  id: string;
  parent_id: string | null;
  body: string;
  created_at: number;
  status: string; // visible | held | pending | rejected
  hearted: boolean;
  pinned: boolean;
  author: { id?: string; username: string; display_name: string; avatar_url: string | null; profile_url?: string | null; remote: boolean };
  is_uploader: boolean;
  held_reason?: string | null;
  status_reason?: string | null;
  can_delete?: boolean;
  can_moderate?: boolean;
  can_pin?: boolean;
};

export type Channel = User & {
  subscriber_count: number;
  video_count: number;
  total_views: number;
  subscribed: boolean;
  is_self: boolean;
  support_links: { label: string; url: string }[];
  moved?: { url: string; handle: string | null; at: number };
};

export type SubscriptionChannel = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  remote?: { instance_id: number; peer_name: string; profile_url: string };
};

export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  image_url: string | null;
  read: boolean;
  created_at: number;
};

/** The network watch endpoint wraps the video with what this viewer can do. */
export type RemoteWatch = {
  video: Video & { remote: RemoteInfo };
  related: Video[];
  my_like: number;
  subscribed: boolean;
  interactions: { likes: boolean; comments: boolean; subscriptions: boolean };
};
