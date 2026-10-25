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

When a file arrives, ClipTube reads it with FFprobe and decides:

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
