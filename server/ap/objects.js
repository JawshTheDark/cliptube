/**
 * Local things as ActivityPub JSON: accounts (Person), channels (Group), the instance (Application),
 * videos in PeerTube's Video vocabulary (so PeerTube can play them; Mastodon gets an attachment),
 * comments as Notes, and the collections around them.
 */
import { db, getSettings } from '../db.js';
import { CONTEXT, PUBLIC, hostOf, isoDuration, textToHtml, urls, uuidFor } from './common.js';
import { instanceKeys, userKeys } from './keys.js';

const iso = (t) => new Date(Number(t) || Date.now()).toISOString();

const PT_CONTEXT = [
  ...CONTEXT,
  {
    pt: 'https://joinpeertube.org/ns#',
    sc: 'http://schema.org/',
    Hashtag: 'as:Hashtag',
    uuid: 'sc:identifier',
    category: 'sc:category',
    licence: 'sc:license',
    subtitleLanguage: 'sc:subtitleLanguage',
    sensitive: 'as:sensitive',
    language: 'sc:inLanguage',
    views: { '@type': 'sc:Number', '@id': 'pt:views' },
    state: { '@type': 'sc:Number', '@id': 'pt:state' },
    size: { '@type': 'sc:Number', '@id': 'pt:size' },
    fps: { '@type': 'sc:Number', '@id': 'pt:fps' },
    commentsEnabled: { '@type': 'sc:Boolean', '@id': 'pt:commentsEnabled' },
    canReply: 'pt:canReply',
    commentsPolicy: { '@type': 'sc:Number', '@id': 'pt:commentsPolicy' },
    downloadEnabled: { '@type': 'sc:Boolean', '@id': 'pt:downloadEnabled' },
    waitTranscoding: { '@type': 'sc:Boolean', '@id': 'pt:waitTranscoding' },
    support: { '@type': 'sc:Text', '@id': 'pt:support' },
    isLiveBroadcast: { '@type': 'sc:Boolean', '@id': 'pt:isLiveBroadcast' },
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    discoverable: 'toot:discoverable',
    toot: 'http://joinmastodon.org/ns#',
    alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
    movedTo: { '@id': 'as:movedTo', '@type': '@id' },
    schema: 'http://schema.org#',
    PropertyValue: 'schema:PropertyValue',
    value: 'schema:value',
    // The one extension: the game a video is from (see docs/federation.md). The namespace keeps the repository's
    // old name on purpose: it identifies the terms between servers, so it must not change between versions.
    cliptube: 'https://github.com/JawshTheDark/cliptube/blob/main/docs/federation.md#',
    game: 'cliptube:game',
    counts: 'cliptube:counts',
  },
];

/** Old accounts (from "Moving here") and linked accounts (see links.js), each with its channel. */
const aliasList = (u) => {
  let list = [];
  try {
    const v = JSON.parse(u.also_known_as || '[]');
    if (Array.isArray(v)) list = v.filter((x) => typeof x === 'string');
  } catch {}
  if (u.id) {
    for (const l of db.prepare('SELECT actor_id, group_id FROM account_links WHERE user_id = ? ORDER BY created_at').all(u.id)) {
      list.push(l.actor_id, ...(l.group_id ? [l.group_id] : []));
    }
  }
  list = [...new Set(list)];
  return list.length ? list : undefined;
};

/** Support links as profile fields, which Mastodon shows on the profile. */
function profileFields(json) {
  try {
    const list = JSON.parse(json || '[]');
    if (!Array.isArray(list) || !list.length) return undefined;
    return list.slice(0, 4).map((l) => ({
      type: 'PropertyValue',
      name: String(l.label || 'Link').slice(0, 255),
      value: `<a href="${escapeAttr(l.url)}" target="_blank" rel="nofollow noopener noreferrer me">${escapeAttr(String(l.url).replace(/^https?:\/\//, ''))}</a>`,
    }));
  } catch {
    return undefined;
  }
}
const escapeAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function supportText(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) && list.length ? list.map((l) => `${l.label}: ${l.url}`).join('\n') : null;
  } catch {
    return null;
  }
}

