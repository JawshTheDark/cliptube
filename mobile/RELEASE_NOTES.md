ClipTube for Android 1.3.0: uploads that survive a bad connection.

**Install:** download the `.apk` below on your phone and open it. It installs over earlier versions and keeps your servers and sign-ins.

New, on servers running ClipTube 1.10 or newer:

- **Uploads go up in pieces.** If the connection drops, the app waits, checks how much arrived and carries on from there instead of starting over.
- **Closing the app doesn't lose an upload.** Choose the same file again and it picks up where it stopped (the server keeps an unfinished upload for a day).
- **Big videos work behind Cloudflare,** which refuses single requests over 100 MB on its free plan.
- **Uploads are much faster.** Sending raw pieces skips the slow path the old single-request upload went through.

Servers older than 1.10 still get the video in one request, as before.
