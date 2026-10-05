"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
// 凭据加密：node:crypto AES-256-GCM（doc §1 技术选型）。密钥放环境变量 APP_ENC_KEY（base64, 32字节）。
const node_crypto_1 = __importDefault(require("node:crypto"));
function getKey() {
    const b64 = process.env.APP_ENC_KEY;
    if (!b64)
        throw new Error('APP_ENC_KEY 未配置');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32)
        throw new Error('APP_ENC_KEY 必须为 32 字节 base64');
    return key;
}
function encrypt(plain) {
    const iv = node_crypto_1.default.randomBytes(12);
    const cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', getKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(cipher) {
    const [ivHex, tagHex, dataHex] = cipher.split(':');
    if (!ivHex || !tagHex || !dataHex)
        throw new Error('密文格式错误');
    const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