function actorCommon(base, id, u) {
  return {
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    featured: `${id}/featured`, // pinned posts (none yet); Mastodon and GoToSocial look for it
    endpoints: { sharedInbox: urls(base).sharedInbox() },
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: userKeys(u.id).publicKey },
    icon: u.avatar ? { type: 'Image', mediaType: 'image/jpeg', url: `${base}/media/avatars/${u.avatar}` } : undefined,
    image: u.banner ? { type: 'Image', mediaType: 'image/jpeg', url: `${base}/media/avatars/${u.banner}` } : undefined,
    alsoKnownAs: aliasList(u),
    published: iso(u.created_at),
    manuallyApprovesFollowers: false,
    discoverable: true,
  };
}

export function personJson(u, base) {
  const id = urls(base).person(u.username);
  return {
    '@context': PT_CONTEXT,
    type: 'Person',
    id,
    preferredUsername: u.username,
    name: u.display_name,
    summary: u.bio ? textToHtml(u.bio) : '',
    url: `${base}/c/${u.username}`,
    attachment: profileFields(u.support_links),
    movedTo: u.moved_to || undefined,
    ...actorCommon(base, id, u),
  };
}

export function groupJson(u, base) {
  const id = urls(base).group(u.username);
  return {
    '@context': PT_CONTEXT,
    type: 'Group',
    id,
    preferredUsername: `${u.username}_channel`,
    name: u.display_name,
    summary: u.bio ? textToHtml(u.bio) : '',
    url: `${base}/c/${u.username}`,
    support: supportText(u.support_links),
    attributedTo: [{ type: 'Person', id: urls(base).person(u.username) }],
    movedTo: u.moved_to ? u.moved_to_group || u.moved_to : undefined,
    ...actorCommon(base, id, u),
  };
}

export function instanceJson(base) {
  const id = urls(base).instance();
  const s = getSettings();
  return {
    '@context': PT_CONTEXT,
    type: 'Application',
    id,
    preferredUsername: hostOf(base),
    name: s.site_name,
    summary: s.instance_description || '',
    url: `${base}/`,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    endpoints: { sharedInbox: urls(base).sharedInbox() },
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: instanceKeys().publicKey },
    manuallyApprovesFollowers: false,
  };
}

const VIDEO_SELECT = `SELECT v.*, u.username, u.display_name, u.support_links,
  (SELECT group_concat(tag, ',') FROM tags t WHERE t.video_id = v.id) AS tag_list,
  (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
  (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = -1) AS dislike_count,
  (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id AND c.status = 'visible') AS comment_count
  FROM videos v JOIN users u ON u.id = v.user_id`;

/** Whether a local video is out in the fediverse: public, ready, shared with the network, not moderated. */
export const VIDEO_FEDERATED = "v.status = 'ready' AND v.visibility = 'public' AND v.federate = 1 AND v.moderation_status IS NULL";

export function loadVideoForAp(id) {
  return db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(id);
}

/**
 * A video in PeerTube's vocabulary. PeerTube needs both the account and the channel in attributedTo;
 * GoToSocial only takes one, so it gets the account (`singleAuthor`).
 */
