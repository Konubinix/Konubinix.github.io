import sha256 from 'https://esm.sh/fast-sha256@1.3.0';
export const hash = sha256.hash;
export const HMAC = sha256.HMAC;
export const Hash = sha256.Hash;
export default sha256;
