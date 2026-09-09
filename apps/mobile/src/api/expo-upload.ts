import { File, UploadType } from 'expo-file-system';

import type { FileUpload, UploadTransport } from './client';

/**
 * Moving a recording off the device, natively.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY NOT `fetch` WITH A `FormData`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is React Native's documented idiom and it fails in Expo Go, inside the
 * native networking module, with "Unsupported FormDataPart implementation" —
 * for a part that is demonstrably correct on the JavaScript side. See the
 * `UploadTransport` comment in `client.ts`.
 *
 * This asks the platform to do the whole upload instead. The file never passes
 * through JavaScript, which also means a long recording is not held in memory
 * as a string on a cheap phone.
 */
export const createExpoUploadTransport = (): UploadTransport => {
  return async (url: string, headers: Readonly<Record<string, string>>, file: FileUpload) => {
    const result = await new File(file.uri).upload(url, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: file.fieldName,
      mimeType: file.mimeType,
      // The server buffers every part before it validates any of them, so
      // these may arrive either side of the file.
      parameters: { ...file.fields },
      headers: { ...headers },
    });

    return { status: result.status, body: result.body };
  };
};
