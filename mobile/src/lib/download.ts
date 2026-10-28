import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Api } from './api';

/**
 * Downloads a file the website offers as a link (a data export, a channel archive, a video), signed in when it is on
 * this server, then opens Android's share sheet to save it to Files or Drive or send it on.
 */
export async function downloadAndShare(api: Api, url: string, name: string, mimeType?: string): Promise<void> {
  const abs = api.abs(url)!;
  const dir = new Directory(Paths.cache, 'downloads');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const safe = name.replace(/[^\w.\- ]+/g, '_') || 'download';
  const file = await File.downloadFileAsync(abs, new File(dir, safe), { headers: api.authFor(abs) || {}, idempotent: true });
  if (!(await Sharing.isAvailableAsync())) throw new Error('This phone has nowhere to share the file to');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: name });
}
