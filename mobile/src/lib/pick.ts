import * as DocumentPicker from 'expo-document-picker';
import type { UploadFile } from './api';

/**
 * Picks one file from the phone (an image for artwork, an avatar or a thumbnail; captions; a video). `types` are MIME
 * patterns such as 'image/*'. Null when cancelled.
 */
export async function pickFile(types: string | string[] = 'image/*'): Promise<UploadFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.name || 'file', type: a.mimeType || 'application/octet-stream', size: a.size ?? null, lastModified: a.lastModified ?? null };
}
