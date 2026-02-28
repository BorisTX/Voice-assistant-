import crypto from "crypto";

function getKey() {
  const hex = process.env.TOKENS_ENC_KEY;
  if (!hex) throw new Error("TOKENS_ENC_KEY missing");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("TOKENS_ENC_KEY must be 64 hex chars");
  return Buffer.from(hex, "hex"); // 32 bytes
}

export function encryptToken(plaintext) {
  if (!plaintext) return null;

  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM 12 bytes recommended
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    enc: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptToken(enc, iv, tag) {
  if (!enc || !iv || !tag) return null;

  const key = getKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(enc, "base64")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
