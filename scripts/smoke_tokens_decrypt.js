process.env.TOKENS_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { encryptToken, decryptToken } = await import("../src/security/tokens.js");

const original = "smoke-test-refresh-token";
const encrypted = encryptToken(original);

if (!encrypted || !encrypted.enc || !encrypted.iv || !encrypted.tag) {
  throw new Error("encryptToken did not return enc/iv/tag");
}

const decrypted = decryptToken(encrypted.enc, encrypted.iv, encrypted.tag);
if (decrypted !== original) {
  throw new Error("decryptToken positional call failed");
}

const row = {
  refresh_token_enc: encrypted.enc,
  refresh_token_iv: encrypted.iv,
  refresh_token_tag: encrypted.tag,
};

const rowDecrypted = decryptToken(
  row.refresh_token_enc,
  row.refresh_token_iv,
  row.refresh_token_tag
);

if (rowDecrypted !== original) {
  throw new Error("DB-shaped row positional decrypt failed");
}

console.log("smoke_tokens_decrypt passed");