export function videoJson(v, base, { singleAuthor = false } = {}) {
  const u = urls(base);
  const id = u.video(v.id);
  const fileUrl = `${base}/media/videos/${v.id}.mp4${v.edit_version ? `?v=${v.edit_version}` : ''}`;
  const fps = Math.round(v.fps || 30);
  const links = [
    { type: 'Link', mediaType: 'text/html', href: `${base}/watch/${v.id}` },
    { type: 'Link', mediaType: 'video/mp4', href: fileUrl, height: v.height || 0, width: v.width || 0, size: v.size_bytes || 0, fps },
  ];
  const fed = db.prepare("SELECT * FROM renditions WHERE video_id = ? AND kind = 'federation' AND edit_version = ?").get(v.id, v.edit_version || 0);
  if (fed) links.push({ type: 'Link', mediaType: 'video/mp4', href: `${base}/media/renditions/${fed.path}`, height: fed.height, size: fed.size_bytes, fps: Math.min(fps, 60) });
  const thumb = v.thumb_path ? `${base}/media/thumbs/${v.thumb_path}` : null;
  const tags = String(v.tag_list || '').split(',').filter((t) => t.length >= 2 && t.length <= 30);
  const game = v.game_id ? db.prepare('SELECT id, name FROM games WHERE id = ?').get(v.game_id) : null;
  // The game also travels as a hashtag, for servers that don't know the extension.
  if (game && !tags.includes(game.id) && game.id.length <= 30) tags.push(game.id);
  const captions = db.prepare("SELECT id, lang, label FROM captions WHERE video_id = ? AND status = 'published'").all(v.id);
  const commentsPolicy = v.comment_mode === 'off' ? 2 : v.comment_mode === 'hold_all' ? 3 : 1;
  // Mastodon shows the first video attachment it can fetch; give it the smaller copy when there is one.
  const small = fed ? `${base}/media/renditions/${fed.path}` : fileUrl;
  return {
    '@context': PT_CONTEXT,
    type: 'Video',
    id,
    uuid: uuidFor(v.id),
    name: v.title,
    duration: isoDuration(v.duration),
    views: v.views || 0,
    sensitive: false,
    waitTranscoding: false,
    state: 1,
    commentsEnabled: commentsPolicy !== 2,
    commentsPolicy,
    canReply: null,
    downloadEnabled: true,
    isLiveBroadcast: false,
    published: iso(v.published_at || v.created_at),
    updated: iso(v.updated_at || v.created_at),
    originallyPublishedAt: null,
    category: v.game_id ? { identifier: '7', name: 'Gaming' } : null,
    game: game ? { slug: game.id, name: game.name, url: `${base}/g/${game.id}` } : undefined,
    licence: null,
    language: null,
    mediaType: 'text/markdown',
    content: v.description || '',
    summary: null,
    support: supportText(v.support_links),
    tag: tags.map((name) => ({ type: 'Hashtag', name })),
    subtitleLanguage: captions.map((c) => ({ identifier: c.lang, name: c.label, url: `${base}/media/captions/${c.id}.vtt` })),
    icon: thumb ? [{ type: 'Image', url: thumb, mediaType: 'image/jpeg', width: 1280, height: Math.round((1280 * (v.height || 720)) / (v.width || 1280)) }] : [],
    url: links,
    // Mastodon: the playable file, its poster frame (icon) and alt text (name).
    attachment: [
      {
        type: 'Document',
        mediaType: 'video/mp4',
        url: small,
        name: v.title,
        width: fed?.height ? Math.round((fed.height * (v.width || 16)) / (v.height || 9)) : v.width || undefined,
        height: fed?.height || v.height || undefined,
        ...(thumb ? { icon: { type: 'Image', mediaType: 'image/jpeg', url: thumb } } : {}),
      },
    ],
    aspectRatio: v.width && v.height ? Math.round((v.width / v.height) * 10000) / 10000 : null,
    likes: `${id}/likes`,
    dislikes: `${id}/dislikes`,
    shares: `${id}/shares`,
    comments: `${id}/comments`,
    // Current counts, so other OurTube instances can show them without crawling the collections.
    counts: { likes: v.like_count || 0, dislikes: v.dislike_count || 0, comments: v.comment_count || 0, shares: v.ap_shares || 0 },
    attributedTo: singleAuthor
      ? u.person(v.username)
      : [
          { type: 'Person', id: u.person(v.username) },
          { type: 'Group', id: u.group(v.username) },
        ],
    to: [PUBLIC, `${u.group(v.username)}/followers`],
    cc: [`${u.person(v.username)}/followers`],
  };
}

/** The AP id of a comment: its own id when it came from the fediverse, ours otherwise. */
export const commentApId = (c, base) => c.ap_id || urls(base).comment(c.id);

export function noteJson(c, base) {
  const u = urls(base);
  const author = db.prepare('SELECT username FROM users WHERE id = ?').get(c.user_id);
  const video = db.prepare('SELECT v.id, u.username FROM videos v JOIN users u ON u.id = v.user_id WHERE v.id = ?').get(c.video_id);
  let inReplyTo = u.video(c.video_id);
  if (c.parent_id) {
    const p = db.prepare('SELECT * FROM comments WHERE id = ?').get(c.parent_id);
    if (p) inReplyTo = commentApId(p, base);
  }
  return {
    '@context': CONTEXT,
    type: 'Note',
    id: u.comment(c.id),
    attributedTo: u.person(author.username),
    inReplyTo,
    content: textToHtml(c.body),
    mediaType: 'text/html',
    published: iso(c.created_at),
    url: `${base}/watch/${c.video_id}#c-${c.id}`,
    to: [PUBLIC],
    cc: video ? [`${u.group(video.username)}/followers`, u.person(video.username)] : [],
  };
}

export const collection = (id, totalItems, extra = {}) => ({ '@context': CONTEXT, id, type: 'OrderedCollection', totalItems, ...extra });
