const DOWNLOAD_TIMEOUT_MS = 60_000;

export const DISCORD_ATTACHMENT_ORIGINS = new Set(['https://cdn.discordapp.com', 'https://media.discordapp.net']);

/** The body, or `undefined` as soon as it runs past `maxBytes`. */
export const readAtMost = async (body: ReadableStream<Uint8Array> | null, maxBytes: number) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (body) {
    const reader = body.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Resolves to `undefined` when the file is larger than `maxBytes`. */
export const downloadDiscordAttachment = async (
  attachment: { url: string; name: string; contentType: string | null },
  maxBytes: number,
) => {
  const url = new URL(attachment.url);
  if (!DISCORD_ATTACHMENT_ORIGINS.has(url.origin)) {
    throw new Error('Not a Discord attachment URL');
  }

  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Discord answered the attachment download with status ${response.status}`);
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }

  const bytes = await readAtMost(response.body, maxBytes);
  const type = attachment.contentType ?? response.headers.get('content-type') ?? '';
  return bytes && new File([bytes], attachment.name, { type });
};
