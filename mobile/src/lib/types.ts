// Shapes returned by the OurTube API (see server/routes/videos.js, server/network.js and server/auth.js).

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
  // software (1.19+): 'ourtube', or the NodeInfo name of a fediverse server it follows ('peertube'...); null until read.
  network_peers?: { id: number; name: string; url: string; software?: string | null }[];
  ap_host?: string | null; // the address other servers know this one by
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
  linked_uploader?: boolean; // the uploader, writing from a linked account elsewhere
  held_reason?: string | null;
  status_reason?: string | null;
  can_delete?: boolean;
  can_moderate?: boolean;
  can_pin?: boolean;
};

/** One of a channel's verified linked accounts elsewhere (OurTube 1.6). */
export type LinkedAccount = {
  handle: string;
  url: string;
  name: string | null;
  avatar_url: string | null;
  host: string;
  channel: boolean; // has videos to follow (not a plain Mastodon account)
  following: boolean; // the viewer follows it already
};

export type Channel = User & {
  subscriber_count: number;
  video_count: number;
  total_views: number;
  subscribed: boolean;
  is_self: boolean;
  support_links: { label: string; url: string }[];
  moved?: { url: string; handle: string | null; at: number };
  linked_accounts?: LinkedAccount[];
};

/** Your own linked accounts, from /api/me/links. */
export type OwnLink = {
  id: number;
  handle: string;
  url: string;
  name: string | null;
  avatar_url: string | null;
  channel: boolean;
  verified: boolean;
  verified_at: number | null;
  checked_at: number | null;
  error: string | null;
};

export type LinksState = {
  enabled: boolean;
  handle: string;
  max: number;
  links: OwnLink[];
  suggestions: { actor: string; handle: string; name: string | null; url: string }[];
  added?: OwnLink;
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

// ---- playlists (OurTube 1.7) ----

export type PlaylistItem = {
  id: number;
  ref: string; // 'v:<id>' here, 'n:<instance>:<remote id>' from the network
  url: string; // the website path: /watch/<id> or /n/<peer>/<remote>
  available: boolean;
  title: string;
  thumbnail_url: string | null;
  video: Video | null;
  added_at: number;
};

export type PlaylistSummary = {
  id: string;
  title: string;
  description: string;
  visibility: Visibility;
  kind: 'user' | 'watch_later';
  item_count: number;
  thumbnail_url: string | null;
  first_url: string | null;
  owner: { username: string; display_name: string; avatar_url: string | null } | null;
  is_owner: boolean;
  created_at: number;
  updated_at: number;
  contains?: number | null; // with ?has=: the item holding that video, or null
};

export type Playlist = PlaylistSummary & { items: PlaylistItem[] };

// ---- watch parties (OurTube 1.8) ----

export type PartyState = { item_id: number | null; playing: boolean; position: number; at: number };

export type PartyMember = { id: string; name: string; username: string | null; avatar_url: string | null; guest: boolean };

export type PartyMessage = { id: number; member_id: string; name: string; body: string; created_at: number };

export type Party = {
  id: string;
  title: string;
  control: 'host' | 'everyone';
  locked: boolean;
  host: { username: string; display_name: string; member_id: string } | null;
  state: PartyState;
  queue: PlaylistItem[];
  messages: PartyMessage[];
  members: PartyMember[];
  reactions: string[];
  you: { member_id: string; name: string; guest: boolean; is_host: boolean; can_control: boolean } | null;
  now: number;
};

// ---- live streaming (OurTube 1.9) ----

export type LiveStream = {
  id: string;
  title: string;
  description: string;
  game: { id: string; name: string } | null;
  visibility: string;
  status: string; // live | ended
  started_at: number;
  ended_at: number | null;
  viewers: number;
  peak_viewers: number;
  hls_url: string | null; // relative on the stream's own server, absolute in /live/now
  url: string;
  video_id: string | null; // the recording, once the stream ended
  channel: { username: string; display_name: string; avatar_url: string | null };
  remote?: { peer_id: number; peer_name: string | null; peer_url: string }; // a stream on another server, in /live/now
};

export type LiveNow = { enabled: boolean; live: LiveStream[]; network: LiveStream[] };

export type LivePage = {
  enabled: boolean;
  live: boolean;
  stream: LiveStream | null;
  last: LiveStream | null;
  channel: { username: string; display_name: string; avatar_url: string | null };
  you: { id: string; name: string } | null;
  is_owner: boolean;
};

/** The network watch endpoint wraps the video with what this viewer can do. */
export type RemoteWatch = {
  video: Video & { remote: RemoteInfo };
  related: Video[];
  my_like: number;
  subscribed: boolean;
  interactions: { likes: boolean; comments: boolean; subscriptions: boolean };
};
