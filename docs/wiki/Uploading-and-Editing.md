# Uploading and Editing

- [Uploading](#uploading)
- [Drafts: nothing goes out until you save](#drafts-nothing-goes-out-until-you-save)
- [How uploads are processed](#how-uploads-are-processed)
- [Video details](#video-details)
- [The timeline editor](#the-timeline-editor)
- [Captions](#captions)
- [Skippable parts](#skippable-parts)
- [Studio](#studio)

## Uploading

Open **Upload** (`/upload`) and drop in one or more files, or pick them. Each file gets its own card with a
progress bar, and you can fill in its details while it uploads:

- **Title**, **description** and **tags**
- **Visibility**: *public* (listed on the site and, if you allow it, in the network), *unlisted* (anyone with
  the link) or *private* (only you)
- **Game**, from the site's catalog (see [Clip Tools and Games](Clip-Tools-and-Games.md#games))
- **Let others clip this video**

Accepted formats: MP4, MKV, MOV, WebM, AVI, M4V, TS, WMV, FLV, MPG/MPEG, 3GP, MTS and M2TS. The size limit per
file is set by the admin (8 GB by default), and your account may have a storage quota.

### Big files and shaky connections

Files go up in pieces of 32 MB. That gets them through proxies that cap the size of a request (Cloudflare's
proxy and Cloudflare Tunnel allow 100 MB on the free plan), and a dropped connection only costs the piece in
flight: the card says *Connection lost, trying again* and carries on where it stopped. If it gives up, **Try
again** resumes it. Closed the tab halfway? Drop the same file in again within a day and it continues from where
it was. Channel archives for a [channel import](Fediverse.md#moving-a-channel) go up the same way.

For scripts and apps, the same works over the API (signed in, with the session cookie or a bearer token):

1. `POST /api/uploads` with `{"name": "clip.mp4", "size": <bytes>}` (and `"kind": "archive"` for a channel
   archive) answers `{"upload": {"id", "offset": 0, "chunk_size", ...}}`.
2. `PUT /api/uploads/<id>` with the next bytes as the body (`Content-Type: application/octet-stream`) and an
   `Upload-Offset: <byte>` header saying where they start. It answers the new `offset`. A piece may overlap what
   already arrived (those bytes are skipped); one that would leave a gap gets `409` with the right `offset`.
   `GET /api/uploads/<id>` says where an upload stands, `DELETE` gives it up.
3. Once `offset` equals the size, `POST /api/videos` with `{"upload_id": "<id>", "title": ...}` (the same fields
   as a normal upload) makes the video; for an archive, `POST /api/me/channel-imports` with `{"upload_id"}`.

Sending the whole file as `multipart/form-data` to `POST /api/videos` still works too, where no proxy is in the way.

## Drafts: nothing goes out until you save

An upload from the Upload page is a **draft** until you click **Save details**:

- only you can see it, even after it has finished processing;
- it isn't on Home, in search, in feeds, in the network or on the fediverse;
- subscribers aren't notified.

Details you type while the file uploads are kept, but the clip stays a draft. **Save details** publishes it
with the visibility you chose, and that is when subscribers get their notification. A draft shows a **Draft**
badge in Studio; its details page has a **Save and publish** button.

Uploads made through the API without the draft flag (scripts, for example) are published as soon as they are
processed.

## How uploads are processed

When a file arrives, OurTube reads it with FFprobe and decides:

- **Remux** (seconds, no quality loss) when the video is H.264 in yuv420p with AAC or MP3 audio, and no taller
  than the site's maximum resolution. That covers the default recordings of tools like NVIDIA ShadowPlay and OBS. The
  upload is copied into a web-friendly MP4 and the uploaded file is deleted, since nothing was lost.
- **Transcode** everything else (HEVC, AV1, VP9, ProRes, 10-bit, other audio codecs, or too tall) to H.264
  and AAC, scaled down to the maximum resolution if needed. The configured encoder is used (CPU, NVENC, Quick
  Sync or AMF); if a GPU encoder fails, that video is encoded on the CPU instead. The uploaded file is kept
  unless the admin turned on *Delete originals*.

The thumbnail, duration, resolution and frame rate are filled in automatically. After that, in the
background, the server builds the 720p copy for other platforms and the adaptive-streaming renditions, if
those are on.

## Video details

Studio → a video's pencil icon (`/studio/edit/<id>`) changes everything about a video after upload:

- title, description, tags, game and visibility;
- **thumbnail**: upload an image, or pick any frame in the timeline editor;
- **comments**: the site default, open, hold every comment for review, or off;
- **Let others clip this video** and **Let viewers download the original**;
- **Share with the network**: untick it to keep a public video on this server only;
- captions and skippable parts (below).

## The timeline editor

Open it from Studio (scissors icon), from a video's details page, or with the Editor button on your own watch
page.

- The timeline shows a filmstrip and the audio waveform. Click or drag on it to move the playhead.
- **S** splits the part under the playhead, **Del** removes the selected part, and dragging a part's yellow
  edges trims it (it snaps to the playhead). **I** and **O** set the selected part's start and end to the
  playhead.
- Removed sections are hatched; double-click one to bring it back.
- **Preview edit** plays the result live, skipping the cut sections. **Ctrl+Z** and **Ctrl+Shift+Z** undo and
  redo.
- Volume goes up to 300%, **mute** removes the audio track, and fades go to and from black.
- **Make a clip** cuts the selected range into a new video (see
  [Clip a moment](Clip-Tools-and-Games.md#clip-a-moment)).
- **Save** renders the edit in the background. The old version stays up until the new one is ready, and shared
  links keep working.

Edits are non-destructive: the first processed file is kept as the editing source, so **Revert to original**
works at any time. An edited video uses roughly twice its disk space.

## Captions

Upload WebVTT (`.vtt`) or SRT (`.srt`) files per language on the video's details page. Viewers can also submit
captions from the watch page's ⋯ menu; they appear once the uploader publishes them. Nothing is generated or
machine-translated.

## Skippable parts

Mark sponsor reads, intros, outros, recaps and self-promotion on the video's details page; viewers can suggest
them too. Each viewer decides in Settings → *Watching* whether to skip them automatically, see a Skip button,
or not skip at all.

## Studio

**Studio** (`/studio`) lists your videos with their status, visibility, views and drafts. From there:

- **Comments** (`/studio/comments`): comments held for review on your videos, to approve or remove.
- **Analytics** (`/studio/analytics`): views and watch time per day, where views came from, top videos, and a
  retention curve per video. See [Watching and Discovery](Watching-and-Discovery.md#analytics).
- **Moving to another site** (Settings): export your channel or move it, see
  [Fediverse](Fediverse.md#moving-a-channel).
