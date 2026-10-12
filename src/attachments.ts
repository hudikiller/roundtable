import type { Client } from "@larksuiteoapi/node-sdk";

export interface Attachment { type: "image" | "file"; key: string; name?: string }
export function attachmentDescriptors(type: string | undefined, content: string): Attachment[] {
  try {
    const body = JSON.parse(content);
    if (type === "image" && typeof body.image_key === "string")
      return [{ type: "image", key: body.image_key }];
    if (type === "file" && typeof body.file_key === "string")
      return [{ type: "file", key: body.file_key, name: body.file_name }];
    if (type !== "post") return [];
    const post = body.zh_cn ?? body.en_us ?? body;
    const resources: Attachment[] = [];
    for (const row of post.content ?? []) for (const item of row)
      if (item.tag === "img" && typeof item.image_key === "string") resources.push({ type: "image", key: item.image_key });
    for (const file of body.files ?? post.files ?? []) {
      const key = file.file_key ?? file.key;
      if (typeof key === "string" && !file.is_folder) resources.push({ type: "file", key, name: file.file_name ?? file.name });
    }
    return resources.slice(0, 4);
  } catch { return []; }
}

export async function readAttachment(client: Client, messageId: string, attachment: Attachment):
  Promise<{ text: string } | { image: string }> {
  const limit = attachment.type === "image" ? 2 * 1024 * 1024 : 64 * 1024;
  if (attachment.type === "file" && (!attachment.name ||
      !/\.(?:md|txt|csv|json|log|ts|js|py|html|css)$/i.test(attachment.name)))
    throw new Error("文件仅支持明确命名的 UTF-8 文本，不解压或执行附件");
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: attachment.key }, params: { type: attachment.type },
  });
  const stream = response.getReadableStream(), chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) { stream.destroy(); throw new Error(`附件超过 ${attachment.type === "image" ? "2 MiB" : "64 KiB"} 预算`); }
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error("附件为空");
  if (attachment.type === "file") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("二进制附件不能当作文本");
    return { text };
  }
  let mime: string;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 16_000_000) throw new Error("图片像素超过预算");
    mime = "image/png";
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) mime = "image/jpeg";
  else throw new Error("图片仅支持实际 PNG 或 JPEG，不读取 SVG 和外部图片链接");
  return { image: `data:${mime};base64,${bytes.toString("base64")}` };
}
